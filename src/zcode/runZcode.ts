/**
 * Zcode CLI Entry Point
 *
 * Runs the zcode agent (https://github.com/anonym/foo - ZCode CLI) through
 * Happy. Each Happy user message becomes one headless `zcode --print` turn;
 * turns are connected through zcode's own persisted sessions (`--resume`),
 * so conversation context lives inside zcode, not here.
 */

import { randomUUID } from 'node:crypto';
import os from 'node:os';

import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { initialMachineMetadata } from '@/daemon/run';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import type { ApiSessionClient } from '@/api/apiSession';
import type { PermissionMode } from '@/claude/loop';

import { ZcodeBackend } from './zcodeBackend';
import { mapPermissionModeToZcode, ZCODE_DEFAULT_COMMAND } from './constants';
import type { ZcodeMode } from './types';

/**
 * Main entry point for the zcode command
 */
export async function runZcode(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
    zcodeCommand?: string;
}): Promise<void> {
    const sessionTag = randomUUID();
    connectionState.setBackend('Zcode');

    const api = await ApiClient.create(opts.credentials);

    //
    // Machine
    //

    const settings = await readSettings();
    const machineId = settings?.machineId;
    if (!machineId) {
        console.error(`[START] No machine ID found in settings. Please report this issue on https://github.com/slopus/happy-cli/issues`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);
    await api.getOrCreateMachine({
        machineId,
        metadata: initialMachineMetadata
    });

    //
    // Create session
    //

    const { state, metadata } = createSessionMetadata({
        flavor: 'zcode',
        machineId,
        startedBy: opts.startedBy
    });
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

    let session: ApiSessionClient;
    let isProcessingMessage = false;
    let pendingSessionSwap: ApiSessionClient | null = null;

    const applyPendingSessionSwap = () => {
        if (pendingSessionSwap) {
            logger.debug('[zcode] Applying pending session swap');
            session = pendingSessionSwap;
            pendingSessionSwap = null;
        }
    };

    const { session: initialSession } = setupOfflineReconnection({
        api,
        sessionTag,
        metadata,
        state,
        response,
        onSessionSwap: (newSession) => {
            if (isProcessingMessage) {
                logger.debug('[zcode] Session swap requested during message processing - queueing');
                pendingSessionSwap = newSession;
            } else {
                session = newSession;
            }
        }
    });
    session = initialSession;

    if (response) {
        try {
            await notifyDaemonSessionStarted(response.id, metadata);
        } catch (error) {
            logger.debug('[START] Failed to report to daemon (may not be running):', error);
        }
    }

    const messageQueue = new MessageQueue2<ZcodeMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
    }));

    let currentPermissionMode: PermissionMode | undefined = undefined;

    session.onUserMessage((message) => {
        let messagePermissionMode = currentPermissionMode;
        if (message.meta?.permissionMode) {
            const validModes: PermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];
            if (validModes.includes(message.meta.permissionMode as PermissionMode)) {
                messagePermissionMode = message.meta.permissionMode as PermissionMode;
                currentPermissionMode = messagePermissionMode;
            } else {
                logger.debug(`[zcode] Invalid permission mode received: ${message.meta.permissionMode}`);
            }
        }
        if (currentPermissionMode === undefined) {
            currentPermissionMode = 'default';
        }
        if (message.meta?.hasOwnProperty('model')) {
            logger.debug('[zcode] Model switching is not supported by the zcode backend; ignoring model meta');
        }

        const originalUserMessage = message.content.text;
        messageQueue.push(originalUserMessage, {
            permissionMode: messagePermissionMode || 'default',
            originalUserMessage,
        });
    });

    let thinking = false;
    session.keepAlive(thinking, 'remote');
    const keepAliveInterval = setInterval(() => {
        session.keepAlive(thinking, 'remote');
    }, 2000);

    const sendReady = () => {
        session.sendSessionEvent({ type: 'ready' });
        try {
            api.push().sendToAllDevices(
                "It's ready!",
                'Zcode is waiting for your command',
                { sessionId: session.sessionId }
            );
        } catch (pushError) {
            logger.debug('[zcode] Failed to send ready push', pushError);
        }
    };

    const emitReadyIfIdle = (): boolean => {
        if (shouldExit || thinking || isProcessingMessage || messageQueue.size() > 0) {
            return false;
        }
        sendReady();
        return true;
    };

    //
    // Abort handling
    //

    let abortController = new AbortController();
    let shouldExit = false;
    const backend = new ZcodeBackend({
        cwd: process.cwd(),
        command: opts.zcodeCommand,
    });

    let accumulatedResponse = '';
    let responseStarted = false;

    backend.onMessage((msg) => {
        if (msg.type === 'model-output') {
            const delta = msg.textDelta ?? msg.fullText;
            if (!delta) return;
            accumulatedResponse += delta;
            if (msg.textDelta !== undefined) {
                responseStarted = true;
                // Live progress while zcode streams its response
                session.sendAgentMessage('zcode', {
                    type: 'thinking',
                    text: delta,
                });
            }
        } else if (msg.type === 'status') {
            if (msg.status === 'error') {
                logger.debug('[zcode] Backend error status:', msg.detail);
            }
        }
    });

    async function handleAbort() {
        logger.debug('[zcode] Abort requested - stopping current turn');

        session.sendAgentMessage('zcode', {
            type: 'turn_aborted',
            id: randomUUID(),
        });

        try {
            abortController.abort();
            messageQueue.reset();
            await backend.cancel('zcode-headless');
        } catch (error) {
            logger.debug('[zcode] Error during abort:', error);
        } finally {
            abortController = new AbortController();
        }
    }

    const handleKillSession = async () => {
        logger.debug('[zcode] Kill session requested - terminating');
        await handleAbort();

        try {
            if (session) {
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    lifecycleState: 'archived',
                    lifecycleStateSince: Date.now(),
                    archivedBy: 'cli',
                    archiveReason: 'User terminated'
                }));

                session.sendSessionDeath();
                await session.flush();
                await session.close();
            }

            await backend.dispose();
            process.exit(0);
        } catch (error) {
            logger.debug('[zcode] Error during session termination:', error);
            process.exit(1);
        }
    };

    session.rpcHandlerManager.registerHandler('abort', handleAbort);
    registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

    //
    // Console UX (no TUI - zcode sessions are typically run via daemon or headless)
    //

    console.log(`Happy Zcode bridge active (${os.platform()}/${os.arch()})`);
    console.log(`Agent command: ${opts.zcodeCommand || process.env.ZCODE_COMMAND || ZCODE_DEFAULT_COMMAND}`);
    console.log('Waiting for messages from your Happy app...');

    session.keepAlive(thinking, 'remote');
    sendReady();

    let first = true;
    let sessionStarted = false;

    try {
        while (!shouldExit) {
            const batch = await messageQueue.waitForMessagesAndGetAsString(abortController.signal);
            if (!batch) {
                if (abortController.signal.aborted && !shouldExit) {
                    continue;
                }
                break;
            }
            const message = batch;
            logger.debug(`[zcode] Main loop: received message (length: ${message.message.length})`);

            const userMessageToShow = message.mode?.originalUserMessage || message.message;
            console.log(`\n[user] ${userMessageToShow}`);

            isProcessingMessage = true;
            thinking = true;
            session.keepAlive(thinking, 'remote');
            session.sendAgentMessage('zcode', {
                type: 'task_started',
                id: randomUUID(),
            });

            accumulatedResponse = '';
            responseStarted = false;

            try {
                backend.setMode(mapPermissionModeToZcode(message.mode.permissionMode));

                if (first || !sessionStarted) {
                    await backend.startSession();
                    sessionStarted = true;
                    first = false;
                }

                if (message.isolate) {
                    logger.debug('[zcode] Isolated message requested - starting a fresh zcode session');
                    await backend.resetSession();
                }

                logger.debug(`[zcode] Sending prompt (length: ${message.message.length})`);
                await backend.sendPrompt('zcode-headless', message.message);
            } catch (error) {
                const isAbortError = error instanceof Error && (error.name === 'AbortError' || abortController.signal.aborted);
                if (isAbortError) {
                    console.log('[zcode] Turn aborted by user');
                    session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                } else {
                    const errorMsg = error instanceof Error ? error.message : String(error);
                    console.error(`[zcode] Turn failed: ${errorMsg}`);
                    session.sendAgentMessage('zcode', {
                        type: 'message',
                        message: `Error: ${errorMsg}`,
                    });
                }
            } finally {
                if (accumulatedResponse.trim()) {
                    logger.debug(`[zcode] Sending complete message to mobile (length: ${accumulatedResponse.length})`);
                    session.sendAgentMessage('zcode', {
                        type: 'message',
                        message: accumulatedResponse,
                    });
                    accumulatedResponse = '';
                    responseStarted = false;
                }

                session.sendAgentMessage('zcode', {
                    type: 'task_complete',
                    id: randomUUID(),
                });

                thinking = false;
                session.keepAlive(thinking, 'remote');
                emitReadyIfIdle();

                isProcessingMessage = false;
                applyPendingSessionSwap();
            }

            first = false;
        }
    } finally {
        clearInterval(keepAliveInterval);
        await backend.dispose();
        logger.debug('[zcode]: Cleaned up');
    }
}
