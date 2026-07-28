import type { InterceptionSignal } from "./types"

/**
 * Pure structural validators for native tool arguments.
 *
 * These validators run after the native parser has produced final arguments
 * and before tool approval/execution. They never mutate input, never push
 * results, and never read Task state. Each function returns either an
 * InterceptionSignal describing a sanitized structural issue, or null when
 * the input is structurally acceptable.
 *
 * Sanitization contract: signals carry only structural identifiers (variant
 * name, parameter key, expected/actual type, nested tool signature). Raw
 * argument values, command bodies, absolute paths, and file contents are
 * never copied into signal metadata.
 */

/** Variant emitted when execute_command.cwd is present but not a string. */
export const VARIANT_CWD_OBJECT_MISUSE = "CWD_OBJECT_MISUSE"

/** Variant emitted when a scalar parameter contains a nested tool input object. */
export const VARIANT_NESTED_PARAM_OVERFLOW = "NESTED_PARAM_OVERFLOW"

/** Maximum recursion depth for nested-tool detection. */
export const NESTED_DETECTION_MAX_DEPTH = 4

/** Maximum number of nodes visited during nested-tool detection. */
export const NESTED_DETECTION_MAX_NODES = 64

/**
 * Parameters that legitimately accept non-string/object values and are
 * excluded from nested-tool detection. These are the known structural
 * exceptions where an object value is part of the declared schema.
 */
const OBJECT_ALLOWED_PARAMETERS: Readonly<Record<string, ReadonlySet<string>>> = {
	read_file: new Set(["indentation"]),
	use_mcp_tool: new Set(["arguments"]),
}

/**
 * Known tool-shaped signatures. A nested object is treated as a tool input
 * only when it contains at least one of these key sets. Matching requires
 * all listed keys to be present in the same object.
 */
const TOOL_SIGNATURE_KEY_SETS: ReadonlyArray<ReadonlyArray<string>> = [
	["command"],
	["path", "regex"],
	["query", "path"],
	["server_name", "tool_name"],
	["path", "content"],
	["pattern", "file_pattern"],
]

/**
 * Recognized parameter keys used for the "multiple known keys from a
 * different invocation" heuristic. Two or more of these keys appearing
 * together inside a nested object is treated as a tool input signature.
 */
const KNOWN_PARAMETER_KEYS: ReadonlySet<string> = new Set([
	"command",
	"cwd",
	"path",
	"regex",
	"file_pattern",
	"query",
	"content",
	"diff",
	"pattern",
	"server_name",
	"tool_name",
	"arguments",
	"uri",
	"line_number",
	"offset",
	"limit",
	"mode",
	"prompt",
	"slug",
	"name",
	"message",
	"todos",
])

interface CwdValidationFacts {
	parameter: "cwd"
	expectedType: "string"
	actualType: "array" | "object" | "number" | "boolean" | "null"
}

function classifyActualType(
	value: unknown,
): CwdValidationFacts["actualType"] | "string" | "undefined" | "function" | "symbol" | "bigint" {
	if (value === null) return "null"
	if (Array.isArray(value)) return "array"
	const t = typeof value
	if (
		t === "object" ||
		t === "number" ||
		t === "boolean" ||
		t === "string" ||
		t === "undefined" ||
		t === "function" ||
		t === "symbol" ||
		t === "bigint"
	) {
		return t
	}
	return "object"
}

function buildSignal(
	source: InterceptionSignal["source"],
	stage: InterceptionSignal["stage"],
	toolName: string | undefined,
	metadata: Readonly<Record<string, unknown>>,
): InterceptionSignal {
	return {
		source,
		stage,
		taskId: "",
		toolName,
		metadata,
	}
}

/**
 * Validates the `cwd` parameter of an `execute_command` invocation.
 *
 * Returns a signal with variant CWD_OBJECT_MISUSE when `cwd` is present and
 * is not a string. Empty strings and missing values are accepted (the
 * downstream tool treats them as "use workspace default").
 *
 * The validator is tool-agnostic: callers should only invoke it for
 * `execute_command`. It does not check the tool name itself.
 */
