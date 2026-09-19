import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';
import type { AgentBackend, AgentMessageHandler, AgentMessage, StartSessionResult, SessionId } from '@/agent';
import type { ZcodeTurnResult } from './types';
import { mapPermissionModeToZcode, ZCODE_DEFAULT_COMMAND, type ZcodePermissionMode } from './constants';

export interface ZcodeBackendOptions {
    /** Working directory zcode runs in */
    cwd: string;
    /** Command used to launch the zcode CLI (default: 'zcode' or ZCODE_COMMAND env) */
    command?: string;
    /** Initial permission mode; can be changed between prompts via setMode */
    mode?: ZcodePermissionMode;
    /** Extra environment variables for the zcode process */
    env?: Record<string, string>;
}

/**
 * AgentBackend that drives the zcode CLI headless mode (`zcode --print`).
 *
 * Each Happy user message becomes one `zcode -p <message> --resume <sessionId>`
 * invocation. The first turn uses `--json` so the persisted zcode session id can
 * be captured for later turns; following turns run in plain mode, whose stdout
 * streams the assistant text as it is generated.
 */
export class ZcodeBackend implements AgentBackend {
    private handlers = new Set<AgentMessageHandler>();
    private child: ChildProcessWithoutNullStreams | null = null;
    private currentTurn: {
        resolve: () => void;
        reject: (error: Error) => void;
        aborted: boolean;
    } | null = null;

    private zcodeSessionId: string | null = null;
    private mode: ZcodePermissionMode;
    private disposed = false;

    constructor(private readonly options: ZcodeBackendOptions) {
        this.mode = options.mode ?? 'yolo';
    }

    private get command(): string {
        return this.options.command || process.env.ZCODE_COMMAND || ZCODE_DEFAULT_COMMAND;
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
            const child = spawn(this.command, ['version'], { cwd: this.options.cwd, env: this.spawnEnv() });
            child.on('error', (error) => reject(new Error(
                `Failed to launch "${this.command}". Is the zcode CLI installed and on PATH? (${error.message})`
            )));
            child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`"${this.command} version" exited with code ${code}`)));
        });
        return { sessionId: 'zcode-headless' };
    }

    private spawnEnv(): NodeJS.ProcessEnv {
        return { ...process.env, ...this.options.env };
    }

    /**
     * Run one zcode turn for the given user prompt.
     * Resolves when the zcode process exits for this turn.
     */
    async sendPrompt(_sessionId: SessionId, prompt: string): Promise<void> {
        if (this.disposed) {
            throw new Error('Zcode backend is disposed');
        }
        if (this.currentTurn) {
            throw new Error('A zcode turn is already in progress');
        }

        const args: string[] = ['-p', prompt, '--mode', this.mode];
        if (this.zcodeSessionId) {
            // Plain mode: stdout streams assistant text as it is generated
            args.push('--resume', this.zcodeSessionId);
        } else {
            // First turn: capture the persisted session id from the JSON result
            args.push('--json');
        }

        logger.debug(`[zcode] Spawning: ${this.command} ${this.describeArgs(args)}`);

        await new Promise<void>((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            let sawOutput = false;

            const child = spawn(this.command, args, {
                cwd: this.options.cwd,
                env: this.spawnEnv(),
                stdio: ['ignore', 'pipe', 'pipe'],
            }) as unknown as ChildProcessWithoutNullStreams;
            this.child = child;

            const turn = {
                resolve,
                reject,
                aborted: false,
            };
            this.currentTurn = turn;

            const finishTurn = () => {
                this.child = null;
                this.currentTurn = null;
            };

            child.on('error', (error) => {
                finishTurn();
                reject(new Error(
                    `Failed to launch "${this.command}". Is the zcode CLI installed and on PATH? (${error.message})`
                ));
            });

            child.stdout.on('data', (chunk: Buffer) => {
                const text = chunk.toString('utf8');
                stdout += text;

                if (this.zcodeSessionId) {
                    // Plain mode streams response text; forward deltas to Happy
                    if (text.length > 0) {
                        sawOutput = true;
                        this.emit({ type: 'model-output', textDelta: text });
                    }
                }
            });

            child.stderr.on('data', (chunk: Buffer) => {
                stderr += chunk.toString('utf8');
                if (stderr.length > 64 * 1024) {
                    stderr = stderr.slice(-32 * 1024);
                }
            });

            child.on('close', (code) => {
                const wasAborted = turn.aborted;
                finishTurn();

                if (this.zcodeSessionId === null) {
                    // First turn: parse the JSON result to capture the session id
                    const result = this.parseJsonResult(stdout);
                    if (result) {
                        this.zcodeSessionId = result.sessionId;
                        if (result.response) {
                            this.emit({ type: 'model-output', fullText: result.response });
                        }
                        this.emit({ type: 'token-count', tokens: result.usage?.totalTokens, raw: result.usage });
                    } else if (code === 0 && !wasAborted) {
                        logger.debug('[zcode] First turn produced no JSON result', { stdoutTail: stdout.slice(-2000) });
                    }
                }

                if (wasAborted) {
                    // Turn cancelled from the app; backend.cancel already reported it
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
        return args.map((arg, index) => index === 1 ? `"${preview}"` : arg).join(' ');
    }

    private parseJsonResult(stdout: string): ZcodeTurnResult | null {
        const start = stdout.indexOf('{');
        if (start < 0) return null;
        try {
            const parsed = JSON.parse(stdout.slice(start));
            if (parsed && typeof parsed === 'object' && typeof parsed.sessionId === 'string') {
                return parsed as ZcodeTurnResult;
            }
            return null;
        } catch {
            return null;
        }
    }

    private describeError(code: number | null, stderr: string, stdoutTail?: string): string {
        const cause = stderr.trim().split('\n')
            .filter((line) => line.trim().length > 0)
            .map((line) => line.replace(/^Error:\s*/, ''))
            .filter((line) => !line.startsWith('    at '))
            .pop()
            || stderr.trim()
            || stdoutTail?.trim()
            || 'no output';
        return `zcode turn failed (exit code ${code ?? 'signal'}): ${cause.slice(0, 500)}`;
    }

    /**
     * Apply a new permission mode for subsequent turns.
     */
    setMode(mode: ZcodePermissionMode): void {
        this.mode = mode;
    }

    /**
     * Drop the current zcode session so the next prompt starts fresh.
     */
    resetSession(): void {
        if (this.currentTurn) {
            throw new Error('Cannot reset the session while a turn is in progress');
        }
        this.zcodeSessionId = null;
    }

    /** The persisted zcode session id captured from the first turn, if any. */
    get currentZcodeSessionId(): string | null {
        return this.zcodeSessionId;
    }

    /**
     * Reuse a zcode session id from a previous bridge run so conversation
     * context survives bridge restarts.
     */
    restoreSession(id: string): void {
        if (this.currentTurn) {
            throw new Error('Cannot restore a session while a turn is in progress');
        }
        this.zcodeSessionId = id;
    }

    async cancel(_sessionId: SessionId): Promise<void> {
        const turn = this.currentTurn;
        const child = this.child;
        if (!turn || !child || child.exitCode !== null) {
            return;
        }
        turn.aborted = true;
        this.emit({ type: 'status', status: 'idle', detail: 'Turn cancelled' });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                if (child.exitCode === null) child.kill('SIGKILL');
                resolve();
            }, 2000);
            child.once('close', () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        await this.cancel('zcode-headless');
        this.handlers.clear();
    }
}

/** Message id helper shared by the run loop. */
export function zcodeMessageId(): string {
    return randomUUID();
}
