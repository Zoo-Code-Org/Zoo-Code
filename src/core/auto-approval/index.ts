import {
	firstUsableSuggestion,
	type ClineAsk,
	type ClineSayTool,
	type McpServerUse,
	type FollowUpData,
	type ExtensionState,
	isNonBlockingAsk,
} from "@roo-code/types"

import type { DcgDecision } from "../../services/destructive-command-guard/runner"

import { ClineAskResponse } from "../../shared/WebviewMessage"

import { parseCommand } from "../../shared/parse-command"

import { isWriteToolAction, isReadOnlyToolAction } from "./tools"
import { isMcpToolAlwaysAllowed } from "./mcp"
import {
	type CommandDecisionDetail,
	containsDangerousSubstitution,
	findLongestPrefixMatch,
	getCommandDecisionDetailed,
} from "./commands"
import {
	type EffectiveCommandLists,
	commandListFolderForResource,
	getEffectiveCommandDecision,
	readCommandListScopes,
	resolveEffectiveCommandLists,
	workspaceCommandListsEnabled,
} from "./commandScope"
import { isFileMatchedByPatterns } from "./filePatterns"
import { type AutoDenyDetail } from "./autoDenyReason"

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
	| "globalAllowedCommands" // Raw global layer feeding the per-folder command-list composition.
	| "globalDeniedCommands"
	| "destructiveCommandGuardEnabled"
	| "alwaysDenyUnapprovedCommands" // For `alwaysAllowExecute` (blanket auto-deny).

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

/**
 * Same chain aggregation as `getCommandDecisionDetailed` — split into
 * sub-commands, any denial denies the whole command, a dangerous substitution
 * forces the user prompt, and approval needs every sub-command approved — but
 * each sub-command is decided by `getEffectiveCommandDecision`, so the global
 * layer decides every command it matches and workspace entries apply only
 * where no global entry matches. A flat merged pair cannot express that
 * precedence: a workspace wildcard deny ties a global prefix allow in the
 * matcher's longest-prefix comparison, so composition would have to drop one
 * layer's entries to break the tie and lose its verdicts elsewhere.
 *
 * The aggregation mirrors `getCommandDecisionDetailed` on purpose: malformed
 * parsing, redirection sanitization, the substitution veto, and the
 * offending-command/matched-pattern reporting must not drift between the two
 * paths — only the per-sub-command leaf decision differs. Where a sub-command
 * has no global match at all, both paths reach the same outcome, because the
 * flat pair is the union of exactly the layers the split evaluates.
 */
function getLayerScopedCommandDecisionDetailed(
	command: string,
	effective: EffectiveCommandLists,
): CommandDecisionDetail {
	if (!command?.trim()) {
		return { decision: "auto_approve" }
	}

	const { commands: subCommands, parseError } = parseCommand(command)
	if (parseError !== null) {
		return { decision: "malformed_command", offendingCommand: command, parseError: parseError.message }
	}

	const sanitizedCommands = subCommands.map((cmd) => cmd.replace(/\d*>&\d*/, "").trim())

	const decisions = sanitizedCommands.map((cmd) => getEffectiveCommandDecision(cmd, effective))

	const denyIndex = decisions.indexOf("auto_deny")
	if (denyIndex !== -1) {
		const offendingCommand = sanitizedCommands[denyIndex]
		const lowerMatch = findLongestPrefixMatch(offendingCommand, effective.denied)
		// Prefer the original-cased pattern the user typed, falling back to the
		// case-insensitive match itself.
		const matchedPattern =
			effective.denied.find((pattern) => pattern.toLowerCase() === lowerMatch) ?? lowerMatch ?? undefined

		return { decision: "auto_deny", offendingCommand, matchedPattern }
	}

	if (containsDangerousSubstitution(command)) {
		return { decision: "ask_user" }
	}

	if (decisions.every((decision) => decision === "auto_approve")) {
		return { decision: "auto_approve" }
	}

	const askIndex = decisions.indexOf("ask_user")

	return { decision: "ask_user", offendingCommand: askIndex !== -1 ? sanitizedCommands[askIndex] : undefined }
}