export function validateCwdParameter(args: Record<string, unknown>, toolName?: string): InterceptionSignal | null {
	if (!("cwd" in args)) {
		return null
	}
	const cwd = args.cwd
	if (cwd === undefined || typeof cwd === "string") {
		return null
	}
	const actualType = classifyActualType(cwd)
	const metadata: Readonly<Record<string, unknown>> = {
		variant: VARIANT_CWD_OBJECT_MISUSE,
		parameter: "cwd",
		expectedType: "string",
		actualType,
	}
	return buildSignal("validation", "preflight", toolName, metadata)
}

/**
 * Detects the shape of a nested tool invocation inside an object.
 * Returns the matched signature label (for example "command" or
 * "path+regex") or undefined when the object does not look like a tool
 * input.
 */
function detectToolSignature(value: Record<string, unknown>): string | undefined {
	for (const keySet of TOOL_SIGNATURE_KEY_SETS) {
		let allPresent = true
		for (const key of keySet) {
			if (!(key in value)) {
				allPresent = false
				break
			}
		}
		if (allPresent) {
			return keySet.join("+")
		}
	}
	let knownKeyCount = 0
	for (const key of Object.keys(value)) {
		if (KNOWN_PARAMETER_KEYS.has(key)) {
			knownKeyCount += 1
			if (knownKeyCount >= 2) {
				return "multi-known-keys"
			}
		}
	}
	return undefined
}

interface NestedSearchResult {
	found: boolean
	parameter?: string
	signature?: string
	depthExceeded?: boolean
	nodeLimitExceeded?: boolean
	cycleDetected?: boolean
}

function visitNested(
	value: unknown,
	topParameter: string,
	depth: number,
	state: { visited: number; seen: Set<unknown> },
): NestedSearchResult {
	if (value === null || typeof value !== "object") {
		return { found: false }
	}
	if (state.seen.has(value)) {
		return { found: false, cycleDetected: true }
	}
	state.seen.add(value)
	state.visited += 1
	if (state.visited > NESTED_DETECTION_MAX_NODES) {
		return { found: false, nodeLimitExceeded: true }
	}
	if (depth > NESTED_DETECTION_MAX_DEPTH) {
		return { found: false, depthExceeded: true }
	}

	if (Array.isArray(value)) {
		for (const item of value) {
			const nested = visitNested(item, topParameter, depth + 1, state)
			if (nested.found || nested.cycleDetected || nested.depthExceeded || nested.nodeLimitExceeded) {
				return nested
			}
		}
		state.seen.delete(value)
		return { found: false }
	}

	const record = value as Record<string, unknown>
	const signature = detectToolSignature(record)
	if (signature !== undefined) {
		return { found: true, parameter: topParameter, signature }
	}
	for (const child of Object.values(record)) {
		const nested = visitNested(child, topParameter, depth + 1, state)
		if (nested.found || nested.cycleDetected || nested.depthExceeded || nested.nodeLimitExceeded) {
			return nested
		}
	}
	state.seen.delete(value)
	return { found: false }
}

/**
 * Validates that no scalar tool parameter contains a nested tool input
 * object. Detection is bounded (depth 4, 64 visited nodes) and cycle-safe.
 * Parameters explicitly allowed to carry object values (such as
 * `read_file.indentation` and `use_mcp_tool.arguments`) are skipped.
 *
 * Returns a signal with variant NESTED_PARAM_OVERFLOW on detection, or null
 * when every parameter is structurally clean.
 */
export function validateNestedParams(args: Record<string, unknown>, toolName: string): InterceptionSignal | null {
	const allowList = OBJECT_ALLOWED_PARAMETERS[toolName]
	for (const [key, value] of Object.entries(args)) {
		if (allowList && allowList.has(key)) {
			continue
		}
		if (value === null || typeof value !== "object") {
			continue
		}
		const state = { visited: 0, seen: new Set<unknown>() }
		const result = visitNested(value, key, 1, state)
		if (result.found) {
			const metadata: Readonly<Record<string, unknown>> = {
				variant: VARIANT_NESTED_PARAM_OVERFLOW,
				parameter: result.parameter,
				structuralReason: `nested-tool-input:${result.signature}`,
			}
			return buildSignal("validation", "preflight", toolName, metadata)
		}
		if (result.cycleDetected) {
			const metadata: Readonly<Record<string, unknown>> = {
				variant: VARIANT_NESTED_PARAM_OVERFLOW,
				parameter: key,
				structuralReason: "cyclic-structure",
			}
			return buildSignal("validation", "preflight", toolName, metadata)
		}
	}
	return null
}
