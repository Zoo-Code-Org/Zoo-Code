import { isValidIdentifier } from "./ErrorClassifier"
import {
	ERROR_PATTERNS,
	GUIDANCE_VERSION,
	MODEL_PAYLOAD_BYTE_LIMIT,
	NEXT_ITEM_CHAR_LIMIT,
	NEXT_ITEM_COUNT_LIMIT,
} from "./errorPatterns"
import type {
	ErrorCategory,
	ErrorClassification,
	ErrorSource,
	GuidancePayload,
	PatternTemplate,
	RecoveryDisposition,
	TransformOptions,
} from "./types"

// ---------------------------------------------------------------------------
// Category → User-Friendly Title mapping
// ---------------------------------------------------------------------------

/**
 * Maps each ErrorCategory to a concise, user-friendly title suitable for
 * display in the chat UI via `cline.say("error", ...)`.
 */
const CATEGORY_TITLES: Record<ErrorCategory, string> = {
	CONTEXT_OVERFLOW: "Context Window Exceeded",
	DIFF_MATCH_FAILED: "Edit Unsuccessful",
	DUPLICATE_CALL: "Duplicate Tool Call",
	FILE_NOT_FOUND: "File Not Found",
	FILE_RESTRICTION: "File Access Blocked",
	INVALID_JSON_ARGUMENTS: "Invalid Arguments",
	INVALID_TOOL_PROTOCOL: "Tool Protocol Error",
	MCP_TOOL_MISSING: "Tool Not Available",
	MODE_RESTRICTION: "Mode Restriction",
	PARAM_MISSING: "Missing Parameter",
	PARAM_TYPE_MISMATCH: "Tool Call Format Error",
	PARSER_FAILURE_INVALID_SHAPE: "Invalid Argument Shape",
	PARSER_FAILURE_JSON_SYNTAX: "JSON Syntax Error",
	PARSER_FAILURE_MISSING_ARGS: "Missing Required Arguments",
	SHELL_INTEGRATION: "Terminal Error",
	TOOL_NOT_FOUND: "Unknown Tool",
	UNCLASSIFIED: "Unexpected Error",
}

/**
 * Returns the user-friendly title for a given error category.
 * Falls back to "Unexpected Error" for unknown categories.
 */
export function getCategoryTitle(category: ErrorCategory): string {
	return CATEGORY_TITLES[category] ?? "Unexpected Error"
}

/**
 * Extracts the ErrorCategory from a guided message string produced by
 * `transformErrorToMessage()`. Returns `undefined` if the category line
 * cannot be found.
 */
export function extractCategoryFromGuided(message: string): ErrorCategory | undefined {
	const match = message.match(/^Category: (.+)$/m)
	if (!match) return undefined
	return match[1].trim() as ErrorCategory
}

/**
 * Returns the user-friendly title for a guided message string, or
 * `"Error"` if the category cannot be extracted.
 */
export function getErrorTitleFromGuided(message: string | undefined): string {
	if (!message) return "Error"
	const category = extractCategoryFromGuided(message)
	return category ? getCategoryTitle(category) : "Error"
}

// ---------------------------------------------------------------------------
// Payload building
// ---------------------------------------------------------------------------

function countUtf8Bytes(text: string): number {
	return new TextEncoder().encode(text).length
}

function clampNextItems(next: string[]): string[] {
	const clamped: string[] = []
	for (const item of next) {
		if (clamped.length >= NEXT_ITEM_COUNT_LIMIT) break
		let candidate = item
		if (candidate.length > NEXT_ITEM_CHAR_LIMIT) {
			candidate = candidate.slice(0, NEXT_ITEM_CHAR_LIMIT)
		}
		candidate = candidate.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
		if (candidate.length === 0) continue
		clamped.push(candidate)
	}
	return clamped
}

function isRetryable(retryPolicy: ErrorClassification["retryPolicy"], category: ErrorCategory): boolean {
	if (category === "DUPLICATE_CALL" || category === "INVALID_TOOL_PROTOCOL") return false
	if (retryPolicy === "do-not-retry") return false
	if (retryPolicy === "auto-recover") return true
	return true
}

function payloadType(source: ErrorSource | undefined): GuidancePayload["type"] {
	return source === "api_request" ? "guided_runtime_error" : "guided_tool_error"
}

