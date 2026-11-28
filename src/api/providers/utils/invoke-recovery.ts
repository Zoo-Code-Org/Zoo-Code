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
 *   including one behind a block-quote or list-item container chain,
 *   or an inline code span open on the opener's line) is never
 *   recovered; its bytes flush as text. An unterminated block, an
 *   unknown tool name, an opener head that can never match the
 *   name-attribute grammar, and a block whose interior the parameter
 *   parser cannot consume completely also stay text. Wrapper tags are
 *   dropped only around a recovered call, together with the whitespace
 *   directly inside the skeleton.
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
const PARAMETER_ANCHORED = /<parameter\s+name\s*=\s*(?:"([^"]*)"|'([^']*)')\s*>([\s\S]*?)<\/parameter>/iy
/** The bytes behind `<invoke` the opener grammar fixes before the value. */
const INVOKE_HEAD = "<invoke"
const NAME_ATTR = "name"

/**
 * True when the bytes behind `<invoke` can still grow into the opener
 * grammar INVOKE_OPENER accepts: whitespace, the `name` attribute, `=`,
 * a quoted value, then optional whitespace and `>`. A byte that
 * contradicts a fixed grammar position (a name that is not `name`, an
 * unquoted value, an unparsable tail) makes the candidate dead: no
 * later byte can complete it, so the hold must not wait for `>`.
 */
function canBecomeInvokeOpener(after: string): boolean {
	let i = 0
	while (i < after.length && /\s/.test(after[i])) {
		i += 1
	}
	for (let k = 0; k < NAME_ATTR.length; k++) {
		if (i >= after.length) {
			return true
		}
		if (after[i].toLowerCase() !== NAME_ATTR[k]) {
			return false
		}
		i += 1
	}
	while (i < after.length && /\s/.test(after[i])) {
		i += 1
	}
	if (i >= after.length) {
		return true
	}
	if (after[i] !== "=") {
		return false
	}
	i += 1
	while (i < after.length && /\s/.test(after[i])) {
		i += 1
	}
	if (i >= after.length) {
		return true
	}
	const quote = after[i]
	if (quote !== '"' && quote !== "'") {
		return false
	}
	const close = after.indexOf(quote, i + 1)
	if (close === -1) {
		return true
	}
	let tail = close + 1
	while (tail < after.length && /\s/.test(after[tail])) {
		tail += 1
	}
	// Past the value only whitespace then `>` can follow; any other
	// byte contradicts the grammar (a `>` here would have matched
	// INVOKE_OPENER, so the full-opener path is not this one).
	return tail >= after.length
}

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
	/** The container prefix the opening fence line carried. */
	container: FenceContainer
}

/**
 * The Markdown container chain a fence lives in, outermost first: a
 * fence can sit in a block quote AND in a list item at once (`> - ~~~`),
 * and the closing fence is read behind the same chain, while an
 * unclosed fence ends when any level of its chain ends. A top-level
 * fence has no levels, so a quote-prefixed line inside it is literal
 * content, never a closer.
 */
type FenceContainer =
	{ kind: "none" } | { kind: "quote"; depth: number; inner: FenceContainer } | { kind: "list"; indent: number }

const QUOTE_PREFIX = /^(?: {0,3}> ?)+/
const QUOTE_LEVEL = /^ {0,3}> ?/
const LIST_MARKER = /^ {0,3}(?:[-+*]|\d{1,9}[.)])( +)/

/**
 * The container prefix chain of a complete line: how many bytes to
 * strip before reading the line's own block content, and which
 * container levels those bytes belong to. `column` is the document
 * column the strip point reaches and `base` the column the content
 * region starts at, so the fenced-opener check can measure
 * indentation in columns. A tab partly consumed by the strip keeps
 * its residual columns in the content region, and those columns count
 * toward each quote marker's three-column limit: a deeper marker ends
 * the chain, the line's rest is content. Quote and list
 * prefixes chain: `> - ~~~` opens its fence inside the quoted list
 * item, and continuation lines must carry the same chain.
 */
