import { getTaskErrorState, STUCK_LOOP_THRESHOLD } from "../tools/error-interception/TaskErrorState"
import type { RecoveryDisposition } from "../tools/error-interception/types"

/**
 * Structured error presentation for LLM-guided error recovery.
 * Provides WHAT/WHY/NEXT format wrapped in <error_details> XML tags.
 *
 * Unlike the classifier-driven error-interception pipeline, this formatter is
 * fed directly by the tool_use / mcp_tool_use `handleError` closures in
 * presentAssistantMessage.ts. It derives honest retry guidance from the error
 * itself and tracks per-task occurrence counts via TaskErrorState so repeated
 * identical failures are reported as such instead of "occurrence 1, retryable"
 * forever.
 */

export interface StructuredErrorDetails {
	what: string
	why: string
	next: string[]
	retryable?: boolean
	pattern?: string
	occurrence?: number
	disposition?: RecoveryDisposition
}

/**
 * Machine-code signals embedded in error messages that mark a failure as
 * non-retryable (e.g. `TERMINAL/PROVIDER_SWITCH/003`). Retrying such an
 * operation unchanged cannot succeed, so the model must be told to stop.
 */
const NON_RETRYABLE_MESSAGE_SIGNALS: readonly string[] = ["TERMINAL/", "SHELL/", "PROVIDER_SWITCH"]

/** Error names produced by schema/argument validation layers. */
const VALIDATION_ERROR_NAMES: ReadonlySet<string> = new Set(["ZodError", "ValidationError"])

const VALIDATION_MESSAGE_RE = /\bvalidation (?:failed|error)\b/i

/** Matches the user-rejection phrasing used by the edit/patch tool family. */
const USER_REJECTION_RE = /(?:rejected|denied) by the user/i

/**
 * Returns true when the error represents the user declining an operation.
 * Retrying automatically would override an explicit user decision.
 */
export function isUserRejectionError(error: Error): boolean {
	return USER_REJECTION_RE.test(error.message ?? "")
}

/**
 * Derives retryability from the error itself. Known non-retryable signals:
 * terminal/shell/provider-switch machine codes, validation errors, and user
 * rejections. Everything else is considered retryable with corrected input.
 */
export function isRetryableError(error: Error): boolean {
	const message = error.message ?? ""
	if (NON_RETRYABLE_MESSAGE_SIGNALS.some((signal) => message.includes(signal))) {
		return false
	}
	if (VALIDATION_ERROR_NAMES.has(error.name)) {
		return false
	}
	if (VALIDATION_MESSAGE_RE.test(message)) {
		return false
	}
	if (isUserRejectionError(error)) {
		return false
	}
	return true
}

/**
 * Selects the occurrence-aware recovery disposition using the
 * error-interception module's vocabulary:
 * - user rejections -> `await_user` (never auto-retry a user decision)
 * - non-retryable errors -> `change_strategy`
 * - retryable errors -> `correct_once`, escalating to `change_strategy` once
 *   the same failure reaches the stuck-loop threshold.
 */
export function deriveRecoveryDisposition(error: Error, occurrence: number): RecoveryDisposition {
	if (isUserRejectionError(error)) {
		return "await_user"
	}
	if (!isRetryableError(error)) {
		return "change_strategy"
	}
	return occurrence >= STUCK_LOOP_THRESHOLD ? "change_strategy" : "correct_once"
}

/**
 * Builds a stable signature for occurrence counting. Identical failures
 * (same action, error name, and first message line) map to the same
 * signature, so the Nth repetition reports occurrence N.
 */
export function buildErrorSignature(action: string, error: Error): string {
	const firstLine = (error.message ?? "").split("\n", 1)[0].trim().slice(0, 200)
	return `structured-error|${action}|${error.name}|${firstLine}`
}