function resolvePattern(patternId: string) {
	return ERROR_PATTERNS.find((p) => p.id === patternId)
}

function resolveTemplate(patternId: string): PatternTemplate {
	const pattern = resolvePattern(patternId)
	if (!pattern) {
		return {
			what: "The tool or request failed with a recognized error.",
			why: "The failure matches a known pattern.",
			next: [] as string[],
		}
	}
	return pattern.template
}

// ---------------------------------------------------------------------------
// Occurrence-aware template selection
// ---------------------------------------------------------------------------

/**
 * Derives a default occurrence-aware template from a base template when the
 * pattern does not define explicit `occurrenceTemplates`.
 *
 * Escalation rules:
 * - Occurrence 1 (first): use the base template as-is.
 * - Occurrence 2 (repeated): state the same shape was emitted again; instruct
 *   the model not to repeat the prior arguments and to continue the task.
 * - Occurrence 3+ (stuck): direct the model to change strategy before the
 *   next tool call and continue from retained results.
 */
function deriveOccurrenceTemplate(base: PatternTemplate, occurrence: number): PatternTemplate {
	if (occurrence <= 1) return base

	if (occurrence === 2) {
		return {
			what: "The same failure shape was emitted again.",
			why: "Retrying the same fingerprint cannot add new information.",
			next: [
				"Emit no duplicate call now; continue from the retained result.",
				"Choose a different tool or input if the retained result is insufficient.",
			],
		}
	}

	return {
		what: "The same failure shape keeps being emitted.",
		why: "The loop has not advanced despite prior guidance.",
		next: [
			"Change strategy before the next tool call; do not repeat the same fingerprint.",
			"Continue the task from retained results or pick a different action.",
		],
	}
}

/**
 * Selects the occurrence-appropriate template for a pattern. If the pattern
 * defines explicit `occurrenceTemplates`, the matching branch is used.
 * Otherwise, a default is derived from the base template.
 */
function selectOccurrenceTemplate(patternId: string, occurrence: number): PatternTemplate {
	const pattern = resolvePattern(patternId)
	if (!pattern) return resolveTemplate(patternId)

	const base = pattern.template

	if (pattern.occurrenceTemplates) {
		if (occurrence <= 1) return pattern.occurrenceTemplates.first
		if (occurrence === 2) return pattern.occurrenceTemplates.repeated
		return pattern.occurrenceTemplates.stuck
	}

	return deriveOccurrenceTemplate(base, occurrence)
}

/**
 * Selects the occurrence-appropriate recovery disposition. If the pattern
 * defines explicit `recoveryDispositions`, the matching branch is used.
 * Otherwise, a default is inferred from `retryPolicy` and `category`.
 */
function selectRecoveryDisposition(
	patternId: string,
	occurrence: number,
	retryPolicy: ErrorClassification["retryPolicy"],
	category: ErrorCategory,
): RecoveryDisposition {
	const pattern = resolvePattern(patternId)

	if (pattern?.recoveryDispositions) {
		if (occurrence <= 1) return pattern.recoveryDispositions.first
		if (occurrence === 2) return pattern.recoveryDispositions.repeated
		return pattern.recoveryDispositions.stuck
	}

	// Default inference from retryPolicy and category.
	if (occurrence >= 3) return "change_strategy"

	if (category === "DUPLICATE_CALL") return "discard_duplicate"
	if (category === "INVALID_TOOL_PROTOCOL") return "discard_duplicate"

	if (retryPolicy === "do-not-retry") return "discard_duplicate"
	if (retryPolicy === "auto-recover") return "correct_once"
	if (retryPolicy === "alternate-tool") return "correct_once"
	// correct-and-retry
	return "correct_once"
}