function lineContainer(line: string): { strip: number; container: FenceContainer; column: number; base: number } {
	let rest = line
	let strip = 0
	let column = 0
	let base = 0
	const levels: Array<{ kind: "quote"; depth: number } | { kind: "list"; indent: number }> = []
	for (;;) {
		const quote = QUOTE_PREFIX.exec(rest)
		if (quote !== null) {
			// CommonMark: a quote marker carries at most three columns of
			// indentation inside the enclosing content region. The
			// residual columns of a tab partly consumed at the previous
			// level count toward that limit even though the match only
			// sees the literal spaces behind it: a deeper marker is an
			// indented-code opener, so the chain ends and the rest of
			// the line stays content.
			if (column + quote[0].indexOf(">") - base > 3) {
				break
			}
			const depth = (quote[0].match(/>/g) ?? []).length
			strip += quote[0].length
			column += quote[0].length
			base = column
			rest = rest.slice(quote[0].length)
			if (quote[0].endsWith(">") && rest.startsWith("\t")) {
				// CommonMark: the optional space behind the marker may be
				// one column of a tab; the tab's remaining columns stay in
				// the content region, the same accounting the fenced-closer
				// path applies.
				strip += 1
				base = column + 1
				column += 4 - (column % 4)
				rest = rest.slice(1)
			}
			levels.push({ kind: "quote", depth })
			continue
		}
		const list = LIST_MARKER.exec(rest)
		if (list !== null) {
			// CommonMark: 1-4 spaces after the marker set the content
			// indent; a wider run indents the content by marker width + 1.
			const markerWidth = list[0].length - list[1].length
			const indent = list[1].length <= 4 ? list[0].length : markerWidth + 1
			levels.push({ kind: "list", indent })
			strip += indent
			column += indent
			base += indent
			rest = rest.slice(list[0].length)
			continue
		}
		break
	}
	let container: FenceContainer = { kind: "none" }
	for (let i = levels.length - 1; i >= 0; i--) {
		const level = levels[i]
		container =
			level.kind === "quote"
				? { kind: "quote", depth: level.depth, inner: container }
				: { kind: "list", indent: level.indent }
	}
	return { strip, container, column, base }
}

/**
 * The whitespace run at `start`: the byte offset where it ends and the
 * document column it reaches. CommonMark expands a tab to the next
 * four-column tab stop.
 */
function whitespaceRun(line: string, start: number, column: number): { at: number; column: number } {
	let at = start
	while (at < line.length) {
		const char = line[at]
		if (char === " ") {
			column += 1
		} else if (char === "	") {
			column += 4 - (column % 4)
		} else {
			break
		}
		at += 1
	}
	return { at, column }
}

/**
 * Bytes of `line` to strip while reading inside `container`, with the
 * document column the strip point reaches and the column the
 * container's content region starts at, or null when the line carries
 * no container prefix and so leaves the container. A tab partly
 * consumed by the strip keeps its residual columns in the content
 * region, which the fenced-closer check must count. `column` and
 * `base` carry the enclosing region's columns across the chain walk;
 * `lenientBlank` keeps a blank line inside a list item (a complete
 * blank line neither leaves the item nor closes the fence), while a
 * mid-line verdict passes false: its line is known to hold content.
 */
