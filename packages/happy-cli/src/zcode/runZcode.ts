/**
 * Zcode Session Runner
 *
 * Entry point for zcode agent sessions, following the runOpenClaw.ts pattern.
 * The daemon spawns this as: `node dist/index.mjs zcode --happy-starting-mode remote --started-by daemon`
 *
 * zcode is invoked headlessly once per turn (`zcode -p "<prompt>" --mode <mode> --resume <id>`),
 * so this runner mostly shuttles messages between the Happy session pipeline
 * and a ZcodeBackend child process. The zcode session id is persisted to
 * ~/.happy/zcode-bridge-state.json so conversation context survives bridge
 * restarts.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import { AcpSessionManager } from '@/agent/acp/AcpSessionManager';
import type { SessionEnvelope } from '@slopus/happy-wire';
import { logger } from '@/ui/logger';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { encodeBase64 } from '@/api/encryption';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { connectionState } from '@/utils/serverConnectionErrors';
import { ZcodeBackend, mapPermissionModeToZcode } from './ZcodeBackend';
import type { AgentMessage } from '@/agent/core';

export { ZcodeBackend, mapPermissionModeToZcode };

const TURN_TIMEOUT_MS = 30 * 60 * 1000;

/** Queue mode carried alongside each batched user message. */
interface ZcodeQueueMode {
  permissionMode?: string;
}

/** Persisted bridge state so the zcode session id survives bridge restarts. */
interface ZcodeBridgeState {
  zcodeSessionId?: string;
}

function bridgeStatePath(): string {
  return process.env.ZCODE_BRIDGE_STATE_PATH ?? join(os.homedir(), '.happy', 'zcode-bridge-state.json');
}

function loadBridgeState(): ZcodeBridgeState {
  try {
    const raw = JSON.parse(readFileSync(bridgeStatePath(), 'utf-8'));
    return typeof raw === 'object' && raw !== null ? raw : {};
  } catch {
    return {};
  }
}

function saveBridgeState(state: ZcodeBridgeState): void {
  try {
    writeFileSync(bridgeStatePath(), JSON.stringify(state, null, 2));
  } catch (error) {
    logger.debug('[zcode] Failed to save bridge state:', error);
  }
}

export interface RunZcodeOptions {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
  /** zcode command override; defaults to $ZCODE_COMMAND then "zcode". */
  command?: string;
  /** Initial permission mode. */
  permissionMode?: string;
  /** Resume a specific zcode session id instead of the persisted one. */
  resumeZcodeSessionId?: string;
  verbose?: boolean;
}

