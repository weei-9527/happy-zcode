/**
 * ZcodeBackend - Agent backend for the ZCode CLI (GLM agent runtime)
 *
 * ZCode has no persistent app-server session in the way Claude/Codex do;
 * instead every turn is a fresh headless invocation:
 *
 *   first turn:  zcode -p "<prompt>" --mode <mode> --json
 *   later turns: zcode -p "<prompt>" --mode <mode> --resume <sessionId>
 *
 * The first turn prints a JSON result ({ sessionId, response, usage }) which
 * we capture; subsequent turns stream plain text on stdout, which we forward
 * as model-output deltas. The zcode session id is stable across turns, so
 * conversation context survives as long as the bridge keeps resuming it.
 *
 * Ported from the zcode-patched happy-coder 0.14.0 build that ran on this
 * NAS (dist/runZcode-*.mjs), adapted to the 1.x AgentBackend interface.
 */

import { spawn } from 'node:child_process';
import type {
  AgentBackend,
  AgentMessage,
  AgentMessageHandler,
  StartSessionResult,
} from '@/agent/core';
import { logger } from '@/ui/logger';

export const ZCODE_DEFAULT_COMMAND = 'zcode';

/** Map a Happy PermissionMode to a zcode --mode value. */
export function mapPermissionModeToZcode(mode: string | undefined): string {
  switch (mode) {
    case 'read-only':
    case 'safe-yolo':
    case 'plan':
      return 'edit';
    case 'auto':
    case 'acceptEdits':
      return 'build';
    case 'yolo':
    case 'bypassPermissions':
      return 'yolo';
    default:
      return 'yolo';
  }
}

export interface ZcodeBackendOptions {
  cwd: string;
  /** zcode command to invoke; defaults to $ZCODE_COMMAND then "zcode". */
  command?: string;
  /** Initial zcode permission mode; defaults to yolo (matches phone bridge). */
  mode?: string;
  log?: (msg: string) => void;
}

interface CurrentTurn {
  resolve: () => void;
  reject: (err: Error) => void;
  aborted: boolean;
}

export class ZcodeBackend implements AgentBackend {
  private readonly options: ZcodeBackendOptions;
  private mode: string;
  private readonly handlers = new Set<AgentMessageHandler>();
  private child: ReturnType<typeof spawn> | null = null;
  private currentTurn: CurrentTurn | null = null;
  private zcodeSessionId: string | null = null;
  private disposed = false;

  constructor(options: ZcodeBackendOptions) {
    this.options = options;
    this.mode = options.mode ?? 'yolo';
  }

  private get command(): string {
    return this.options.command || process.env.ZCODE_COMMAND || ZCODE_DEFAULT_COMMAND;
  }

  get currentZcodeSessionId(): string | null {
    return this.zcodeSessionId;
  }

