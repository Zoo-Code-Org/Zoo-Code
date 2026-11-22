// Shared fixtures for the auto-approval allowlist specs.
//
// The three allowlist specs each need a fully-populated auto-approval state with
// every toggle off, so that a test's own overrides are the only thing that can
// approve anything. Keeping one copy of it prevents the drift that comes from
// maintaining near-identical literals side by side.

import path from "path"

import type { ClineSayTool, ExtensionState } from "@roo-code/types"

import type { ApprovalFileTarget } from "../../../shared/tools"
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
	alwaysDenyUnapprovedCommands: false,
	allowedCommands: [],
	deniedCommands: [],
}

/**
 * A `readFile` ask as `read_file` sends it: the message for the chat, plus one
 * file target per named file, resolved against `cwd` by the platform's rules.
 *
 * Only for messages whose paths already name the files read. A spec about a
 * display path that differs from the file read must build its targets itself.
 */
export function readFileAsk(
	tool: ClineSayTool,
	cwd: string | undefined,
): { text: string; fileTargets: ApprovalFileTarget[] } {
	// `process.platform` rather than `path` itself, so specs simulating Windows get Windows paths.
	const nativePath = process.platform === "win32" ? path.win32 : path.posix
	const files = [...(tool.path === undefined ? [] : [tool]), ...(tool.batchFiles ?? [])]

	return {
		text: JSON.stringify(tool),
		fileTargets: files.map((file) => ({
			absolutePath: nativePath.isAbsolute(file.path ?? "")
				? (file.path ?? "")
				: nativePath.resolve(cwd ?? "", file.path ?? ""),
			isOutsideWorkspace: file.isOutsideWorkspace ?? tool.isOutsideWorkspace ?? false,
		})),
	}
}
