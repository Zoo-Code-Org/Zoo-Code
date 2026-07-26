import { TelemetryService } from "@roo-code/telemetry"

import type { NativeToolParseFailure } from "./NativeToolCallParser"

/**
 * # Tool Call Retention Policy
 *
 * Pure functions for classifying streamed tool calls and enforcing per-turn
 * call-count limits. These functions are intentionally side-effect-free so
 * they can be unit-tested in isolation and composed into the stream-processing
 * and presentation pipelines without hidden state.
 *
 * ## Ghost Quarantine
 *
 * A "ghost" is a streamed tool call that arrived with a unique stream index/ID
 * but never resolved a tool name and never accumulated any non-whitespace
 * argument bytes. Such calls are transport artifacts, not model intent, and
 * can be silently dropped **before** they are inserted into
 * `assistantMessageContent` or conversation history.
 *
 * A call with a resolved name (even if arguments are `{}`) is NOT a ghost —
 * it is a malformed named call that must receive a `tool_result`.
 * A call with any argument bytes (even without a name) is NOT a ghost — it
 * carries partial model intent and must be retained.
 *
 * ## Max-One Enforcement
 *
 * When the resolved tool-call policy sets `maxCallsPerTurn === 1`, at most
 * one structurally valid call may execute per assistant turn. If two or more
 * valid side-effecting calls arrive, neither auto-executes — both receive
 * error results instructing the model to resubmit a single call. This prevents
 * ambiguous side-effect ordering when a provider violates the single-call
 * contract.
 */

/**
 * Discriminated union describing the disposition of a single streamed tool
 * call after stream completion.
 *
 * - `retain`: The call is structurally valid and may proceed to execution.
 * - `drop-provably-empty`: The call is a transport ghost (no name, no args)
 *   and must be silently removed before history insertion.
 * - `retain-as-error`: The call is named or has argument bytes but is
 *   malformed; it must receive exactly one error `tool_result`.
 */
export type StreamedCallDisposition =
	| { kind: "retain"; callId: string }
	| { kind: "drop-provably-empty"; callId: string; reason: "no-name-and-no-arguments" }
	| { kind: "retain-as-error"; callId: string; failure: NativeToolParseFailure }

/**
 * Input for {@link classifyStreamedCall}.
 */
export interface ClassifyStreamedCallInput {
	/** The tool call identifier from the stream. */
	callId: string
	/** The resolved tool name, or empty/undefined if none arrived. */
	toolName: string | undefined
	/** The full accumulated argument string at stream completion. */
	argumentsAccumulator: string
	/** Whether the stream has ended for this call. Ghosts can only be dropped after stream end. */
	streamEnded: boolean
	/** Optional typed parse failure if the parser already classified this call. */
	parseFailure?: NativeToolParseFailure
}

/**
 * Classify a streamed tool call into its disposition.
 *
 * **Drop criteria (all must hold):**
 * 1. `streamEnded` is true.
 * 2. `toolName` is empty, undefined, or whitespace-only.
 * 3. `argumentsAccumulator` is empty or whitespace-only.
 *
 * If a {@link NativeToolParseFailure} is present, the call is retained as an
 * error (it was named or had argument bytes but failed structural validation).
 *
 * Otherwise the call is retained for normal execution.
 */
export function classifyStreamedCall(input: ClassifyStreamedCallInput): StreamedCallDisposition {
	const { callId, toolName, argumentsAccumulator, streamEnded, parseFailure } = input

	// If the parser already recorded a failure, the call had enough structure
	// to be classified — it is NOT a ghost. Retain it as an error.
	if (parseFailure) {
		return { kind: "retain-as-error", callId, failure: parseFailure }
	}

	// Ghost check: only drop after stream completion, and only when there is
	// no resolved name AND no non-whitespace argument bytes.
	const hasName = toolName !== undefined && toolName.trim().length > 0
	const hasArgs = argumentsAccumulator.trim().length > 0

	if (streamEnded && !hasName && !hasArgs) {
		return {
			kind: "drop-provably-empty",
			callId,
			reason: "no-name-and-no-arguments",
		}
	}

	return { kind: "retain", callId }
}

/**
 * Predicate: true when the disposition is a silent ghost drop.
 */
export function isProvablyEmptyGhost(disposition: StreamedCallDisposition): boolean {
	return disposition.kind === "drop-provably-empty"
}

/**
 * Input for {@link selectExecutableCall}.
 */
export interface SelectExecutableCallInput {
	/** All tool calls in the current assistant turn. */
	calls: Array<{
		/** The tool call identifier. */
		callId: string
		/** The resolved tool name (may be empty for ghosts). */
		toolName: string | undefined
		/** Whether the parser successfully constructed `nativeArgs`. */
		hasNativeArgs: boolean
		/** Whether the block is still partial (streaming in progress). */
		isPartial: boolean
	}>
	/** The resolved max-calls-per-turn limit. */
	maxCallsPerTurn: 1 | "unbounded"
}

/**
 * Result of max-one enforcement selection.
 */
export interface SelectExecutableCallResult {
	/** The call ID that may proceed to execution, or undefined if none. */
	executableCallId: string | undefined
	/** Call IDs that must receive error results instead of executing. */
	rejectedCallIds: string[]
	/** Human-readable reason for the selection (for error messages / telemetry). */
	reason: string
}