export async function runZcode(opts: RunZcodeOptions): Promise<void> {
  const verbose = opts.verbose === true;
  const sessionTag = randomUUID();
  connectionState.setBackend('zcode');

  const log = (msg: string) => {
    logger.debug(`[zcode] ${msg}`);
    if (verbose) {
      console.log(`[zcode] ${msg}`);
    }
  };

  const api = await ApiClient.create(opts.credentials);
  const settings = await readSettings();
  if (!settings?.machineId) {
    throw new Error('No machine ID found in settings');
  }

  await api.getOrCreateMachine({
    machineId: settings.machineId,
    metadata: initialMachineMetadata,
  });

  const { state, metadata } = createSessionMetadata({
    flavor: 'zcode',
    machineId: settings.machineId,
    startedBy: opts.startedBy,
  });
  const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
  if (response) {
    log(`Happy Session ID: ${response.id}`);
  }

  let session: ApiSessionClient;
  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    onSessionSwap: (newSession) => {
      session = newSession;
    },
  });
  session = initialSession;

  if (response) {
    try {
      await notifyDaemonSessionStarted(response.id, metadata, {
        encryptionKey: encodeBase64(response.encryptionKey),
        encryptionVariant: response.encryptionVariant,
        seq: response.seq,
        metadataVersion: response.metadataVersion,
        agentStateVersion: response.agentStateVersion,
      });
    } catch (error) {
      logger.debug('[zcode] Failed to report session to daemon:', error);
    }
  }

  const sessionManager = new AcpSessionManager();
  const messageQueue = new MessageQueue2<ZcodeQueueMode>(() => '');
  let shouldExit = false;
  let abortController = new AbortController();
  let thinking = false;
  let inTurn = false;
  let currentPermissionMode = opts.permissionMode;

  const backend = new ZcodeBackend({
    cwd: process.cwd(),
    command: opts.command,
    mode: mapPermissionModeToZcode(opts.permissionMode),
    log,
  });

  // Reattach to a previous zcode session so context survives restarts.
  const bridgeState = loadBridgeState();
  const resumeId = opts.resumeZcodeSessionId ?? bridgeState.zcodeSessionId;
  if (resumeId) {
    backend.restoreSession(resumeId);
    log(`Resuming zcode session ${resumeId}`);
  }

  const clearPendingTurn = () => {
    pendingTurn = null;
  };

  let pendingTurn: { resolve: () => void } | null = null;
  const waitForTurnEnd = () =>
    new Promise<void>((resolve) => {
      pendingTurn = { resolve };
      setTimeout(() => {
        if (pendingTurn?.resolve === resolve) {
          pendingTurn = null;
          resolve();
        }
      }, TURN_TIMEOUT_MS);
    });

  const sendEnvelopes = (envelopes: SessionEnvelope[]) => {
    for (const envelope of envelopes) {
      session.sendSessionProtocolMessage(envelope);
    }
  };

  const onBackendMessage = (msg: AgentMessage) => {
    if (verbose) {
      log(`Backend message: ${JSON.stringify(msg).slice(0, 200)}`);
    }

    if (msg.type === 'status' && inTurn) {
      const nextThinking = msg.status === 'running';
      if (thinking !== nextThinking) {
        thinking = nextThinking;
        session.keepAlive(thinking, 'remote');
      }
      if (msg.status === 'idle') {
        clearPendingTurn();
      }
    }
    if (msg.type === 'status' && (msg.status === 'error' || msg.status === 'stopped')) {
      log(`Backend ${msg.status}: ${msg.detail ?? ''}`);
    }

    const envelopes = sessionManager.mapMessage(msg);
    sendEnvelopes(envelopes);
    if (msg.type === 'status' && msg.status === 'error' && envelopes.length === 0) {
      session.sendSessionEvent({
        type: 'message',
        message: `zcode error: ${msg.detail?.trim() || 'The agent stopped because of an unknown error.'}`,
      });
    }
  };

  backend.onMessage(onBackendMessage);

  session.onUserMessage((message) => {
    if (!message.content.text) return;
    if (typeof message.meta?.permissionMode === 'string') {
      currentPermissionMode = message.meta.permissionMode;
      logger.debug(`[zcode] Requested permission mode: ${currentPermissionMode}`);
    }
    messageQueue.push(message.content.text, {
      permissionMode: currentPermissionMode,
    });
  });
  session.keepAlive(thinking, 'remote');

  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, 'remote');
  }, 2000);

  async function handleAbort() {
    log('Abort requested');
    try {
      await backend.cancel('zcode-headless');
    } catch (error) {
      logger.debug('[zcode] Abort failed:', error);
    }
    inTurn = false;
    thinking = false;
    session.keepAlive(false, 'remote');
    clearPendingTurn();
    abortController.abort();
    abortController = new AbortController();
  }

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  registerKillSessionHandler(session.rpcHandlerManager, async () => {
    shouldExit = true;
    messageQueue.close();
    await handleAbort();
  });

  console.log('Happy Zcode bridge active');
  log(`Agent command: ${process.env.ZCODE_COMMAND ?? 'zcode'}`);

  try {
    await backend.startSession();
    log('zcode CLI reachable');

    while (!shouldExit) {
      const waitSignal = abortController.signal;
      const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
      if (!batch) {
        if (shouldExit) break;
        if (waitSignal.aborted) continue;
        break;
      }

      log(`Incoming prompt: ${batch.message.slice(0, 200)}`);
      inTurn = true;
      sendEnvelopes(sessionManager.startTurn());
      const turnEnded = waitForTurnEnd();
      try {
        if (typeof batch.mode.permissionMode === 'string' && batch.mode.permissionMode.length > 0) {
          backend.setMode(mapPermissionModeToZcode(batch.mode.permissionMode));
        }
        if (batch.isolate) {
          log('Isolated message requested - starting a fresh zcode session');
          backend.resetSession();
          delete bridgeState.zcodeSessionId;
          saveBridgeState(bridgeState);
        }
        await backend.sendPrompt('zcode-headless', batch.message);
        await turnEnded;
        sendEnvelopes(sessionManager.endTurn('completed'));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        session.sendSessionEvent({ type: 'message', message: `zcode error: ${msg}` });
        log(`Turn ended: ${msg}`);
        sendEnvelopes(sessionManager.endTurn('failed'));
      }
      inTurn = false;
      thinking = false;

      const zcodeSessionId = backend.currentZcodeSessionId;
      if (zcodeSessionId && zcodeSessionId !== bridgeState.zcodeSessionId) {
        bridgeState.zcodeSessionId = zcodeSessionId;
        saveBridgeState(bridgeState);
      }

      session.keepAlive(false, 'remote');
      session.sendSessionEvent({ type: 'ready' });
    }
  } finally {
    clearInterval(keepAliveInterval);
    reconnectionHandle?.cancel();

    backend.offMessage(onBackendMessage);
    await backend.dispose();

    try {
      session.updateMetadata((currentMetadata) => ({
        ...currentMetadata,
        lifecycleState: 'archived',
        lifecycleStateSince: Date.now(),
        archivedBy: 'cli',
        archiveReason: 'Session ended',
      }));
      session.sendSessionDeath();
      await session.flush();
      await session.close();
    } catch (error) {
      logger.debug('[zcode] Session close failed:', error);
    }
    logger.debug('[zcode] Cleaned up');
  }
}
