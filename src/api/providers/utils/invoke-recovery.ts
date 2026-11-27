import type { OpenAI } from "openai"

/**
 * Incremental recovery of pseudo tool-call markup from a text stream.
 *
 * Some local models (see issue #1429) write tool calls as plain text, e.g.
 * `<invoke name="x"><parameter name="p">v</parameter></invoke>`, optionally
 * wrapped in `<function_calls>`...`</function_calls>`. This scanner consumes
 * the content deltas of a streaming response and yields, in arrival order,
 * the text chunks that must reach the user plus the tool calls recovered
 * from that text.
 *
 * Design (independently specified in docs/architecture/tla/OllamaInvokeRecovery.tla):
 * - Text outside a marker candidate is emitted immediately. A hold covers
 *   only the bytes from the first marker candidate to the verdict, so it is
 *   bounded and never buffers the whole response. A block interior is the
 *   one unbounded hold, and a finish flush turns it back into text.
 * - A recovered call is emitted when its block CLOSE resolves, not at the
 *   end of the stream. The caller emits native tool calls on arrival, so
 *   the sink order is resolution order: a native that arrives inside an
 *   open block runs before that block's recovered call, and a block that
 *   closed before a native arrival recovers first.
 * - A block quoted by markdown context (an open fenced code block,
 *   including one inside a block quote container, or an inline code span
 *   open on the opener's line) is never recovered; its bytes flush as
 *   text. An unterminated block or an unknown tool name
 *   also stays text. Wrapper tags are dropped only around a recovered
 *   call, together with the whitespace directly inside the skeleton.
 * - The verdict depends only on the byte content, so any chunking of the
 *   same response yields the same events.
 *
 * Not handled here (deliberate scope): JSON tool-call text, parameter type
 * coercion against the tool schema, multi-line code spans, and narrative
 * quoting cues. Native tool calls never pass through this class; the
 * handler forwards them as they arrive.
 */

export type RecoveryEvent = { kind: "text"; text: string } | { kind: "call"; name: string; arguments: string }

const MARKERS = ["<function_calls>", "</function_calls>", "<invoke>", "</invoke>"] as const

/**
 * An invoke opener that carries a name: `<invoke` followed by one
 * whitespace byte, the same separators INVOKE_OPENER accepts. The
 * nameless `<invoke>` form stays a literal marker above.
 */
const INVOKE_OPENER_MARKER = /^<invoke(?=\s|$)/i

/** The marker classes the scanner can sit on. */
type Marker = (typeof MARKERS)[number] | "invoke-opener"

const WRAPPER_OPEN = "<function_calls>"
const WRAPPER_CLOSE = "</function_calls>"
const INVOKE_CLOSE = "</invoke>"

/**
 * Scanner phases: `safe` emits prose; `opener` sits on a marker candidate;
 * `wrapper` waits for the invoke opener behind a wrapper; `block` holds an
 * open invoke block; `tail` waits for the wrapper close behind a block.
 */
type Phase = "safe" | "opener" | "wrapper" | "block" | "tail"

const INVOKE_OPENER = /^<invoke\s+name\s*=\s*(?:"([^"]*)"|'([^']*)')\s*>/i
const PARAMETER = /<parameter\s+name\s*=\s*(?:"([^"]*)"|'([^']*)')\s*>([\s\S]*?)<\/parameter>/gi

/** True when `text` is a proper prefix of some marker. */
function isMarkerPrefix(text: string): boolean {
	const lower = text.toLowerCase()
	const literal = MARKERS.some((marker) => marker.length > text.length && marker.startsWith(lower))
	return literal || INVOKE_OPENER_MARKER.test(text)
}

/** The complete marker that starts `text`, if any. */
function matchMarker(text: string): Marker | undefined {
	const lower = text.toLowerCase()
	const literal = MARKERS.find((marker) => lower.startsWith(marker))
	if (literal !== undefined) {
		return literal
	}
	return INVOKE_OPENER_MARKER.test(text) ? "invoke-opener" : undefined
}

