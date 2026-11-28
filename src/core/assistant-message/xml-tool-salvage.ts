/**
 * XML tool-call salvage (issue #547, defect 4).
 *
 * Under load, tool-calling models occasionally answer with tool-shaped XML in
 * plain text (e.g. `<read_file><path>src/config.ts</path></read_file>`)
 * instead of a native `tool_calls` structure. Native-only pipelines treat that
 * text as prose, no tool executes, and the turn deadlocks on
 * "model did not call any tools".
 *
 * The salvage scanner is deliberately conservative: it only accepts text that
 * consists ENTIRELY of one or more consecutive, well-formed, two-level tool
 * blocks. Anything else - prose around the XML, attributes, nested same-name
 * tool blocks, comments, unknown syntax - returns null and the caller keeps the text as
 * plain text (the pre-existing behavior). Validation of the tool name and
 * parameter names stays with the production parser
 * (NativeToolCallParser.parseToolCall); this module only recognizes shapes.
 *
 * MCP tool names (mcp--server--tool / mcp__server__tool) are excluded: they
 * need a live MCP connection, and salvaging them would turn silent text into
 * connection errors.
 */

export interface SalvagedXmlToolCall {
	name: string
	args: Record<string, string>
}

/** Upper bound on blocks promoted from one response; more is a syntax storm, not a tool call. */
export const MAX_SALVAGED_TOOL_CALLS = 8

function isTagNameStart(char: string): boolean {
	return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z")
}

function isTagNameChar(char: string): boolean {
	return isTagNameStart(char) || (char >= "0" && char <= "9") || char === "_" || char === "-" || char === "."
}

function isParamNameStart(char: string): boolean {
	return isTagNameStart(char) || char === "_"
}

function isMcpToolName(name: string): boolean {
	return name.startsWith("mcp--") || name.startsWith("mcp__")
}

/** The five predefined XML entities, matched as prefixes at the current position. */
const XML_ENTITY_DECODES: ReadonlyArray<readonly [string, string]> = [
	["&lt;", "<"],
	["&gt;", ">"],
	["&quot;", '"'],
	["&apos;", "'"],
	["&amp;", "&"],
]

/**
 * Decodes the five predefined XML entities in one pass; unknown text stays
 * as-is. An entity is recognized only when it starts AT the current
 * ampersand: any other ampersand is preserved and the scan moves one
 * character forward, so a supported entity after a raw ampersand still
 * decodes ("x && y &lt; z" -> "x && y < z", issue #547 review 4716476962)
 * and no suffix search runs per ampersand — a value of many bare ampersands
 * stays linear instead of quadratic (issue #547 review 4716476967).
 * Decoding is single-pass: "&amp;lt;" yields "&lt;", never "<".
 */
function decodeXmlEntities(value: string): string {
	let out = ""
	for (let i = 0; i < value.length;) {
		const char = value[i]
		if (char !== "&") {
			out += char
			i++
			continue
		}
		const decoded = XML_ENTITY_DECODES.find(([entity]) => value.startsWith(entity, i))
		if (decoded) {
			out += decoded[1]
			i += decoded[0].length
		} else {
			// Not a supported entity: keep the ampersand and move on, so a
			// later supported entity is still matched at its own position.
			out += char
			i++
		}
	}
	return out
}

interface ScannerState {
	text: string
	pos: number
}

function skipWhitespace(state: ScannerState): void {
	while (state.pos < state.text.length && /\s/.test(state.text[state.pos])) {
		state.pos++
	}
}

function expectLiteral(state: ScannerState, literal: string): boolean {
	if (state.text.startsWith(literal, state.pos)) {
		state.pos += literal.length
		return true
	}
	return false
}

/**
 * Reads `<name>` and returns the tag name, or null when the next token is not
 * an attribute-free open tag. Self-closing and attributed tags are rejected.
 */
function readOpenTag(state: ScannerState): string | null {
	if (!expectLiteral(state, "<")) {
		return null
	}
	if (!isTagNameStart(state.text[state.pos] ?? "")) {
		return null
	}
	let name = ""
	while (state.pos < state.text.length && isTagNameChar(state.text[state.pos])) {
		name += state.text[state.pos]
		state.pos++
	}
	if (name.length === 0 || !expectLiteral(state, ">")) {
		return null
	}
	return name
}

function readCloseTag(state: ScannerState, name: string): boolean {
	return expectLiteral(state, `</${name}>`)
}

/**
 * Parses one `<tool><param>value</param>...</tool>` block starting at
 * state.pos. On success the calls array gains one entry and state.pos moves
 * past the closing tag. Returns false on any structural deviation.
 */
function readToolBlock(state: ScannerState, calls: SalvagedXmlToolCall[]): boolean {
	const name = readOpenTag(state)
	if (name === null || isMcpToolName(name)) {
		return false
	}

	const args: Record<string, string> = {}
	skipWhitespace(state)

	while (state.pos < state.text.length && !state.text.startsWith(`</${name}>`, state.pos)) {
		const paramName = readOpenTag(state)
		if (paramName === null || !isParamNameStart(paramName[0])) {
			return false
		}
		const closeTag = `</${paramName}>`
		const closeIndex = state.text.indexOf(closeTag, state.pos)
		if (closeIndex === -1) {
			return false
		}
		const rawValue = state.text.slice(state.pos, closeIndex)
		if (paramName === name && rawValue.trimStart().startsWith("<")) {
			// A same-name child whose payload opens another element is a
			// nested invocation attempt, not a two-level parameter; the
			// scanner only recognizes two-level tool XML, so the whole text
			// stays unsalvaged (issue #547 review round 2026-11-26). A
			// same-name child with a plain value (the skill tool's skill
			// argument) is still an ordinary parameter.
			return false
		}
		args[paramName] = decodeXmlEntities(rawValue)
		state.pos = closeIndex + closeTag.length
		skipWhitespace(state)
	}

	if (!readCloseTag(state, name)) {
		return false
	}

	calls.push({ name, args })
	return calls.length <= MAX_SALVAGED_TOOL_CALLS
}

/**
 * Attempts to salvage tool calls from a completed assistant response.
 *
 * Returns the parsed calls when the ENTIRE text is a sequence of well-formed
 * tool XML blocks (whitespace allowed between and around them), otherwise
 * null. Never throws; never mutates its input.
 */
export function salvageXmlToolCalls(text: string): SalvagedXmlToolCall[] | null {
	const trimmed = text.trim()
	if (trimmed.length === 0) {
		return null
	}

	const state: ScannerState = { text: trimmed, pos: 0 }
	const calls: SalvagedXmlToolCall[] = []
	skipWhitespace(state)

	while (state.pos < state.text.length) {
		if (!readToolBlock(state, calls)) {
			return null
		}
		skipWhitespace(state)
	}

	if (calls.length === 0) {
		return null
	}

	return calls
}