/**
 * Under a single-call policy (`maxCallsPerTurn === 1`), select at most one
 * structurally valid call for execution.
 *
 * Rules:
 * - Only non-partial calls with `hasNativeArgs === true` are candidates.
 * - If zero candidates: no call executes (existing error handling covers
 *   malformed calls).
 * - If exactly one candidate: it may execute.
 * - If two or more candidates: **neither auto-executes**. All candidates
 *   receive error results instructing the model to resubmit one call.
 *   This prevents ambiguous side-effect ordering.
 *
 * Under an unbounded policy, all valid calls may execute (returns the first
 * valid call ID with no rejections — the caller processes the rest normally).
 */
export function selectExecutableCall(input: SelectExecutableCallInput): SelectExecutableCallResult {
	const { calls, maxCallsPerTurn } = input

	if (maxCallsPerTurn === "unbounded") {
		// Parallel-capable providers: no local enforcement needed.
		const firstValid = calls.find((c) => c.hasNativeArgs && !c.isPartial)
		return {
			executableCallId: firstValid?.callId,
			rejectedCallIds: [],
			reason: "unbounded-policy",
		}
	}

	// Single-call policy: collect all structurally valid, non-partial calls.
	const validCandidates = calls.filter((c) => c.hasNativeArgs && !c.isPartial)

	if (validCandidates.length === 0) {
		return {
			executableCallId: undefined,
			rejectedCallIds: [],
			reason: "no-valid-candidates",
		}
	}

	if (validCandidates.length === 1) {
		return {
			executableCallId: validCandidates[0].callId,
			rejectedCallIds: [],
			reason: "single-valid-candidate",
		}
	}

	// Two or more valid candidates under single-call policy:
	// execute NEITHER automatically. All receive error results.
	return {
		executableCallId: undefined,
		rejectedCallIds: validCandidates.map((c) => c.callId),
		reason: "multiple-valid-calls-under-single-policy",
	}
}

/**
	* Input for {@link emitGhostDropTelemetry}.
	*/
export interface GhostDropTelemetryInput {
	/** The task identifier. */
	taskId: string
	/** The provider name (e.g. "mimo", "openai"). */
	provider: string
	/** The model ID. */
	model: string
	/** The resolved policy source. */
	policySource: string
	/** The resolved max-calls-per-turn limit. */
	maxCallsPerTurn: 1 | "unbounded"
	/** The resolved enforcement mode. */
	enforcement: string
	/** Total tool calls in the turn (including the ghost). */
	callCount: number
	/** How many ghosts were dropped so far in this turn. */
	ghostDroppedCount: number
	/** How many error results were emitted so far in this turn. */
	errorResultCount: number
	/** What the metadata requested for parallel tool calls. */
	parallelToolCallsRequested: boolean
	/** What was sent to the provider (if known). */
	parallelToolCallsSent?: boolean
}

/**
	* Emit a tool-call enforcement telemetry event for a ghost quarantine drop.
	*
	* **Privacy:** This function emits ONLY counts and metadata. It does NOT
	* emit the call ID, tool name, argument bytes, command strings, file paths,
	* or any raw user data. The ghost's identity is intentionally discarded.
	*
	* This is safe to call from the stream-processing hot path because
	* `TelemetryService.captureEvent` is fire-and-forget (it returns void and
	* queues internally).
	*/
export function emitGhostDropTelemetry(input: GhostDropTelemetryInput): void {
	if (!TelemetryService.hasInstance()) {
		return
	}

	TelemetryService.instance.captureToolCallEnforcement(input.taskId, {
		provider: input.provider,
		model: input.model,
		policySource: input.policySource,
		maxCallsPerTurn: input.maxCallsPerTurn,
		enforcement: input.enforcement,
		callCount: input.callCount,
		ghostDroppedCount: input.ghostDroppedCount,
		errorResultCount: input.errorResultCount,
		parallelToolCallsRequested: input.parallelToolCallsRequested,
		parallelToolCallsSent: input.parallelToolCallsSent,
	})
}

/**
	* Input for {@link emitMaxOneEnforcementTelemetry}.
	*/
export interface MaxOneEnforcementTelemetryInput {
	/** The task identifier. */
	taskId: string
	/** The provider name. */
	provider: string
	/** The model ID. */
	model: string
	/** The resolved policy source. */
	policySource: string
	/** The resolved max-calls-per-turn limit. */
	maxCallsPerTurn: 1 | "unbounded"
	/** The resolved enforcement mode. */
	enforcement: string
	/** Total tool calls in the turn. */
	callCount: number
	/** How many ghosts were dropped in this turn. */
	ghostDroppedCount: number
	/** How many error results were emitted in this turn (including this one). */
	errorResultCount: number
	/** What the metadata requested for parallel tool calls. */
	parallelToolCallsRequested: boolean
	/** What was sent to the provider (if known). */
	parallelToolCallsSent?: boolean
}

/**
	* Emit a tool-call enforcement telemetry event for a max-one rejection.
	*
	* **Privacy:** This function emits ONLY counts and metadata. It does NOT
	* emit the call ID, tool name, argument values, command strings, file paths,
	* or any raw user data.
	*/
export function emitMaxOneEnforcementTelemetry(input: MaxOneEnforcementTelemetryInput): void {
	if (!TelemetryService.hasInstance()) {
		return
	}

	TelemetryService.instance.captureToolCallEnforcement(input.taskId, {
		provider: input.provider,
		model: input.model,
		policySource: input.policySource,
		maxCallsPerTurn: input.maxCallsPerTurn,
		enforcement: input.enforcement,
		callCount: input.callCount,
		ghostDroppedCount: input.ghostDroppedCount,
		errorResultCount: input.errorResultCount,
		parallelToolCallsRequested: input.parallelToolCallsRequested,
		parallelToolCallsSent: input.parallelToolCallsSent,
	})
}
