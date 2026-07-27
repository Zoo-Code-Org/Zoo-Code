import { ERROR_PATTERNS } from "./errorPatterns"
import type { ClassifyOptions, ErrorClassification, ErrorPattern, InterceptionSignal } from "./types"

// ---------------------------------------------------------------------------
// Safe-identifier validation (prompt-injection prevention)
// ---------------------------------------------------------------------------

const SAFE_IDENTIFIER_RE = /^[a-zA-Z_][\w.]*$/
const MAX_PARAM_NAME_LENGTH = 128

/**
 * Returns `true` only when `name` is a safe identifier suitable for
 * interpolation into model-facing guidance text.
 *
 * Accepts plain identifiers (`path`, `file_pattern`) and dotted member
 * access chains (`options.timeout`). Rejects anything that could carry
 * prompt-injection payloads: newlines, quotes, angle brackets, brackets,
 * shell metacharacters, backslashes, and overlength strings.
 */
export function isValidIdentifier(name: string | undefined): boolean {
	if (typeof name !== "string") return false
	if (name.length === 0 || name.length > MAX_PARAM_NAME_LENGTH) return false
	if (!SAFE_IDENTIFIER_RE.test(name)) return false
	// Reject instruction-like patterns.
	if (/[\n\r"'><\[\]{}()|;`\\]/.test(name)) return false
	return true
}

const SAFE_FACT_KEYS = new Set<string>([
	"category",
	"code",
	"commandSubmitted",
	"contextLengthExceeded",
	"contextOverflow",
	"contextWindowExceeded",
	"errorCode",
	"errorName",
	"errorSource",
	"errorStage",
	"errorType",
	"emptyArguments",
	"fileNotFound",
	"fileRestriction",
	"invalidProtocol",
	"missingNativeArgs",
	"missingParameter",
	"missingRequiredParameters",
	"modeRestriction",
	"parameterName",
	"parseFailureKind",
	"pathEmpty",
	"repetitionCount",
	"retryDisposition",
	"server",
	"shellIntegrationError",
	"status",
	"tool",
	"toolName",
	"type",
	"typeMismatch",
	"unknownTool",
	"validSiblingPresent",
	"xmlToolCall",
])

const SENSITIVE_KEYS = new Set<string>([
	"command",
	"commandText",
	"cwd",
	"env",
	"environmentVariable",
	"path",
	"absolutePath",
	"homePath",
	"apiKey",
	"api_key",
	"token",
	"secret",
	"password",
	"prompt",
	"response",
	"resultText",
	"mcpArguments",
	"arguments",
	"args",
])

function isSafeFactKey(key: string): boolean {
	if (!SAFE_FACT_KEYS.has(key)) return false
	return !SENSITIVE_KEYS.has(key)
}

function hasToolContext(signal: InterceptionSignal): boolean {
	return signal.toolName !== undefined || signal.toolCallId !== undefined
}

/**
 * Extract a parameter name from an error message or result text.
 *
 * Common patterns from tool execution errors:
 * - "Required parameter 'path' is missing"
 * - "The 'path' parameter must be a string"
 * - "Missing required parameter: command"
 * - "parameter 'path' is required"
 */
function extractParameterName(signal: InterceptionSignal): string | undefined {
	// Check metadata first (explicitly provided by the caller).
	const metaName = signal.metadata["parameterName"]
	if (typeof metaName === "string" && metaName.length > 0) return metaName

	// Try to extract from error.message.
	if (signal.error !== null && typeof signal.error === "object") {
		const message = (signal.error as { message?: unknown }).message
		if (typeof message === "string") {
			const name = tryExtractParamNameFromText(message)
			if (name) return name
		}
	}

	// Try to extract from result.text.
	if (typeof signal.result === "object" && signal.result !== null) {
		const text = (signal.result as { text?: unknown }).text
		if (typeof text === "string") {
			const name = tryExtractParamNameFromText(text)
			if (name) return name
		}
	}

	return undefined
}

function tryExtractParamNameFromText(text: string): string | undefined {
	// Pattern: "parameter 'name'" or "parameter \"name\"" or "parameter: name"
	const paramQuoteMatch = text.match(/parameter\s*['"']([^'"']+)['"']/i)
	if (paramQuoteMatch) return paramQuoteMatch[1]

	// Pattern: "Required parameter 'name'" — already covered above, but also
	// try "Missing required parameter: name" (colon-separated, no quotes).
	const colonMatch = text.match(/(?:missing|required)\s+parameter\s*[:\s]+(\w+)/i)
	if (colonMatch) return colonMatch[1]

	// Pattern: "The 'name' parameter must be..." — extract the quoted name
	// before the word "parameter".
	const theParamMatch = text.match(/the\s+['"']([^'"']+)['"']\s+parameter/i)
	if (theParamMatch) return theParamMatch[1]

	return undefined
}

function isEligible(pattern: ErrorPattern, signal: InterceptionSignal): boolean {
	if (pattern.category === "UNCLASSIFIED") return false
	return !pattern.requiresToolContext || hasToolContext(signal)
}

function sanitizeFacts(signal: InterceptionSignal, pattern: ErrorPattern): Readonly<Record<string, unknown>> {
	const facts: Record<string, unknown> = {}

	for (const key of Object.keys(signal.metadata)) {
		if (!isSafeFactKey(key)) continue

		const value = signal.metadata[key]
		if (value === undefined || value === null) continue

		if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
			facts[key] = value
			continue
		}

		// Arrays of primitive tool/server identifiers only.
		if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
			facts[key] = value
		}
	}

	// Validate metadata-provided parameterName through the same
	// safe-identifier check. The loop above copies metadata values
	// verbatim, so an unsafe parameterName from metadata would bypass
	// the extraction-path validation below.
	if (typeof facts.parameterName === "string" && !isValidIdentifier(facts.parameterName)) {
		delete facts.parameterName
	}

	facts.pattern = pattern.id
	facts.category = pattern.category
	facts.errorSource = signal.source

	// Inject extracted parameter name for PARAM_MISSING and generic
	// PARAM_TYPE_MISMATCH patterns so the transformer can include it in
	// guidance messages. Skip the CWD_OBJECT_MISUSE and NESTED_PARAM_OVERFLOW
	// variants — they have their own specific guidance.
	if (
		pattern.category === "PARAM_MISSING" ||
		(pattern.category === "PARAM_TYPE_MISMATCH" && pattern.id === "EI/PARAM_TYPE_MISMATCH/001")
	) {
		if (facts.parameterName === undefined) {
			const paramName = extractParameterName(signal)
			// Only store the parameter name if it passes the safe-identifier
			// check. Untrusted content (file contents, shell/MCP output) can
			// flow through error messages and result text, so we must reject
			// anything that looks like a prompt-injection payload.
			if (paramName !== undefined && isValidIdentifier(paramName)) {
				facts.parameterName = paramName
			}
		}
	}

	return Object.freeze(facts)
}

