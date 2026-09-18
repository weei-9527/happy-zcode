import type { PermissionMode } from '@/claude/loop';

/**
 * Per-message mode for the zcode backend.
 */
export interface ZcodeMode {
    permissionMode: PermissionMode;
    originalUserMessage?: string;
}

/**
 * Result of a single `zcode --print --json` turn.
 * Matches the JSON document printed by the zcode CLI at the end of a turn.
 */
export interface ZcodeTurnResult {
    sessionId: string;
    traceId?: string;
    turnId?: string;
    response?: string;
    usage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        cacheReadTokens?: number;
    };
    projection?: {
        status?: string;
        turnCount?: number;
        totalTokenCount?: number;
        contextUsed?: number;
        contextWindow?: number;
    };
    [key: string]: unknown;
}
