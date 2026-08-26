import {
	type ClineAsk,
	type ClineSayTool,
	type McpServerUse,
	type FollowUpData,
	type ExtensionState,
	isNonBlockingAsk,
} from "@roo-code/types"

import { ClineAskResponse } from "../../shared/WebviewMessage"

import { isWriteToolAction, isReadOnlyToolAction } from "./tools"
import { isMcpToolAlwaysAllowed } from "./mcp"
import { getCommandDecision } from "./commands"
import { isFileMatchedByPatterns } from "./filePatterns"

// We have auto-approval actions for different categories.
export type AutoApprovalState =
	| "alwaysAllowReadOnly"
	| "alwaysAllowWrite"
	| "alwaysAllowMcp"
	| "alwaysAllowModeSwitch"
	| "alwaysAllowSubtasks"
	| "alwaysAllowExecute"
	| "alwaysAllowFollowupQuestions"

// Some of these actions have additional settings associated with them.
export type AutoApprovalStateOptions =
	| "autoApprovalEnabled"
	| "alwaysAllowReadOnlyOutsideWorkspace" // For `alwaysAllowReadOnly`.
	| "allowedReadFiles" // Grants reads per file, without `alwaysAllowReadOnly`.
	| "alwaysAllowWriteOutsideWorkspace" // For `alwaysAllowWrite`.
	| "alwaysAllowWriteProtected"
	| "allowedWriteFiles" // Grants writes per file, without `alwaysAllowWrite`.
	| "followupAutoApproveTimeoutMs" // For `alwaysAllowFollowupQuestions`.
	| "mcpServers" // For `alwaysAllowMcp`.
	| "allowedCommands" // For `alwaysAllowExecute`.
	| "deniedCommands"
	| "destructiveCommandGuardEnabled"

/**
 * Every file a tool action names, as far as the allowlists are concerned.
 *
 * One approval answers for the whole action, so every file it touches has to be
 * covered by the patterns. Rather than deciding which of these fields a given
 * message is expected to use, all of them are collected and all have to match:
 * that way no field can grant a permission by being overlooked, and a field
 * added later can only ever make the check stricter.
 *
 * `additionalFileCount` counts files that the message does *not* name (the chat
 * row renders it as "and N more"). They cannot be matched against a pattern, so
 * the caller must refuse the whole action rather than approve the named ones.
 */
function namedFiles(tool: ClineSayTool): { paths: string[]; hasUnnamedFiles: boolean } {
	const batched = [...(tool.batchFiles ?? []), ...(tool.batchDiffs ?? []), ...(tool.batchDirs ?? [])]

	return {
		paths: [...(tool.path === undefined ? [] : [tool.path]), ...batched.map((file) => file.path)],
		hasUnnamedFiles: !!tool.additionalFileCount,
	}
}

/**
 * Whether every file named by a tool action is covered by `matchFun`.
 *
 * Returns `false` for an action naming no file at all, since patterns can only
 * grant access to files they name, and for one that carries unnamed files.
 */
function areAllNamedFilesMatched(tool: ClineSayTool, matchFun: (filePath: string) => boolean): boolean {
	const { paths, hasUnnamedFiles } = namedFiles(tool)

	if (hasUnnamedFiles) {
		return false
	}

	// Bail on `!paths.length` defensively in case new paths are introduced
	// in the future that are forgotten to be added to `namedFiles()`.
	if (!paths.length) {
		return false
	}

	return paths.every((filePath) => matchFun(filePath))
}

/**
 * Whether a read-only tool action is fully covered by the read allowlist patterns.
 *
 * The allowlist names individual files, so it only ever approves `read_file`:
 * the other read-only actions (directory listings, searches, codebase queries)
 * work on directories, not files, and are turned away by the `tool` check below.
 *
 * A `read_file` call can cover several files at once, in which case a single
 * approval answers for all of them, so ALL of them have to be allowed.
 *
 * Write permission implies read permission, so both lists are consulted, each
 * matched on its own rather than concatenated: gitignore negation is
 * order-sensitive ("the last matching pattern wins"), so concatenating would let
 * a `!` typed into one list cancel a pattern typed into the other, with the
 * outcome depending on which list that was. A negation therefore only ever
 * narrows the list it appears in. This also means that negating a read is
 * ineffective while a non-negated write pattern still matches the file.
 */