/** True when a hold must wait for more bytes to decide `text`. */
function couldStartMarker(text: string): boolean {
	return matchMarker(text) !== undefined || isMarkerPrefix(text)
}

/** Length of the longest prefix of `text` that can still grow into a marker. */
function deadCandidateLength(text: string): number {
	let length = 1
	while (length < text.length && isMarkerPrefix(text.slice(0, length + 1))) {
		length++
	}
	return length
}

/** Fenced-code-block state carried across lines. */
interface FenceState {
	char: "`" | "~"
	width: number
}

/**
 * Length of the leading Markdown container prefix of a complete line.
 * CommonMark opens and closes fenced code blocks inside block quotes,
 * where every level contributes up to three indent bytes, a `>` byte,
 * and one optional space.
 */
function containerPrefixEnd(line: string): number {
	const match = /^(?: {0,3}> ?)+/.exec(line)
	return match === null ? 0 : match[0].length
}

export class InvokeRecoveryScanner {
	private readonly toolNames: ReadonlySet<string>
	/** All held bytes, from the marker candidate to the current end. */
	private pending = ""
	/** Bytes of `pending` already consumed by the matched skeleton. */
	private cursor = 0
	private phase: Phase = "safe"
	/** Name of the open block; null outside a known-name block hold. */
	private openName: string | null = null
	/** Fenced block state; an open fence quotes any block. */
	private fence: FenceState | null = null
	/** Bytes of the current (still incomplete) line already consumed. */
	private linePrefix = ""

	constructor(toolNames: ReadonlySet<string>) {
		this.toolNames = toolNames
	}

	/** Consumes one content delta and returns the events it settles. */
	onText(delta: string): RecoveryEvent[] {
		this.pending += delta
		return this.drain()
	}

	/** Flushes everything still held at the end of the stream. */
	finish(): RecoveryEvent[] {
		const events: RecoveryEvent[] = []
		if (this.pending.length > 0) {
			events.push(...this.flush(this.pending.length))
		}
		this.openName = null
		return events
	}

	/** Emits safe prose and resolves every verdict the bytes settle. */
	private drain(): RecoveryEvent[] {
		const events: RecoveryEvent[] = []
		for (;;) {
			if (this.phase === "safe") {
				const start = this.pending.indexOf("<")
				if (start === -1) {
					events.push(...this.flush(this.pending.length))
					return events
				}
				events.push(...this.flush(start))
				if (couldStartMarker(this.pending)) {
					this.phase = "opener"
					continue
				}
				// The '<' cannot open a marker; it is ordinary text.
				events.push(...this.flush(1))
				continue
			}
			const [progress, ...settled] = this.step()
			events.push(...settled)
			if (!progress) {
				return events
			}
		}
	}

	/** Advances the hold one step; returns progress and settled events. */
	private step(): [boolean, ...RecoveryEvent[]] {
		switch (this.phase) {
			case "opener":
				return this.stepOpener()
			case "wrapper":
				return this.stepWrapper()
			case "block":
				return this.stepBlock()
			case "tail":
				return this.stepTail()
			default:
				return [false]
		}
	}

	/** Decides the marker candidate at the hold start. */
	private stepOpener(): [boolean, ...RecoveryEvent[]] {
		const marker = matchMarker(this.pending)
		if (marker === WRAPPER_OPEN) {
			this.advance(marker.length)
			this.phase = "wrapper"
			return [true]
		}
		if (marker === "</invoke>" || marker === WRAPPER_CLOSE || marker === "<invoke>") {
			// A stray closer or a nameless invoke can never be a live call.
			return [true, ...this.flushHead(marker.length)]
		}
		if (marker === "invoke-opener") {
			return this.decideInvokeOpener()
		}
		// Not a complete marker: flush the dead candidate head and re-scan.
		if (!isMarkerPrefix(this.pending)) {
			return [true, ...this.flushHead(deadCandidateLength(this.pending))]
		}
		return [false]
	}