export type CheckAutoApprovalResult =
	| { decision: "approve" }
	/**
	 * Automatic denial. `autoDeny` carries the structured reason and the
	 * offending sub-command when the denial came from command policy (denylist
	 * match, blanket auto-deny, or a DCG block under blanket mode) or from the
	 * guard-state inconsistency the command branch denies as
	 * `guard_unavailable`. It marks the denial as policy-scoped — the model
	 * receives an explanatory `auto_deny` result, and unlike a user rejection
	 * the denial does not abort the remaining tool calls of the turn.
	 */
	| { decision: "deny"; autoDeny?: AutoDenyDetail }
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
	dcgDecision,
}: {
	state?: Pick<ExtensionState, AutoApprovalState | AutoApprovalStateOptions>
	/**
	 * Workspace root the allowlist patterns and the checked path are resolved
	 * against.
	 *
	 * For every ask but a command, this is the `cwd` of the task the ask belongs
	 * to — the root the path in `text` was made relative to. A command ask is
	 * judged against the command's own resolved working directory when the
	 * caller forwards `commandCwd`, which a custom working directory moves off
	 * the task folder. It is not read from `state`, because
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
	/**
	 * The verdict from a Destructive Command Guard run that the caller
	 * (ExecuteCommandTool) already performed for this exact command. Only
	 * provided for `ask: "command"` when DCG is enabled; undefined otherwise.
	 * Infra failures in DCG never produce a verdict — they surface as a tool
	 * error before this check, so a verdict here is authoritative.
	 */
	dcgDecision?: DcgDecision
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
				// A missing or blank answer would auto-approve the follow-up with no
				// content after the timeout (issue #1226), so pick the first suggestion
				// with a usable answer. This mirrors the webview's visible-suggestions
				// filter in FollowUpSuggest.
				const suggestion = firstUsableSuggestion((JSON.parse(text || "{}") as FollowUpData).suggest)

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
			} catch {
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
		} catch {
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
			const blanketDeny = state.alwaysDenyUnapprovedCommands === true

			// Execute commands immediately when DCG allows them. ExecuteCommandTool
			// passes the guard's verdict through so this single decision point can
			// act on it. When enabled, DCG is the authoritative command policy, so
			// Zoo's allow and deny lists are intentionally bypassed for commands
			// DCG rules on — and an allowlist match cannot rescue a DCG denial.
			if (state.destructiveCommandGuardEnabled === true) {
				if (dcgDecision?.decision === "deny") {
					// Blanket on: auto-deny, forwarding the guard's reason and
					// rule to the model. Blanket off: this ask falls through
					// to the normal user prompt.
					return blanketDeny
						? {
								decision: "deny",
								autoDeny: {
									kind: "dcg",
									command: text,
									dcgReason: dcgDecision.reason,
									dcgRuleId: dcgDecision.ruleId,
								},
							}
						: { decision: "ask" }
				}

				// A verdictless ask under an enabled guard is an inconsistent
				// guard state, not a guard decision: ExecuteCommandTool computes
				// and forwards its verdict on one straight-line path, so an ask
				// arriving without one means the setting flipped on mid-flight or
				// the caller never ran the guard. Deny with an explicitly
				// retryable detail — the command did not run, the turn is not
				// aborted, and a re-issue re-reads the setting.
				if (dcgDecision === undefined) {
					return {
						decision: "deny",
						autoDeny: { kind: "guard_unavailable", command: text },
					}
				}

				// The guard returned an explicit allow verdict: DCG is the
				// authoritative policy — approve.
				return { decision: "approve" }
			}

			// The pair on `state` was composed against the window's first
			// folder; a command executing in another folder must be judged by
			// that folder's lists, so enforcement re-composes from the raw
			// global layers at the folder the command's `cwd` resolves to. A
			// non-blank `cwd` that resolves to no workspace root names a
			// directory outside every folder, and no folder's layer may decide
			// it: the workspace layer is dropped (`enabled=false`) and only the
			// global layers apply — fail-closed, so nothing on a folder's
			// allow list can approve a command in a directory no folder
			// claims. A blank or absent `cwd` keeps the first-folder
			// configuration. Without the raw layers the pre-composed pair is
			// all the state carries, and that pair is what enforcement
			// consumes.
			const commandFolder = commandListFolderForResource(cwd)
			const cwdNamesNoFolder = Boolean(cwd) && commandFolder === undefined
			const effectiveLists =
				state.globalAllowedCommands !== undefined && state.globalDeniedCommands !== undefined
					? resolveEffectiveCommandLists(
							readCommandListScopes(
								"allowedCommands",
								state.globalAllowedCommands,
								undefined,
								commandFolder,
							),
							readCommandListScopes(
								"deniedCommands",
								state.globalDeniedCommands,
								undefined,
								commandFolder,
							),
							workspaceCommandListsEnabled() && !cwdNamesNoFolder,
						)
					: { allowed: state.allowedCommands || [], denied: state.deniedCommands || [] }

			// The layered composition carries the per-layer split, so each
			// sub-command goes through getEffectiveCommandDecision; the
			// pre-composed fallback pair carries no layers and keeps the flat
			// matcher.
			const { decision, offendingCommand, matchedPattern, parseError } =
				"globalAllow" in effectiveLists
					? getLayerScopedCommandDecisionDetailed(text, effectiveLists)
					: getCommandDecisionDetailed(text, effectiveLists.allowed, effectiveLists.denied)

			if (decision === "auto_approve") {
				return { decision: "approve" }
			} else if (decision === "auto_deny") {
				// Denylist denials are automatic denials and carry their structured
				// detail even when the blanket setting is off: they were never user
				// rejections, so the model gets the precise reason and the denial
				// stays scoped to this tool call.
				return {
					decision: "deny",
					autoDeny: { kind: "denylist", command: offendingCommand, pattern: matchedPattern },
				}
			} else if (decision === "malformed_command") {
				// Defense in depth: ExecuteCommandTool blocks shell syntax errors as
				// a retryable tool_error before any ask is created, so this is
				// normally unreachable. Under blanket mode deny rather than ask.
				return blanketDeny
					? {
							decision: "deny",
							autoDeny: { kind: "malformed_command", command: offendingCommand, parseError },
						}
					: { decision: "ask" }
			} else {
				// ask_user: with the blanket setting on, unapproved commands are
				// auto-denied instead of interrupting a hands-free session.
				if (!blanketDeny) {
					return { decision: "ask" }
				}

				if (containsDangerousSubstitution(text)) {
					// The substitution check runs chain-wide, so the full command
					// is the offending one; the list classifier reports no single
					// offending sub-command when it defers to this branch.
					return {
						decision: "deny",
						autoDeny: { kind: "dangerous_substitution", command: offendingCommand ?? text },
					}
				}

				return { decision: "deny", autoDeny: { kind: "not_allowlisted", command: offendingCommand } }
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
export { type AutoDenyDetail, buildAutoDenyReason } from "./autoDenyReason"