function isReadAllowedByPatterns(
	tool: ClineSayTool,
	cwd: string | undefined,
	state: Pick<ExtensionState, "allowedReadFiles" | "allowedWriteFiles">,
): boolean {
	if (tool.tool !== "readFile") {
		return false
	}

	return areAllNamedFilesMatched(
		tool,
		(filePath) =>
			isFileMatchedByPatterns({ filePath, cwd, patterns: state.allowedReadFiles }) ||
			isFileMatchedByPatterns({ filePath, cwd, patterns: state.allowedWriteFiles }),
	)
}

/**
 * Whether a write tool action is fully covered by the write allowlist patterns.
 *
 * As for reads, one approval covers every file the action names, so every one of
 * them has to be matched.
 */
function isWriteAllowedByPatterns(
	tool: ClineSayTool,
	cwd: string | undefined,
	state: Pick<ExtensionState, "allowedWriteFiles">,
): boolean {
	return areAllNamedFilesMatched(tool, (filePath) =>
		isFileMatchedByPatterns({ filePath, cwd, patterns: state.allowedWriteFiles }),
	)
}

export type CheckAutoApprovalResult =
	| { decision: "approve" }
	| { decision: "deny" }
	| { decision: "ask" }
	| {
			decision: "timeout"
			timeout: number
			fn: () => { askResponse: ClineAskResponse; text?: string; images?: string[] }
	  }