  onMessage(handler: AgentMessageHandler): void {
    this.handlers.add(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    this.handlers.delete(handler);
  }

  private emit(msg: AgentMessage): void {
    for (const handler of this.handlers) {
      try {
        handler(msg);
      } catch (error) {
        logger.debug('[zcode] Message handler error:', error);
      }
    }
  }

  /**
   * Validate that the zcode CLI is reachable. Does not start a persistent
   * process - sessions are per-turn invocations.
   */
  async startSession(_initialPrompt?: string): Promise<StartSessionResult> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.command, ['version'], {
        cwd: this.options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.on('error', (error) =>
        reject(
          new Error(
            `Failed to launch "${this.command}". Is the zcode CLI installed and on PATH? (${error.message})`,
          ),
        ),
      );
      child.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`"${this.command} version" exited with code ${code}`)),
      );
    });
    return { sessionId: 'zcode-headless' };
  }

  async sendPrompt(_sessionId: string, prompt: string): Promise<void> {
    if (this.disposed) {
      throw new Error('ZcodeBackend is disposed');
    }
    const args = ['-p', prompt, '--mode', this.mode];
    if (this.zcodeSessionId) {
      args.push('--resume', this.zcodeSessionId);
    } else {
      args.push('--json');
    }
    this.options.log?.(`Spawning: ${this.command} ${this.describeArgs(args)}`);

    await new Promise<void>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const child = spawn(this.command, args, {
        cwd: this.options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;
      const turn: CurrentTurn = { resolve, reject, aborted: false };
      this.currentTurn = turn;

      const finishTurn = () => {
        this.child = null;
        this.currentTurn = null;
      };

      child.on('error', (error) => {
        finishTurn();
        reject(
          new Error(
            `Failed to launch "${this.command}". Is the zcode CLI installed and on PATH? (${error.message})`,
          ),
        );
      });

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stdout += text;
        if (this.zcodeSessionId && text.length > 0) {
          this.emit({ type: 'model-output', textDelta: text });
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > 64 * 1024) {
          stderr = stderr.slice(-32 * 1024);
        }
      });

      child.on('close', (code) => {
        const wasAborted = turn.aborted;
        finishTurn();

        if (this.zcodeSessionId === null) {
          const result = this.parseJsonResult(stdout);
          if (result) {
            this.zcodeSessionId = result.sessionId;
            if (result.response) {
              this.emit({ type: 'model-output', fullText: result.response });
            }
            this.emit({
              type: 'token-count',
              tokens: result.usage?.totalTokens,
              raw: result.usage,
            });
          } else if (code === 0 && !wasAborted) {
            logger.debug('[zcode] First turn produced no JSON result', {
              stdoutTail: stdout.slice(-2000),
            });
          }
        }

        if (wasAborted) {
          resolve();
          return;
        }
        if (code !== 0) {
          reject(new Error(this.describeError(code, stderr)));
          return;
        }
        if (this.zcodeSessionId === null) {
          reject(new Error(this.describeError(code, stderr, stdout.slice(-1000))));
          return;
        }
        resolve();
      });
    });
  }

  private describeArgs(args: string[]): string {
    const first = args[1] ?? '';
    const preview = first.length > 60 ? `${first.slice(0, 60)}...` : first;
    return args.map((arg, index) => (index === 1 ? `"${preview}"` : arg)).join(' ');
  }

  private parseJsonResult(stdout: string): { sessionId: string; response?: string; usage?: Record<string, unknown> } | null {
    const start = stdout.indexOf('{');
    if (start < 0) return null;
    try {
      const parsed = JSON.parse(stdout.slice(start));
      if (parsed && typeof parsed === 'object' && typeof parsed.sessionId === 'string') {
        return parsed as { sessionId: string; response?: string; usage?: Record<string, unknown> };
      }
      return null;
    } catch {
      return null;
    }
  }

  private describeError(code: number | null, stderr: string, stdoutTail?: string): string {
    const cause =
      stderr
        .trim()
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => line.replace(/^Error:\s*/, ''))
        .filter((line) => !line.startsWith('    at '))
        .pop() ||
      stderr.trim() ||
      stdoutTail?.trim() ||
      'no output';
    return `zcode turn failed (exit code ${code ?? 'signal'}): ${cause.slice(0, 500)}`;
  }

  /** Apply a new permission mode for subsequent turns. */
  setMode(mode: string): void {
    this.mode = mode;
  }

  /** Drop the current zcode session so the next prompt starts fresh. */
  resetSession(): void {
    if (this.currentTurn) {
      throw new Error('Cannot reset the session while a turn is in progress');
    }
    this.zcodeSessionId = null;
  }

  /** Reuse a zcode session id from a previous bridge run. */
  restoreSession(id: string): void {
    if (this.currentTurn) {
      throw new Error('Cannot restore a session while a turn is in progress');
    }
    this.zcodeSessionId = id;
  }

  async cancel(_sessionId: string): Promise<void> {
    const turn = this.currentTurn;
    const child = this.child;
    if (!turn || !child || child.exitCode !== null) {
      return;
    }
    turn.aborted = true;
    this.emit({ type: 'status', status: 'idle', detail: 'Turn cancelled' });
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }, 3000);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.cancel('zcode-headless');
  }
}