	/** Applies the verdict for a parsed invoke opener at the hold start. */
	private decideInvokeOpener(): [boolean, ...RecoveryEvent[]] {
		const opener = INVOKE_OPENER.exec(this.pending)
		if (!opener) {
			// No closing '>' yet: wait; malformed: flush through the tag.
			if (!this.pending.includes(">")) {
				return [false]
			}
			return [true, ...this.flushHead(this.pending.indexOf(">") + 1)]
		}
		const name = opener[1] ?? opener[2] ?? ""
		if (!this.toolNames.has(name) || this.isQuotedAtOpener()) {
			// Unknown tool or quoted context: the opener region stays text.
			return [true, ...this.flushHead(opener[0].length)]
		}
		this.advance(opener[0].length)
		this.openName = name
		this.phase = "block"
		return [true]
	}

	/** Waits for the invoke opener behind a wrapper opener. */
	private stepWrapper(): [boolean, ...RecoveryEvent[]] {
		const wsEnd = this.leadingWhitespaceEnd()
		const rest = this.pending.slice(wsEnd)
		if (rest.length === 0) {
			return [false]
		}
		if (!couldStartMarker(rest)) {
			// Nothing invoke-shaped can follow the wrapper; the skeleton
			// region plus the killer byte stays text (the byte cannot open
			// a marker, or couldStartMarker would have passed).
			return [true, ...this.flushHead(wsEnd + 1)]
		}
		const opener = INVOKE_OPENER.exec(rest)
		if (!opener) {
			const tagEnd = rest.indexOf(">")
			if (tagEnd === -1) {
				// The tag is still forming; wait for its end.
				return [false]
			}
			// Malformed invoke tag: flush through it and re-scan after.
			return [true, ...this.flushHead(wsEnd + tagEnd + 1)]
		}
		const name = opener[1] ?? opener[2] ?? ""
		if (!this.toolNames.has(name) || this.isQuotedAtOpener()) {
			// Unknown tool or quoted context: the skeleton stays text.
			return [true, ...this.flushHead(wsEnd + opener[0].length)]
		}
		this.advance(wsEnd - this.cursor + opener[0].length)
		this.openName = name
		this.phase = "block"
		return [true]
	}

	/** Holds the block interior until `</invoke>` resolves the verdict. */
	private stepBlock(): [boolean, ...RecoveryEvent[]] {
		// Case-insensitive search on the ORIGINAL string: a lowercased
		// copy can change length (U+0130 lowercases to two code points),
		// which shifts the offset and makes slice/drop cut extra bytes.
		const closeMatch = /<\/invoke>/i.exec(this.pending.slice(this.cursor))
		const closeAt = closeMatch === null ? -1 : this.cursor + closeMatch.index
		if (closeAt === -1) {
			return [false]
		}
		const name = this.openName ?? ""
		const body = this.pending.slice(this.cursor, closeAt)
		const args = parseInvokeParameters(body)
		this.drop(closeAt + INVOKE_CLOSE.length)
		this.phase = "tail"
		return [true, { kind: "call", name, arguments: args }]
	}

	/** Waits for the optional wrapper close behind a recovered block. */
	private stepTail(): [boolean, ...RecoveryEvent[]] {
		const wsEnd = this.leadingWhitespaceEnd()
		const rest = this.pending.slice(wsEnd)
		if (rest.length === 0) {
			return [false]
		}
		const marker = matchMarker(rest)
		if (marker === WRAPPER_CLOSE) {
			this.drop(wsEnd + WRAPPER_CLOSE.length)
			return [true]
		}
		if (marker === undefined && isMarkerPrefix(rest) && rest.length > 0) {
			return [false]
		}
		// No wrapper close follows: back to prose scanning at the cursor.
		this.drop(this.cursor)
		this.phase = "safe"
		return [true]
	}

	/** End of the whitespace run at the cursor. */
	private leadingWhitespaceEnd(): number {
		const match = /^\s*/.exec(this.pending.slice(this.cursor))
		return this.cursor + (match ? match[0].length : 0)
	}

	/** Moves the cursor over consumed skeleton bytes; the bytes stay. */
	private advance(n: number): void {
		this.cursor += n
	}