function containerStrip(
	container: FenceContainer,
	line: string,
	column = 0,
	base = 0,
	lenientBlank = true,
): { strip: number; column: number; base: number } | null {
	switch (container.kind) {
		case "none":
			return { strip: 0, column, base }
		case "quote": {
			let rest = line
			let stripped = 0
			for (let level = 0; level < container.depth; level++) {
				const match = QUOTE_LEVEL.exec(rest)
				if (match === null) {
					return null
				}
				// CommonMark: a quote marker carries at most three columns
				// of indentation inside the enclosing content region. The
				// residual columns of a tab partly consumed at the previous
				// level count toward that limit even though the match only
				// sees the literal spaces behind them.
				if (column + match[0].indexOf(">") - base > 3) {
					return null
				}
				stripped += match[0].length
				column += match[0].length
				base = column
				rest = rest.slice(match[0].length)
				if (match[0].endsWith(">") && rest.startsWith("\t")) {
					// CommonMark: the optional space behind the marker may
					// be one column of a tab; the tab's remaining columns
					// stay in the content region.
					stripped += 1
					base = column + 1
					column += 4 - (column % 4)
					rest = rest.slice(1)
				}
			}
			const inner = containerStrip(container.inner, rest, column, base, lenientBlank)
			return inner === null ? null : { strip: stripped + inner.strip, column: inner.column, base: inner.base }
		}
		case "list": {
			if (lenientBlank && /^\s*$/.test(line)) {
				// A blank line neither leaves the item nor closes the fence.
				return { strip: 0, column, base }
			}
			// CommonMark expands a tab to the next four-column tab stop, so
			// a tab-indented line can satisfy the item's content indent:
			// measure columns, and strip the bytes that carry them. A tab
			// overshooting the indent leaves its residual columns to the
			// content region.
			const run = whitespaceRun(line, 0, column)
			return run.column - base >= container.indent
				? { strip: run.at, column: run.column, base: base + container.indent }
				: null
		}
	}
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
	/** Bytes of the open block interior already searched for the close. */
	private blockScanned = 0

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
			// The dead-candidate verdict runs first and depends only on
			// the bytes seen: a candidate that contradicts the opener
			// grammar (e.g. `<invoke nope`) can never match, so the
			// head flushes at once whether or not a '>' has arrived -
			// waiting would hold the rest of the stream until the
			// finish, and a '>' cut would let the verdict depend on the
			// chunking. A later '<' starts a fresh candidate.
			if (!canBecomeInvokeOpener(this.pending.slice(INVOKE_HEAD.length))) {
				const nextTag = this.pending.indexOf("<", 1)
				return [true, ...this.flushHead(nextTag === -1 ? this.pending.length : nextTag)]
			}
			// No closing '>' yet: wait for the tag to complete; a '>'
			// behind a grammar-consistent candidate is handled above.
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
		this.blockScanned = 0
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
			// The same byte-content verdict as the bare path, first:
			// a dead candidate flushes the skeleton plus its head at
			// once, whatever a '>' is doing behind it.
			if (!canBecomeInvokeOpener(rest.slice(INVOKE_HEAD.length))) {
				const nextTag = rest.indexOf("<", 1)
				return [true, ...this.flushHead(nextTag === -1 ? this.pending.length : wsEnd + nextTag)]
			}
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
		this.blockScanned = 0
		this.phase = "block"
		return [true]
	}

	/** Holds the block interior until `</invoke>` resolves the verdict. */
	private stepBlock(): [boolean, ...RecoveryEvent[]] {
		// Case-insensitive search on the ORIGINAL string: a lowercased
		// copy can change length (U+0130 lowercases to two code points),
		// which shifts the offset and makes slice/drop cut extra bytes.
		// Each delta resumes behind the last searched offset minus an
		// INVOKE_CLOSE.length - 1 overlap, so a close split across
		// deltas is still found without re-searching the whole body.
		const from = Math.max(0, this.blockScanned - (INVOKE_CLOSE.length - 1))
		const closeMatch = /<\/invoke>/i.exec(this.pending.slice(this.cursor + from))
		const closeAt = closeMatch === null ? -1 : this.cursor + from + closeMatch.index
		if (closeAt === -1) {
			this.blockScanned = this.pending.length - this.cursor
			return [false]
		}
		const name = this.openName ?? ""
		const body = this.pending.slice(this.cursor, closeAt)
		const args = parseInvokeParametersComplete(body)
		this.blockScanned = 0
		if (args === null) {
			// A body the parameter parser cannot consume completely is
			// a malformed candidate: the whole block, tags included,
			// stays text. The parser is the verdict, not a best-effort
			// extraction that drops source bytes.
			this.openName = null
			return [true, ...this.flushHead(closeAt + INVOKE_CLOSE.length)]
		}
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
			// Only the closer next to the block is skeleton residue;
			// a further closer is prose and must reach the text sink.
			this.phase = "safe"
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

	/**
	 * Silently removes the consumed skeleton bytes before `n`. The
	 * bytes never reach the text sink, so they never join the markdown
	 * context: a fence marker inside a recovered parameter value is
	 * tool input, not surrounding Markdown, and must not quote a
	 * later block.
	 */
	private drop(n: number): void {
		if (n <= 0) {
			return
		}
		this.pending = this.pending.slice(n)
		this.cursor = Math.max(0, this.cursor - n)
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
	 * fenced code block, the fence opener of the current line (the
	 * info string behind a fence marker is literal, and the fence
	 * state updates only when the line completes), or an inline code
	 * span open at this point of the current line. CommonMark: a span
	 * closes only on a run of the same width, and fence lines are
	 * fence syntax, never span delimiters.
	 */
	private isQuotedAtOpener(): boolean {
		// CommonMark: an unclosed fence ends when the current line
		// leaves its container (a fenced block has no lazy
		// continuation), so the stored fence state quotes this opener
		// only while the line so far still strips into that container.
		// The verdict line is known to hold content, so the blank-line
		// leniency is off: an empty prefix leaves a quoted or list
		// container instead of staying inside it.
		if (this.fence !== null && containerStrip(this.fence.container, this.linePrefix, 0, 0, false) !== null) {
			return true
		}
		if (this.fenceOpenerOf(this.linePrefix) !== null) {
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
	 * Feeds the bytes that reach the text sink into the markdown
	 * context: fence open/close on complete lines, plus the
	 * partial-line carry for span checks. Only `flush` calls this;
	 * skeleton bytes leave `pending` through `drop` and stay invisible
	 * to the quoting context.
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
		const fence = this.fence
		if (fence === null) {
			this.detectFence(line)
			return
		}
		// CommonMark ends an unclosed fenced block when its container
		// (a block quote or a list item) ends; the line is then read
		// outside that container, so it may open a new fence.
		const stripped = containerStrip(fence.container, line)
		if (stripped === null) {
			this.fence = null
			// The line is read outside the ended container, so it may
			// open a new fence; ordinary prose leaves fence null.
			this.detectFence(line)
			return
		}
		// Fence lines are read behind the opening fence's own
		// container: a quote-prefixed line inside a top-level fence
		// is literal content, and only a same-container line can
		// close the fence.
		const content = line.slice(stripped.strip)
		// The closing fence may sit at most three columns inside the
		// container, measured at tab stops: a tab partly consumed by
		// the strip keeps its residual columns in the content, so
		// a tab-space closer line deeper than three columns stays
		// fence content instead of ending the block. The depth is
		// measured from the container's content-region column, never
		// from the prefix byte length: a quote marker whose padding
		// is one column of a tab starts the content behind that
		// column, at a different column than the bytes it stripped.
		const base = stripped.base
		const run = whitespaceRun(content, 0, stripped.column)
		const body = content.slice(run.at)
		let width = 0
		while (width < body.length && body[width] === fence.char) {
			width += 1
		}
		if (run.column - base <= 3 && width >= fence.width && /^[ \t]*\r?$/.test(body.slice(width))) {
			this.fence = null
		}
	}

	/**
	 * The fence a complete line opens outside any fence, or null. The
	 * line's own container prefix is skipped, so a quoted or list-held
	 * fence is still a fence and the block it wraps stays quoted. The
	 * fence may sit at most three columns inside the container,
	 * measured at tab stops like the closing-fence check: a tab partly
	 * consumed by the strip leaves residual columns the allowance must
	 * count. Pure: `detectFence` stores the result,
	 * `isQuotedAtOpener` reads the current line's prefix without
	 * touching the state.
	 */
	private fenceOpenerOf(line: string): FenceState | null {
		const { strip, container, column, base } = lineContainer(line)
		const content = line.slice(strip)
		const run = whitespaceRun(content, 0, column)
		if (run.column - base > 3) {
			// Past the fence allowance: an indented block, not a fence.
			return null
		}
		const body = content.slice(run.at)
		const tilde = /^(~{3,})/.exec(body)
		if (tilde) {
			// A tilde fence accepts any info string.
			return { char: "~", width: tilde[1].length, container }
		}
		const backtick = /^(`{3,})/.exec(body)
		if (backtick && !body.slice(backtick[0].length).includes("`")) {
			// A backtick fence's info string must contain no backtick.
			return { char: "`", width: backtick[1].length, container }
		}
		return null
	}

	/** Opens a fence on a complete line outside any fence. */
	private detectFence(line: string): void {
		this.fence = this.fenceOpenerOf(line)
	}
}

/**
 * Parses the `<parameter name="k">v</parameter>` pairs of a block body
 * into a JSON arguments string, or null when the pairs do not consume
 * the complete body: a malformed interior is a failed candidate whose
 * block stays text. Only whitespace may sit between and around the
 * pairs, and an empty interior is the valid parameterless block.
 * Values stay strings; the caller owns the schema typing. The sticky
 * flag alone anchors each pair at the scan position: a `^` inside a
 * sticky regex would keep asserting the string start and only the
 * first pair could ever match.
 */
function parseInvokeParametersComplete(body: string): string | null {
	// A null prototype keeps a "__proto__" parameter name an own
	// property: an ordinary object's inherited setter would swallow
	// the assignment and drop the value. Duplicate keys keep the
	// last-value rule.
	const args: Record<string, string> = Object.create(null)
	let at = 0
	const skipWhitespace = () => {
		while (at < body.length && /\s/.test(body[at])) {
			at += 1
		}
	}
	skipWhitespace()
	while (at < body.length) {
		PARAMETER_ANCHORED.lastIndex = at
		const match = PARAMETER_ANCHORED.exec(body)
		if (match === null) {
			return null
		}
		const key = match[1] ?? match[2] ?? ""
		if (key) {
			args[key] = match[3] ?? ""
		}
		at = PARAMETER_ANCHORED.lastIndex
		skipWhitespace()
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