function buildPayload(classification: ErrorClassification, occurrence: number): GuidancePayload {
	const { category, patternId, retryPolicy, facts } = classification
	const occ = Math.max(1, occurrence)
	const template = selectOccurrenceTemplate(patternId, occ)

	let what = template.what
	let next = template.next

	// Inject extracted parameter name into guidance for PARAM_MISSING and
	// generic PARAM_TYPE_MISMATCH patterns.
	//
	// Defense-in-depth: revalidate the parameter name here even though
	// ErrorClassifier already filters it. The facts object could originate
	// from a different caller or a future code path, so we must never
	// interpolate an untrusted value into model-facing guidance text.
	// If the name fails validation, we omit it entirely and fall back to
	// the generic category template — we do NOT escape and partially
	// preserve attacker-controlled values.
	//
	// Parameter name injection only applies at occurrence 1 (first failure).
	// At occurrence 2+, the model has already seen the parameter-specific
	// guidance and the focus shifts to "stop repeating the same shape."
	const paramName = facts["parameterName"]
	if (occ <= 1 && typeof paramName === "string" && isValidIdentifier(paramName)) {
		if (category === "PARAM_MISSING") {
			what = `Required parameter '${paramName}' is missing.`
			next = [
				`Provide a valid value for '${paramName}' in a single corrected native tool call, then continue the task.`,
				"Retry only once with the complete parameter set.",
			]
		} else if (category === "PARAM_TYPE_MISMATCH" && patternId === "EI/PARAM_TYPE_MISMATCH/001") {
			what = `Parameter '${paramName}' has a type that does not match the tool schema.`
			next = [
				`Correct the '${paramName}' field type and re-emit one corrected tool call, then continue the task.`,
				"Keep the rest of the parameters unchanged.",
			]
		}
	}

	const recoveryDisposition = selectRecoveryDisposition(patternId, occ, retryPolicy, category)

	return {
		version: GUIDANCE_VERSION,
		status: "error",
		type: payloadType(classification.facts["errorSource"] as ErrorSource | undefined),
		category,
		what,
		why: template.why,
		next: clampNextItems(next),
		retryable: isRetryable(retryPolicy, category),
		occurrence: occ,
		pattern_id: patternId,
		recovery_disposition: recoveryDisposition,
	}
}

// ---------------------------------------------------------------------------
// Serialization: <error_details> format (human-readable + AI-parseable)
// ---------------------------------------------------------------------------

/**
 * Formats a GuidancePayload as a human-readable `<error_details>` block.
 *
 * The format is:
 * ```
 * <error_details>
 * Type: guided_tool_error
 * Category: PARAM_TYPE_MISMATCH
 * What: ...
 * Why: ...
 * Next:
 * 1. ...
 * 2. ...
 * 3. ...
 * Retryable: true
 * Disposition: correct_once
 * Pattern: EI/PARAM_TYPE_MISMATCH/002
 * Occurrence: 1
 * </error_details>
 * ```
 *
 * This format is:
 * - Readable by humans in the UI
 * - Efficiently parseable by the AI model (structured tags)
 * - Consistent across all error patterns
 */
function formatPayloadAsDetails(payload: GuidancePayload): string {
	const lines: string[] = [
		"<error_details>",
		`Type: ${payload.type}`,
		`Category: ${payload.category}`,
		`What: ${payload.what}`,
		`Why: ${payload.why}`,
	]

	if (payload.next.length > 0) {
		lines.push("Next:")
		for (let i = 0; i < payload.next.length; i++) {
			lines.push(`${i + 1}. ${payload.next[i]}`)
		}
	}

	lines.push(`Retryable: ${payload.retryable ? "true" : "false"}`)
	lines.push(`Disposition: ${payload.recovery_disposition}`)
	lines.push(`Pattern: ${payload.pattern_id}`)
	lines.push(`Occurrence: ${payload.occurrence}`)
	lines.push("</error_details>")

	return lines.join("\n")
}

function truncateString(text: string, maxBytes: number): string {
	if (countUtf8Bytes(text) <= maxBytes) return text

	let low = 0
	let high = text.length
	while (low < high) {
		const mid = Math.floor((low + high + 1) / 2)
		if (countUtf8Bytes(text.slice(0, mid)) <= maxBytes) {
			low = mid
		} else {
			high = mid - 1
		}
	}

	let result = text.slice(0, low)
	result = result.replace(/[\ud800-\udbff]$/, "")
	return result
}

/**
 * Formats the payload as `<error_details>` and ensures the result fits
 * within `byteLimit` UTF-8 bytes.
 *
 * Truncation priority (preserve most important fields first):
 * 1. Category, Occurrence, Retryable, Disposition, Pattern — always preserved.
 * 2. First continuation action (Next item 1) — preserved before secondary
 *    explanation.
 * 3. Why — truncated before What when space is tight, since What carries the
 *    structural fact the model needs most.
 * 4. What — truncated last among content fields.
 * 5. Additional Next items — removed from the end first.
 */