export function classifyError(signal: InterceptionSignal, _options?: ClassifyOptions): ErrorClassification {
	// First pass: exact/structural matchers only.
	for (const pattern of ERROR_PATTERNS) {
		if (!isEligible(pattern, signal)) continue
		if (pattern.matches(signal)) {
			return {
				category: pattern.category,
				patternId: pattern.id,
				confidence: "exact",
				retryPolicy: pattern.retryPolicy,
				facts: sanitizeFacts(signal, pattern),
			}
		}
	}

	// Second pass: heuristic fallback matchers, excluding the UNCLASSIFIED
	// catch-all at the end of the list.
	for (const pattern of ERROR_PATTERNS) {
		if (!isEligible(pattern, signal)) continue
		if (pattern.fallback?.(signal)) {
			return {
				category: pattern.category,
				patternId: pattern.id,
				confidence: "heuristic",
				retryPolicy: pattern.retryPolicy,
				facts: sanitizeFacts(signal, pattern),
			}
		}
	}

	// UNCLASSIFIED catch-all.
	const fallback = ERROR_PATTERNS[ERROR_PATTERNS.length - 1]
	return {
		category: fallback.category,
		patternId: fallback.id,
		confidence: "heuristic",
		retryPolicy: fallback.retryPolicy,
		facts: sanitizeFacts(signal, fallback),
	}
}

/** Convenience helper to classify a structured tool result directly. */
export function classifyToolResult(
	result: InterceptionSignal["result"],
	taskId: string,
	toolCallId?: string,
): ErrorClassification {
	const metadata: Record<string, unknown> = {}
	if (result && typeof result === "object") {
		if (result.status) metadata.status = result.status
		if (result.type) metadata.type = result.type
	}

	const signal: InterceptionSignal = {
		source: "tool_result",
		stage: "result",
		taskId,
		toolCallId,
		result: result ?? undefined,
		metadata,
	}
	return classifyError(signal)
}