export async function checkAutoApproval({
	state,
	cwd,
	ask,
	text,
	isProtected,
}: {
	state?: Pick<ExtensionState, AutoApprovalState | AutoApprovalStateOptions>
	/**
	 * Workspace root the allowlist patterns and the checked path are resolved
	 * against.
	 *
	 * Must be the `cwd` of the task this ask belongs to, which is the root the
	 * path in `text` was made relative to. It is not read from `state`, because
	 * the provider's `cwd` follows the window (the focused editor in a multi-root
	 * workspace, or a `refreshWorkspace()` while the task runs) and a resumed or
	 * child task can run against another root entirely. Resolving against the
	 * wrong one would let a pattern written for one workspace approve a write
	 * landing in another.
	 */
	cwd?: string
	ask: ClineAsk
	text?: string
	isProtected?: boolean
}): Promise<CheckAutoApprovalResult> {
	if (isNonBlockingAsk(ask)) {
		return { decision: "approve" }
	}

	if (!state || !state.autoApprovalEnabled) {
		return { decision: "ask" }
	}

	if (ask === "followup") {
		if (state.alwaysAllowFollowupQuestions === true) {
			try {
				const suggestion = (JSON.parse(text || "{}") as FollowUpData).suggest?.[0]

				if (
					suggestion &&
					typeof state.followupAutoApproveTimeoutMs === "number" &&
					state.followupAutoApproveTimeoutMs > 0
				) {
					return {
						decision: "timeout",
						timeout: state.followupAutoApproveTimeoutMs,
						fn: () => ({ askResponse: "messageResponse", text: suggestion.answer }),
					}
				} else {
					return { decision: "ask" }
				}
			} catch (error) {
				return { decision: "ask" }
			}
		} else {
			return { decision: "ask" }
		}
	}

	if (ask === "use_mcp_server") {
		if (!text) {
			return { decision: "ask" }
		}

		try {
			const mcpServerUse = JSON.parse(text) as McpServerUse

			if (mcpServerUse.type === "use_mcp_tool") {
				return state.alwaysAllowMcp === true && isMcpToolAlwaysAllowed(mcpServerUse, state.mcpServers)
					? { decision: "approve" }
					: { decision: "ask" }
			} else if (mcpServerUse.type === "access_mcp_resource") {
				return state.alwaysAllowMcp === true ? { decision: "approve" } : { decision: "ask" }
			}
		} catch (error) {
			return { decision: "ask" }
		}

		return { decision: "ask" }
	}

	if (ask === "command") {
		if (!text) {
			return { decision: "ask" }
		}
		if (isProtected) {
			return { decision: "ask" }
		}

		if (state.alwaysAllowExecute === true) {
			// Execute commands immediately when DCG allows them. ExecuteCommandTool
			// marks commands blocked by DCG as protected before reaching this check,
			// which keeps the explicit user approval prompt for those commands. When
			// enabled, DCG is the authoritative command policy, so Zoo's allow and deny
			// lists are intentionally bypassed for commands that DCG allows.
			if (state.destructiveCommandGuardEnabled === true) {
				return { decision: "approve" }
			}

			const decision = getCommandDecision(text, state.allowedCommands || [], state.deniedCommands || [])

			if (decision === "auto_approve") {
				return { decision: "approve" }
			} else if (decision === "auto_deny") {
				return { decision: "deny" }
			} else {
				return { decision: "ask" }
			}
		}
	}

	if (ask === "tool") {
		let tool: ClineSayTool | undefined

		try {
			tool = JSON.parse(text || "{}")
		} catch (error) {
			console.error("Failed to parse tool:", error)
		}

		if (!tool) {
			return { decision: "ask" }
		}

		if (tool.tool === "updateTodoList") {
			return { decision: "approve" }
		}

		// The skill tool only loads pre-defined instructions from global or project skills.
		// It does not read arbitrary files - skills must be explicitly installed/defined by the user.
		// Auto-approval is intentional to provide a seamless experience when loading task instructions.
		if (tool.tool === "skill") {
			return { decision: "approve" }
		}

		if (tool?.tool === "switchMode") {
			return state.alwaysAllowModeSwitch === true ? { decision: "approve" } : { decision: "ask" }
		}

		if (["newTask", "finishTask"].includes(tool?.tool)) {
			return state.alwaysAllowSubtasks === true ? { decision: "approve" } : { decision: "ask" }
		}

		const isOutsideWorkspace = !!tool.isOutsideWorkspace

		if (isReadOnlyToolAction(tool)) {
			// A file listed in `allowedReadFiles` may be read without the blanket
			// `alwaysAllowReadOnly` permission. Such a pattern names its
			// location, including outside the workspace, so it also stands in for
			// `alwaysAllowReadOnlyOutsideWorkspace`.
			const isAllowedReadFile = isReadAllowedByPatterns(tool, cwd, state)

			const isReadAllowed =
				isAllowedReadFile ||
				(state.alwaysAllowReadOnly === true &&
					(!isOutsideWorkspace || state.alwaysAllowReadOnlyOutsideWorkspace === true))

			return isReadAllowed ? { decision: "approve" } : { decision: "ask" }
		}

		if (isWriteToolAction(tool)) {
			// A file listed in `allowedWriteFiles` may be written without the
			// blanket `alwaysAllowWrite` permission. Such a pattern names its
			// location, including outside the workspace, so it also stands in for
			// `alwaysAllowWriteOutsideWorkspace`.
			//
			// It deliberately does not stand in for `alwaysAllowWriteProtected`:
			// a broad pattern such as `*.md` would otherwise silently cover
			// protected files like `AGENTS.md`.
			const isAllowedWriteFile = isWriteAllowedByPatterns(tool, cwd, state)

			const isWriteAllowed =
				isAllowedWriteFile ||
				(state.alwaysAllowWrite === true &&
					(!isOutsideWorkspace || state.alwaysAllowWriteOutsideWorkspace === true))

			return isWriteAllowed && (!isProtected || state.alwaysAllowWriteProtected === true)
				? { decision: "approve" }
				: { decision: "ask" }
		}
	}

	return { decision: "ask" }
}

export { AutoApprovalHandler } from "./AutoApprovalHandler"