function fitDetailsWithinByteLimit(payload: GuidancePayload, byteLimit: number): string {
	const fullDetails = formatPayloadAsDetails(payload)
	if (countUtf8Bytes(fullDetails) <= byteLimit) return fullDetails

	let candidate = { ...payload }
	const type = payload.type

	// Phase 1: Remove Next items from the end, but always try to keep at
	// least the first continuation action.
	for (let nextCount = payload.next.length; nextCount >= 1; nextCount--) {
		candidate = {
			...candidate,
			next: payload.next.slice(0, nextCount),
		}

		let details = formatPayloadAsDetails(candidate)
		if (countUtf8Bytes(details) <= byteLimit) return details

		// Phase 2: Truncate Why before What (What carries the structural fact).
		for (const targetBytes of [80, 50, 30]) {
			candidate = { ...candidate, why: truncateString(candidate.why, targetBytes) }
			details = formatPayloadAsDetails(candidate)
			if (countUtf8Bytes(details) <= byteLimit) return details
		}

		// Phase 3: Truncate What.
		for (const targetBytes of [120, 80, 50, 30]) {
			candidate = { ...candidate, what: truncateString(candidate.what, targetBytes) }
			details = formatPayloadAsDetails(candidate)
			if (countUtf8Bytes(details) <= byteLimit) return details
		}
	}

	// Phase 4: Drop all Next items entirely.
	candidate = { ...candidate, next: [] }
	let details = formatPayloadAsDetails(candidate)
	if (countUtf8Bytes(details) <= byteLimit) return details

	// Phase 5: Truncate Why and What to minimal.
	for (const targetBytes of [50, 30, 10]) {
		candidate = { ...candidate, why: truncateString(candidate.why, targetBytes) }
		details = formatPayloadAsDetails(candidate)
		if (countUtf8Bytes(details) <= byteLimit) return details
	}
	for (const targetBytes of [50, 30, 10]) {
		candidate = { ...candidate, what: truncateString(candidate.what, targetBytes) }
		details = formatPayloadAsDetails(candidate)
		if (countUtf8Bytes(details) <= byteLimit) return details
	}

	// Phase 6: Absolute minimal payload — preserve category, occurrence,
	// retry scope, and disposition only.
	const minimal: GuidancePayload = {
		version: GUIDANCE_VERSION,
		status: "error",
		type,
		category: payload.category,
		what: "Error.",
		why: "Error.",
		next: [],
		retryable: payload.retryable,
		occurrence: payload.occurrence,
		pattern_id: payload.pattern_id,
		recovery_disposition: payload.recovery_disposition,
	}
	return formatPayloadAsDetails(minimal)
}

/**
 * Transform a classification into a bounded, model-facing `<error_details>`
 * string.
 *
 * The result is guaranteed to be valid UTF-8 with total byte length <=
 * byteLimit (default 1,024). It never contains raw errors, stacks, command
 * text, absolute paths, or secrets.
 */
export function transformErrorToMessage(classification: ErrorClassification, options?: TransformOptions): string {
	const occurrence = Math.max(1, options?.occurrence ?? 1)
	const byteLimit = options?.byteLimit ?? MODEL_PAYLOAD_BYTE_LIMIT

	const payload = buildPayload(classification, occurrence)
	return fitDetailsWithinByteLimit(payload, byteLimit)
}

/**
 * Formats a guided error details block from individual fields, without
 * going through the classification pipeline. Used by callers that need to
 * produce a details block with custom content (e.g. circuit-open messages).
 */
export function formatErrorDetails(
	category: ErrorCategory,
	type: GuidancePayload["type"],
	what: string,
	why: string,
	next: string[],
	retryable: boolean,
	occurrence: number,
	patternId: string,
	recoveryDisposition: RecoveryDisposition = "correct_once",
): string {
	const payload: GuidancePayload = {
		version: GUIDANCE_VERSION,
		status: "error",
		type,
		category,
		what,
		why,
		next: clampNextItems(next),
		retryable,
		occurrence: Math.max(1, occurrence),
		pattern_id: patternId,
		recovery_disposition: recoveryDisposition,
	}
	return formatPayloadAsDetails(payload)
}

/** Convenience helper to encode a string into UTF-8 bytes for length checks. */
export function encodeUtf8Bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

export function getPayloadByteLength(text: string): number {
	return encodeUtf8Bytes(text).length
}