	/** Silently removes the consumed skeleton bytes before `n`. */
	private drop(n: number): void {
		if (n <= 0) {
			return
		}
		const taken = this.pending.slice(0, n)
		this.pending = this.pending.slice(n)
		this.cursor = Math.max(0, this.cursor - n)
		this.feedContext(taken)
	}

	/** Moves the first `n` bytes of `pending` to the text sink. */
	private flush(n: number): RecoveryEvent[] {
		if (n <= 0) {
			return []
		}
		const text = this.pending.slice(0, n)
		this.pending = this.pending.slice(n)
		this.cursor = Math.max(0, this.cursor - n)
		this.feedContext(text)
		if (this.pending.length === 0) {
			this.phase = "safe"
			this.openName = null
		}
		return [{ kind: "text", text }]
	}

	/** Flushes the dead skeleton head and returns to safe scanning. */
	private flushHead(n: number): RecoveryEvent[] {
		const events = this.flush(n)
		this.phase = "safe"
		return events
	}

	/**
	 * True when markdown context quotes a block at its opener: an open
	 * fenced code block, or an inline code span open at this point of the
	 * current line. CommonMark: a span closes only on a run of the same
	 * width, and fence lines are fence syntax, never span delimiters.
	 */
	private isQuotedAtOpener(): boolean {
		if (this.fence !== null) {
			return true
		}
		let activeWidth = 0
		for (const run of this.linePrefix.matchAll(/`+/g)) {
			const width = run[0].length
			if (activeWidth === 0) {
				activeWidth = width
			} else if (width === activeWidth) {
				activeWidth = 0
			}
		}
		return activeWidth > 0
	}

	/**
	 * Feeds consumed bytes into the markdown context: fence open/close on
	 * complete lines, plus the partial-line carry for span checks. Runs on
	 * every byte leaving `pending`, emitted or swallowed alike.
	 */
	private feedContext(text: string): void {
		let line = this.linePrefix + text
		for (;;) {
			const newline = line.indexOf("\n")
			if (newline === -1) {
				break
			}
			const complete = line.slice(0, newline)
			line = line.slice(newline + 1)
			this.advanceFence(complete)
		}
		this.linePrefix = line
	}

	/** Applies one complete line to the fence state. */
	private advanceFence(line: string): void {
		// Fence detection skips container prefixes: a quoted fence is
		// still a fence, so the block it wraps stays quoted.
		const content = line.slice(containerPrefixEnd(line))
		if (this.fence !== null) {
			const closer = new RegExp(`^ {0,3}${this.fence.char}{${this.fence.width},}\\s*$`)
			if (closer.test(content)) {
				this.fence = null
			}
			return
		}
		const tilde = /^ {0,3}(~{3,})/.exec(content)
		if (tilde) {
			// A tilde fence accepts any info string.
			this.fence = { char: "~", width: tilde[1].length }
			return
		}
		const backtick = /^ {0,3}(`{3,})/.exec(content)
		if (backtick && !content.slice(backtick[0].length).includes("`")) {
			// A backtick fence's info string must contain no backtick.
			this.fence = { char: "`", width: backtick[1].length }
		}
	}
}

/**
 * Parses the `<parameter name="k">v</parameter>` pairs of a block body
 * into a JSON arguments string. Values stay strings; the caller owns the
 * schema typing.
 */
export function parseInvokeParameters(body: string): string {
	const args: Record<string, string> = {}
	for (const match of body.matchAll(PARAMETER)) {
		const key = match[1] ?? match[2] ?? ""
		if (key) {
			args[key] = match[3] ?? ""
		}
	}
	return JSON.stringify(args)
}

/**
 * Collects the offered tool names from request metadata. Recovery stays
 * off when no usable function tool is offered, so plain chat behavior is
 * byte-identical to the unpatched handler.
 */
export function offeredToolNames(tools: OpenAI.Chat.ChatCompletionTool[] | undefined): Set<string> {
	const names = new Set<string>()
	for (const tool of tools ?? []) {
		if (tool?.type === "function" && typeof tool.function?.name === "string" && tool.function.name) {
			names.add(tool.function.name)
		}
	}
	return names
}
