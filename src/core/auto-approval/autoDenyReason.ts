/**
 * Structured detail attached to automatic command denials.
 *
 * An automatic denial is one produced by the system rather than by a user
 * clicking "reject": from policy (denylist, blanket auto-deny, DCG block) or
 * from a guard-state inconsistency (`guard_unavailable`), which is not itself
 * a policy denial. The detail travels from `checkAutoApproval` through
 * `Task.ask` to `presentAssistantMessage`, where it selects the structured
 * `formatResponse.toolAutoDenied` payload instead of the user-rejection
 * wording — and marks the denial as scoped to its own tool call, so it never
 * aborts the rest of the turn.
 */
export type AutoDenyDetail = {
	kind: "dcg" | "denylist" | "not_allowlisted" | "dangerous_substitution" | "malformed_command" | "guard_unavailable"
	/** Offending sub-command text (or the full command when no single offending sub-command applies). */
	command?: string
	/** Matched denied prefix, for `denylist` denials. */
	pattern?: string
	/** Raw DCG reason string, for `dcg` denials (not the i18n'd chat string). */
	dcgReason?: string
	/** Raw DCG rule id, for `dcg` denials. */
	dcgRuleId?: string
	/** Parse-error message, for `malformed_command` denials. */
	parseError?: string
}

/**
 * Build the model-facing reason string for an automatic denial.
 *
 * Hardcoded English, matching the existing `formatResponse` precedent: these
 * strings go to the model, not the chat UI (chat rows stay i18n'd). The text
 * deliberately never suggests asking the user — in hands-free mode that would
 * invite `ask_followup_question` and defeat the purpose of the feature.
 */
export function buildAutoDenyReason(detail: AutoDenyDetail): string {
	switch (detail.kind) {
		case "denylist":
			return `Command \`${detail.command ?? "(unknown)"}\` matches denied prefix \`${detail.pattern ?? "(unknown)"}\`.`
		case "not_allowlisted":
			return `Command \`${detail.command ?? "(unknown)"}\` is not on the command allowlist.`
		case "dangerous_substitution":
			return "Command contains shell expansions (${...} forms, process substitution, and similar) that are never auto-approved. Choose an approved command without shell expansions."
		case "malformed_command":
			return detail.parseError ?? "Command contains a shell syntax error."
		case "dcg": {
			const base = `Destructive Command Guard denied the command: ${detail.dcgReason ?? "no reason provided"}`
			return detail.dcgRuleId ? `${base} (Rule: ${detail.dcgRuleId})` : base
		}
		case "guard_unavailable":
			return `Command \`${detail.command ?? "(unknown)"}\` was not executed: the Destructive Command Guard is enabled but supplied no verdict, which is an internal guard-state inconsistency, not a policy denial. You may retry the same command.`
	}
}
