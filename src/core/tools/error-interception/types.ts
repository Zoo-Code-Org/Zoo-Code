/**
 * Error interception contracts.
 *
 * These types are internal to the error-interception module. They do not change
 * public tool/provider contracts such as ToolResponse or HandleError.
 */

/**
 * Stable error behavior categories. The order here is alphabetical and does
 * not imply priority; pattern DB priority is defined separately.
 */
export type ErrorCategory =
	| "CONTEXT_OVERFLOW"
	| "DIFF_MATCH_FAILED"
	| "DUPLICATE_CALL"
	| "FILE_NOT_FOUND"
	| "FILE_RESTRICTION"
	| "INVALID_JSON_ARGUMENTS"
	| "INVALID_TOOL_PROTOCOL"
	| "MCP_TOOL_MISSING"
	| "MODE_RESTRICTION"
	| "PARAM_MISSING"
	| "PARAM_TYPE_MISMATCH"
	| "PARSER_FAILURE_INVALID_SHAPE"
	| "PARSER_FAILURE_JSON_SYNTAX"
	| "PARSER_FAILURE_MISSING_ARGS"
	| "SHELL_INTEGRATION"
	| "TOOL_NOT_FOUND"
	| "UNCLASSIFIED"

export type ErrorSource = "api_request" | "handler_exception" | "parser" | "repetition" | "tool_result" | "validation"

export type ErrorStage = "api" | "execute" | "parse" | "preflight" | "result"

export type ConfidenceLevel = "exact" | "heuristic" | "structural"

export type RetryPolicy = "alternate-tool" | "auto-recover" | "correct-and-retry" | "do-not-retry"

/**
 * Closed internal disposition that tells the model how to proceed with the
 * failed invocation and the overall task. Distinct from `retryPolicy` which
 * is a coarse classifier-level policy; `recoveryDisposition` is the
 * occurrence-aware, model-facing instruction.
 *
 * - `correct_once`: Emit one corrected call, then continue the task.
 * - `discard_duplicate`: Do not resend the malformed sibling; continue from
 *   the retained result.
 * - `change_strategy`: Do not repeat the same fingerprint; continue with a
 *   different action or tool.
 * - `await_user`: No automatic retry. Reserved for genuine policy or
 *   authorization boundaries.
 */
export type RecoveryDisposition = "await_user" | "change_strategy" | "correct_once" | "discard_duplicate"

export type ErrorSeverity = "error" | "warning"

export type ErrorType = "guided_runtime_error" | "guided_tool_error"

export interface InterceptionSignal {
	/** Where the signal came from. */
	source: ErrorSource
	/** Execution stage when the signal was raised. */
	stage: ErrorStage
	/** Task ID; never forwarded to the model payload. */
	taskId: string
	/** Tool call ID, present when the signal is tool-bound. */
	toolCallId?: string
	/** Tool name; may be a core ToolName or a dynamic MCP tool name. */
	toolName?: string
	/** Raw error object, for UI/diagnostics only. */
	error?: unknown
	/** Legacy/direct result value for compatibility inspection. */
	result?: ToolResponse
	/**
	 * Structured metadata. Fields are intentionally conservative: error codes,
	 * parameter names, counts, server/tool identifiers, and flags. No raw text
	 * values such as command lines, absolute paths, or argument bodies are
	 * allowed here.
	 */
	metadata: Readonly<Record<string, unknown>>
}

/**
 * Minimal subset of ToolResponse used for structured result inspection.
 * Kept intentionally loose to avoid importing concrete tool types.
 */
export interface ToolResponse {
	type?: string
	status?: string
	error?: unknown
	text?: string
	toolUseId?: string
	[key: string]: unknown
}

export interface ErrorClassification {
	category: ErrorCategory
	patternId: string
	confidence: ConfidenceLevel
	retryPolicy: RetryPolicy
	facts: Readonly<Record<string, unknown>>
}

export interface PatternTemplate {
	what: string
	why: string
	next: string[]
}

/**
 * Occurrence-aware template. When present, the renderer selects the branch
 * matching the current occurrence count (1 = first failure, 2 = repeated
 * identical failure, 3+ = stuck loop). Each branch carries its own
 * `what`/`why`/`next` so the model sees distinct, escalating guidance
 * instead of the same prose repeated indefinitely.
 */
export interface OccurrenceTemplate {
	/** Occurrence 1: first failure. */
	first: PatternTemplate
	/** Occurrence 2: repeated identical failure. */
	repeated: PatternTemplate
	/** Occurrence 3+: stuck loop. */
	stuck: PatternTemplate
}

export interface ErrorPattern {
	id: string
	category: ErrorCategory
	priority: number
	template: PatternTemplate
	/**
	 * Optional occurrence-aware templates. When present, the renderer uses
	 * `first` for occurrence 1, `repeated` for occurrence 2, and `stuck` for
	 * occurrence 3+. When absent, the renderer derives occurrence-aware
	 * variants from the base `template` using default escalation rules.
	 */
	occurrenceTemplates?: OccurrenceTemplate
	retryPolicy: RetryPolicy
	severity: ErrorSeverity
	/**
	 * Occurrence-aware recovery disposition. When present, the renderer
	 * selects the disposition matching the current occurrence. When absent,
	 * the renderer infers a default from `retryPolicy` and `category`.
	 */
	recoveryDispositions?: {
		first: RecoveryDisposition
		repeated: RecoveryDisposition
		stuck: RecoveryDisposition
	}
	/** True when the pattern requires a tool-call context to match. */
	requiresToolContext?: boolean
	/**
	 * Exact structural check: source, stage, metadata fields, and optional
	 * structured result status/type. When a check returns true, the pattern is
	 * selected without further inspection.
	 */
	matches: (signal: InterceptionSignal) => boolean
	/**
	 * Heuristic fallback check. Used only when no exact pattern matches. It
	 * must be conservative; success output must never be reclassified as an
	 * error.
	 */
	fallback?: (signal: InterceptionSignal) => boolean
}

export interface GuidancePayload {
	version: 1
	status: ErrorSeverity
	type: ErrorType
	category: ErrorCategory
	what: string
	why: string
	next: string[]
	retryable: boolean
	occurrence: number
	pattern_id: string
	/**
	 * Occurrence-aware recovery disposition. Tells the model how to proceed
	 * with the failed invocation and the overall task. Rendered as a
	 * `Disposition:` line in the `<error_details>` block.
	 */
	recovery_disposition: RecoveryDisposition
}

export interface TransformOptions {
	/** Default 1; provided by the interceptor state machine. */
	occurrence?: number
	/** Hard byte limit for the encoded JSON. Default 1024. */
	byteLimit?: number
}

export interface ClassifyOptions {
	/**
	 * Optional context from the existing execution environment. Reserved for
	 * future expansion; must not be used to inject locale-dependent text.
	 */
	context?: Record<string, unknown>
}