/**
 * Increments and returns the per-task occurrence count for an error
 * signature. State is kept in the error-interception module's TaskErrorState
 * WeakMap, so counters persist across tool blocks within a task and are
 * released with it. Non-object keys fail open with occurrence 1.
 */
export function recordErrorOccurrence(task: object, signature: string): number {
	return getTaskErrorState(task).incrementOccurrence(signature)
}

function truncateField(text: string, maxLength: number): string {
	return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`
}

/**
 * Formats structured error details as an <error_details> block containing
 * JSON. The output is always valid JSON: when the payload exceeds
 * `byteLimit`, Next items and free-text fields are truncated before
 * serializing, with a minimal-but-valid payload as the last resort (the
 * minimal payload may still exceed a pathologically small limit, but it is
 * never malformed).
 */
export function formatStructuredError(details: StructuredErrorDetails, byteLimit: number = 8000): string {
	const version = "1.0"
	const status = "error"
	const category = details.pattern ? (details.pattern.split("/")[1] ?? "unknown") : "unknown"
	// A `type` discriminator must not contain slashes; use the dotted form of
	// the pattern id (e.g. "tool_execution.error_execution.001").
	const type = details.pattern ? details.pattern.toLowerCase().replace(/\//g, ".") : "unclassified_error"
	const retryable = details.retryable ?? true
	const occurrence = Math.max(1, details.occurrence ?? 1)
	const patternId = details.pattern ?? "UNCLASSIFIED/000/000"
	const recoveryDisposition = details.disposition ?? "correct_once"

	const payload = {
		version,
		status,
		type,
		category,
		what: details.what,
		why: details.why,
		next: details.next,
		retryable,
		occurrence,
		pattern_id: patternId,
		recovery_disposition: recoveryDisposition,
	}

	let json = JSON.stringify(payload, null, 2)

	if (json.length > byteLimit && payload.next.length > 1) {
		// Trim Next items to fit within byte limit, preserving the first one.
		json = JSON.stringify({ ...payload, next: payload.next.slice(0, 1) }, null, 2)
	}

	if (json.length > byteLimit) {
		// Truncate the free-text fields before serializing so the block stays valid JSON.
		json = JSON.stringify(
			{
				...payload,
				what: truncateField(details.what, 160),
				why: truncateField(details.why, 160),
				next: payload.next.slice(0, 1),
			},
			null,
			2,
		)
	}

	if (json.length > byteLimit) {
		// Last resort: minimal payload that is still valid JSON.
		json = JSON.stringify({ ...payload, what: "Error.", why: "Error.", next: [] }, null, 2)
	}

	return `<error_details>\n${json}\n</error_details>`
}

/**
 * Builds the model-facing <error_details> content for a tool execution
 * failure, deriving honest retry guidance from the error and tracking the
 * per-task occurrence of identical failures.
 */
export function buildStructuredErrorContent(task: object, action: string, error: Error, pattern: string): string {
	const occurrence = recordErrorOccurrence(task, buildErrorSignature(action, error))
	const retryable = isRetryableError(error)
	return formatStructuredError({
		what: `An error occurred during ${action}.`,
		why: error.message || "An unexpected error occurred.",
		next: retryable
			? [
					`Review the error details and retry the ${action} operation with corrected parameters.`,
					`If the error persists, report this issue to the development team.`,
				]
			: [
					`Do not retry the ${action} operation unchanged; this failure is not expected to resolve by retrying.`,
					`Change the parameters or the tool, or ask the user how to proceed.`,
				],
		pattern,
		retryable,
		occurrence,
		disposition: deriveRecoveryDisposition(error, occurrence),
	})
}

/**
 * Builds the concise, human-readable message shown in the chat UI via
 * say("error", ...). The structured payload is intentionally kept out of the
 * UI message; it lives only in the tool result.
 */
export function formatConciseErrorMessage(action: string, error: Error): string {
	return `Error during ${action}: ${error.message || "An unexpected error occurred."}`
}
