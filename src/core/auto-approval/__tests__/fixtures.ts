// Shared fixtures for the auto-approval allowlist specs.
//
// The three allowlist specs each need a fully-populated auto-approval state with
// every toggle off, so that a test's own overrides are the only thing that can
// approve anything. Keeping one copy of it prevents the drift that comes from
// maintaining near-identical literals side by side.

import type { ExtensionState } from "@roo-code/types"

import type { AutoApprovalState, AutoApprovalStateOptions } from ".."

export type State = Pick<ExtensionState, AutoApprovalState | AutoApprovalStateOptions>

/** Workspace root the specs resolve their patterns and paths against. */
export const CWD = "/path/to/repo"

/**
 * Home directory `~` stands for in the specs.
 *
 * Passed explicitly wherever `~` is involved, so the expectations do not depend
 * on the machine running them: a real `os.homedir()` is `/home/someone` on Linux
 * but `C:\Users\someone` on Windows, and `process.env.HOME` is normally unset
 * there altogether.
 */
export const HOME = "/home/me"

/**
 * Auto-approval enabled, every permission off, both allowlists empty.
 *
 * Every field is listed rather than relying on optionality, so that a test which
 * approves something can only be doing so through what it overrides.
 */
export const baseState: State = {
	autoApprovalEnabled: true,
	alwaysAllowReadOnly: false,
	alwaysAllowReadOnlyOutsideWorkspace: false,
	allowedReadFiles: [],
	alwaysAllowWrite: false,
	alwaysAllowWriteOutsideWorkspace: false,
	alwaysAllowWriteProtected: false,
	allowedWriteFiles: [],
	alwaysAllowMcp: false,
	alwaysAllowModeSwitch: false,
	alwaysAllowSubtasks: false,
	alwaysAllowExecute: false,
	alwaysAllowFollowupQuestions: false,
	destructiveCommandGuardEnabled: false,
	allowedCommands: [],
	deniedCommands: [],
}
