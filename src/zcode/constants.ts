import type { PermissionMode } from '@/claude/loop';

/** Default command looked up on PATH to spawn the zcode CLI. */
export const ZCODE_DEFAULT_COMMAND = 'zcode';

/** zcode headless permission modes (subset of `zcode --help --mode`). */
export type ZcodePermissionMode = 'build' | 'edit' | 'plan' | 'yolo';

/**
 * Map Happy's permission modes to zcode's `--mode` values.
 *
 * zcode runs non-interactively here, so there is no one to answer
 * permission prompts: `build`/`edit` make zcode deny tools it would
 * normally ask about, while `yolo` auto-approves everything.
 */
export function mapPermissionModeToZcode(mode: PermissionMode | undefined): ZcodePermissionMode {
    switch (mode) {
        case 'read-only':
            return 'plan';
        case 'safe-yolo':
            return 'edit';
        case 'yolo':
            return 'yolo';
        default:
            return 'yolo';
    }
}
