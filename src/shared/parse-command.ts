import { parse } from "shell-quote"

export type ShellToken = string | { op: string } | { command: string }

/**
 * The kind of structural region a malformed-command error refers to.
 *
 * Quote and heredoc kinds describe regions that were opened and never closed:
 *
 * - `posix-single` and `ansi-c` share the `'` delimiter but follow different
 *   escaping rules, so they must be distinguished.
 * - `locale` and `double` share the `"` delimiter but `locale` is prefixed with
 *   `$`, making `$"..."` a distinct token for accurate restoration.
 * - `heredoc` covers `<<WORD`, `<<'WORD'`, `<<"WORD"`, and `<<\WORD` openers
 *   whose body extends through the terminator line.
 *
 * Expansion kinds describe the delimiters the scanner balances while extracting
 * command substitutions (`stray-closer` is the dual failure: a closer with no
 * opener):
 *
 * - `command-substitution`: a `$(` that was never closed.
 * - `process-substitution`: a `<(…` or `>(…` that was never closed.
 * - `parameter-expansion`: a `${` that was never closed.
 * - `backtick`: a backtick region that was never closed.
 * - `arithmetic`: an arithmetic expression (`$((` or `$[`) that was never
 *   closed.
 * - `stray-closer`: a `)` or `}` seen at nesting depth 0 outside any quoted
 *   region, comment, or heredoc body — a closer with no matching opener.
 *
 * Rejection kinds describe input the scan refuses outright rather than token
 * (both only ever cost a prompt, never an approval):
 *
 * - `nul-byte`: a raw NUL byte anywhere in the command. NUL is the scan's
 *   placeholder sentinel, so an input containing one could corrupt the
 *   masked-text round trip.
 * - `nesting-too-deep`: substitution payloads re-scanned beyond
 *   `MAX_PAYLOAD_SCAN_DEPTH` levels — generated input, not a human command.
 */
export type QuoteType =
	| "posix-single"
	| "ansi-c"
	| "double"
	| "locale"
	| "heredoc"
	| "command-substitution"
	| "process-substitution"
	| "parameter-expansion"
	| "backtick"
	| "arithmetic"
	| "stray-closer"
	| "nul-byte"
	| "nesting-too-deep"

/**
 * The result of parsing a command string.
 *
 * `commands` is the list of individual sub-commands produced by splitting on
 * unquoted newlines and chain operators. When `parseError` is non-null the
 * command string is syntactically malformed (an unterminated quote/heredoc, an
 * expansion delimiter or arithmetic expression that was opened but never
 * closed, a stray closer, a raw NUL byte, or substitution nesting beyond the
 * re-scan depth cap) and
 * `commands` contains the raw input as a single opaque token so callers can
 * surface the error without splitting unsafe fragments.
 *
 * Callers that only need the sub-command list can destructure `{ commands }`.
 * Callers that need to distinguish a parse error from a normal single-command
 * result should also inspect `parseError`.
 */
export interface ParseResult {
	commands: string[]
	parseError: UnterminatedQuote | null
}

/**
 * Describes a structural delimiter the scan could not account for: a quoted,
 * heredoc, or expansion region that is never closed, or a closing delimiter at
 * depth 0 with no opener.
 *
 * - `quoteType`: the kind of the offending construct.
 * - `openIndex`: the index in the scanned command string of the character that
 *   opened the region (for ANSI-C and locale quoting this points at the
 *   leading `$`; for heredocs at the first `<`; for a stray closer at the
 *   closer itself). This position lets a caller emit a located error instead
 *   of a generic message.
 */
export interface UnterminatedQuote {
	quoteType: QuoteType
	openIndex: number
	/** Human-readable description suitable for surfacing to an agent as a tool error. */
	message: string
}

/**
 * Build the human-readable error message for a structural parse failure.
 * Includes a short excerpt of the command around the offending character so
 * the agent has enough context to locate and fix the problem.
 */
function unterminatedQuoteMessage(quoteType: QuoteType, openIndex: number, command: string): string {
	const labels: Record<QuoteType, string> = {
		"posix-single": "single quote (')",
		"ansi-c": "ANSI-C quote ($')",
		double: 'double quote (")',
		locale: 'locale quote ($")',
		heredoc: "heredoc (<<)",
		"command-substitution": "command substitution ($(...))",
		"process-substitution": "process substitution (<(...) or >(...))",
		"parameter-expansion": "parameter expansion (${...})",
		backtick: "backtick (`)",
		arithmetic: "arithmetic expression ($(( or $[)",
		"stray-closer": `closing delimiter '${command[openIndex] ?? ""}' with no matching opener`,
		"nul-byte": "NUL byte (control characters cannot appear in a shell command)",
		"nesting-too-deep": `substitution nesting deeper than ${MAX_PAYLOAD_SCAN_DEPTH} levels`,
	}
	const problem =
		quoteType === "stray-closer" || quoteType === "nul-byte" || quoteType === "nesting-too-deep"
			? labels[quoteType]
			: `unterminated ${labels[quoteType]}`
	const snippetStart = Math.max(0, openIndex - 10)
	const snippetEnd = Math.min(command.length, openIndex + 20)
	const prefix = snippetStart > 0 ? "..." : ""
	const suffix = snippetEnd < command.length ? "..." : ""
	const excerpt = prefix + command.slice(snippetStart, snippetEnd).replace(/\r?\n/g, "\\n") + suffix
	return `Malformed command: ${problem} at position ${openIndex} -- near: \`${excerpt}\`. `
}

/**
 * Report the first structural problem in `command`, or `null` when every
 * quoted region, heredoc, and expansion delimiter is properly closed and no
 * closer appears without its opener.
 *
 * A regex cannot answer "can a shell parse this?" because shell syntax is
 * context-sensitive: a backslash escapes the next character outside single
 * quotes, `#` may begin a comment that should be ignored, a quote inside
 * double quotes is literal text, and nesting must be balanced. The shared
 * state-machine walk in `scanShellSyntax` mirrors POSIX tokenization so that
 * legitimate multi-line quoted arguments are accepted while genuinely
 * malformed input is detected.
 *
 * Unbalanced delimiter characters inside ordinary quoted regions remain
 * parseable: a shell never looks at them, so neither does this check.
 */
export function findUnterminatedQuote(command: string): UnterminatedQuote | null {
	return scanShellSyntax(command).error
}

/** The kinds of region the scanner tracks on its open-delimiter stack. */
type FrameKind =
	| "posix-single"
	| "ansi-c"
	| "double"
	| "locale"
	| "command-substitution"
	| "process-substitution"
	| "parameter-expansion"
	| "backtick"

const QUOTE_FRAME_KINDS: FrameKind[] = ["posix-single", "ansi-c", "double", "locale"]

/**
 * The characters a backslash escapes inside double quotes. Before any other
 * character the backslash is itself literal and stays part of the word.
 */
const DOUBLE_QUOTE_ESCAPABLE = '$`"\\\n'

/** An open region the scanner is inside of; one entry per unclosed delimiter. */
interface RegionFrame {
	kind: FrameKind
	/** Index of the first character of the opening delimiter. */
	openIndex: number
	/** The single character that closes this region. */
	closer: string
	/** Index just after the opening delimiter; start of the region's content. */
	contentStart: number
	/** Whether a backslash inside the region escapes the next character. */
	escaped: boolean
	/**
	 * For command/process-substitution frames: the number of bare `(` grouping
	 * parentheses opened inside the region and not yet closed. A subshell group
	 * balances independently of the frame's own closer, so a `)` while this is
	 * positive matches the group and must not pop the frame.
	 */
	groupDepth: number
	/**
	 * For parameter-expansion frames: every command substitution closed inside
	 * the expansion, at any nesting depth. A parameter expansion masks its text
	 * from the tokenizer but must not stop substitution extraction, because the
	 * shell expands `${x:-$(cmd)}` exactly like `$(cmd)`.
	 */
	payloads: string[] | null
}

/**
 * Everything one scan produces: the masked host text, the structural error (if
 * any), and the masked-away constructs the tokenizer needs to restore or
 * recurse into.
 */
interface ScanOutcome {
	/**
	 * Host text with every quoted region, heredoc, parameter expansion,
	 * arithmetic expression, variable, and redirection replaced by an opaque
	 * placeholder word, and every command substitution replaced by a boundary
	 * placeholder. It contains no active shell syntax, so `shell-quote` can
	 * tokenize it safely.
	 */
	host: string
	error: UnterminatedQuote | null
	/** Inner text of each `$()`/backtick/`<()`/`>()` region, in order. */
	substitutions: string[]
	/** Raw text of each quoted region, restored verbatim. */
	quotes: string[]
	/** Raw text of each `${...}` region, restored verbatim. */
	params: string[]
	/** For each parameter expansion: raw inner substitutions to extract. */
	paramPayloads: string[][]
	/** Raw text (opener line through terminator) of each heredoc. */
	heredocs: string[]
	/** For each heredoc with an unquoted delimiter: body substitutions. */
	heredocPayloads: string[][]
	variables: string[]
	redirections: string[]
	/** Masked arithmetic expressions: `$((...))` and `$[...]`. */
	arithmetic: string[]
	/** For each `$((...))`: substitutions the shell expands inside it. */
	arithmeticPayloads: string[][]
}

/**
 * Sentinel separating placeholder names in masked host text. The scan rejects
 * any input containing a raw NUL (`nul-byte`) up front, so a placeholder name
 * can never collide with command text (unlike a printable `__NAME_0__`
 * marker, which an input could contain literally).
 */
const NUL = "\x00"

/**
 * Cap on payload re-scan depth. Each substitution payload is re-scanned
 * through the full path, so an unbounded cap lets a few tens of KB of
 * generated input burn minutes of CPU (quadratic suffix re-scans) and finally
 * overflow the call stack; exceeding it fails closed instead. No hand-written
 * command nests a substitution 64 deep.
 */
const MAX_PAYLOAD_SCAN_DEPTH = 64

const IDENT_START = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_"
const IDENT_CHARS = `${IDENT_START}0123456789`
/** `$` followed by one of these is a complete special variable. */
const SPECIAL_VAR_CHARS = "?!#$@*-0123456789"

function isIdentStart(char: string): boolean {
	return IDENT_START.includes(char)
}

function isIdentChar(char: string): boolean {
	return IDENT_CHARS.includes(char)
}

/**
 * One quote-aware, left-to-right scan of `text` that simultaneously tracks
 * quote state, delimiter depth, and heredoc state, emitting masked host text,
 * extracted substitution payloads, and a structural error from the same pass.
 *
 * Invariants the rest of the file depends on:
 *
 * - Quoted regions (`'…'`, `"…"`, `$'…'`, `$"…"`) are opaque to extraction:
 *   their contents are masked whole and returned verbatim, and unbalanced
 *   delimiters inside them are never errors — a shell never parses them there.
 *   (A shell does expand `"$(cmd)"`, but extraction inside quoted regions is
 *   deliberately out of scope, so such payloads stay masked.)
 * - `$(…)`, backticks, `<(`, `>(` are extracted: on close, the raw inner text
 *   becomes a payload segment and the host keeps only an opaque boundary
 *   placeholder, so inner commands match the allow/deny lists on their own.
 *   Payloads are re-scanned, so nesting yields independent segments.
 * - `${…}` masks its text (restored verbatim into the host segment) but the
 *   scan descends into it: substitutions inside a parameter expansion are
 *   still extracted and balance-checked, including substitutions inside a
 *   heredoc body opened within the expansion, whose payloads route to the
 *   expansion's payload list.
 * - `$((…))` masks the expression as one host word and never balances as an
 *   extraction delimiter, but substitutions inside a closed `$((…))` are
 *   extracted and balance-checked, because the shell expands them there. An
 *   unclosed `$((` or `$[` fails closed (`arithmetic`): bash refuses the
 *   input, and masking the remainder to end of input could hide an unclosed
 *   `$(` riding inside it. Bare `$[…]`'s interior stays mask-only: never
 *   inspected for substitutions. Bare
 *   `(`…`)` grouping (subshell groups, array assignments) likewise stays host
 *   text: unclosed it is never an error, so a `)` matching an open bare `(` is
 *   not a stray closer either.
 * - Fail-closed rule: any of the four extraction delimiters opened that the
 *   scan cannot close is an error, as is an unclosed arithmetic opener
 *   (`$((`/`$[`), a stray `)` or `}` at depth 0, a raw NUL byte anywhere in
 *   the input, or payload re-scanning deeper than
 *   `MAX_PAYLOAD_SCAN_DEPTH`. A closer that does not match the open region's
 *   kind is literal content (shell-faithful); the still-open region then fails
 *   at end of input.
 * - Heredocs: the opener line through the terminator line mask as one opaque
 *   host word, so the heredoc stays a single segment no matter how many lines
 *   it spans. Lines end only at LF (a CR counts solely as the CR of a CRLF
 *   pair): a CR-only opener or terminator line does not validate a heredoc,
 *   because bash would report such a construct unterminated. An
 *   unquoted-delimiter body is expansion-active: substitutions
 *   opened inside it are extracted and must balance before the terminator. A
 *   quoted or backslash-escaped delimiter suppresses expansion entirely in the
 *   body (the shell does not expand those), so its body stays opaque and is
 *   never balance-checked. Bodies carry no comments and are not tokenized
 *   outside an expansion region: a `"` or `#` there is literal text, while
 *   quotes and word-initial `#` comments inside an expansion region follow the
 *   shell's rules there (a comment ends at the newline, not at the region end).
 *   The opener line's remainder
 *   (text after the delimiter word) is walked for substitutions even when the
 *   delimiter is quoted: quoting suppresses expansion in the body only, so
 *   `cat <<'EOF' $(cmd)` still runs `cmd`.
 */
function scanShellSyntax(text: string): ScanOutcome {
	const outcome: ScanOutcome = {
		host: "",
		error: null,
		substitutions: [],
		quotes: [],
		params: [],
		paramPayloads: [],
		heredocs: [],
		heredocPayloads: [],
		variables: [],
		redirections: [],
		arithmetic: [],
		arithmeticPayloads: [],
	}
	const stack: RegionFrame[] = []
	// Open parameter-expansion frames on `stack`: lets `innermostParam` return
	// without a stack walk while no expansion is open.
	let paramFramesOpen = 0
	// Bare `(` grouping (subshell groups, array assignments) stays host text:
	// it is not one of the extraction/fail-closed delimiters, so an unclosed
	// `(` is never an error. Depth is tracked only so a `)` that matches an
	// open bare `(` is not reported as a stray closer.
	let parenDepth = 0
	// Index just past the most recent expansion or quote region the scan closed
	// at host level (including `$((…))`/`$[…]`), or -1. The shell ends the
	// expansion at such a closer but not the surrounding word, so a `#` sitting
	// exactly there is word content, never a comment start.
	let expansionCloseEnd = -1
	// Index just past the most recent `\c` escape pair the scan emitted at host
	// level, or -1. To the shell the escaped character is an ordinary word
	// character, so the word continues past the pair: a `#` sitting exactly at
	// this index is word content even when the escaped character is whitespace
	// or a metacharacter in the raw text.
	let escapedWordCharEnd = -1

	const mark = (name: string): string => `${NUL}${name}${NUL}`

	const errorAt = (kind: QuoteType, openIndex: number): UnterminatedQuote => ({
		quoteType: kind,
		openIndex,
		message: unterminatedQuoteMessage(kind, openIndex, text),
	})

	// Reject a raw NUL before any masking: NUL is this scan's placeholder
	// sentinel, so an input containing one could degrade a masked placeholder
	// into inert literal text and hide a substitution from the lists. Rejecting
	// at the scan head also covers `findUnterminatedQuote`, which shares it.
	const nulIndex = text.indexOf(NUL)
	if (nulIndex !== -1) {
		outcome.error = errorAt("nul-byte", nulIndex)
		return outcome
	}

	const endOfLine = (from: number): number => {
		let j = from
		while (j < text.length && text[j] !== "\n" && text[j] !== "\r") {
			j++
		}
		return j
	}

	/** Open the quoted region starting at `i`, or return null if none. */
	const openQuote = (i: number): RegionFrame | null => {
		if (text[i] === "$" && text[i + 1] === "'") {
			return {
				kind: "ansi-c",
				openIndex: i,
				closer: "'",
				contentStart: i + 2,
				escaped: true,
				groupDepth: 0,
				payloads: null,
			}
		}
		if (text[i] === "$" && text[i + 1] === '"') {
			return {
				kind: "locale",
				openIndex: i,
				closer: '"',
				contentStart: i + 2,
				escaped: true,
				groupDepth: 0,
				payloads: null,
			}
		}
		if (text[i] === "'") {
			return {
				kind: "posix-single",
				openIndex: i,
				closer: "'",
				contentStart: i + 1,
				escaped: false,
				groupDepth: 0,
				payloads: null,
			}
		}
		if (text[i] === '"') {
			return {
				kind: "double",
				openIndex: i,
				closer: '"',
				contentStart: i + 1,
				escaped: true,
				groupDepth: 0,
				payloads: null,
			}
		}
		return null
	}

	/**
	 * The innermost parameter-expansion frame on `frames`, if any. `paramOpen`
	 * is the caller's count of open parameter-expansion frames: when it is 0
	 * the scan returns without walking the stack, so deep non-expansion
	 * nesting does not pay a stack scan per frame close.
	 */
	const innermostParam = (frames: RegionFrame[], paramOpen: number): RegionFrame | undefined => {
		if (paramOpen === 0) {
			return undefined
		}
		for (let f = frames.length - 1; f >= 0; f--) {
			if (frames[f].kind === "parameter-expansion") {
				return frames[f]
			}
		}
		return undefined
	}

	/**
	 * Consume an entire heredoc at `i` (opener line, body, terminator). The
	 * whole construct masks to one host word. Returns the index just past the
	 * terminator text, or an error for an unterminated heredoc or an unbalanced
	 * delimiter inside an expansion-active body.
	 */
	const skipHeredoc = (i: number, frames: RegionFrame[]): { end: number } | { error: UnterminatedQuote } => {
		const start = i
		i += 2 // consume <<
		const stripTabs = text[i] === "-"
		if (stripTabs) {
			i++
		}
		while (i < text.length && (text[i] === " " || text[i] === "\t")) {
			i++
		}
		const { delimiter, endIndex, quoted, wordPresent, malformed } = parseHeredocDelimiter(text, i)
		if (malformed) {
			// The delimiter word still has an open quote region at end of input.
			// bash reads it as a multi-line word that can never match a body line,
			// while the opener line's tail keeps executing as ordinary syntax --
			// the body and everything after it are unaccountable, so fail closed.
			return { error: errorAt("heredoc", start) }
		}
		const payloads: string[] = []
		// The opener line's remainder after the delimiter is expanded by the shell
		// even when the delimiter is quoted (quoting suppresses expansion in the
		// body only), so walk it unconditionally; an error there fails the whole
		// heredoc closed like a body error does.
		const remainderEnd = endOfLine(endIndex)
		const remainderError = walkBodyPayloads(endIndex, remainderEnd, payloads, 0)
		if (remainderError) {
			return { error: remainderError }
		}
		// The opener line must end at LF so the body starts on the next line.
		// A CR is valid only as the CR of a CRLF pair: a lone CR is not a bash
		// line terminator, and accepting one as the opener's end would validate
		// CR-separated input the shell refuses as an unterminated heredoc.
		i = remainderEnd
		if (text[i] === "\r") {
			i++
		}
		if (text[i] !== "\n") {
			return { error: errorAt("heredoc", start) }
		}
		i++
		let bodyEnd = text.length
		if (wordPresent) {
			let found = false
			const bodyStart = i
			// A terminator candidate spans physical lines until it stops
			// continuing: bash joins a backslash-newline pair before matching
			// the delimiter, so an unquoted body line whose content ends in an
			// odd number of backslashes flows into the next physical line
			// (trailing CR dropped only as the CR of a CRLF pair). <<- strips
			// leading tabs per physical line, before that join. A quoted
			// delimiter makes the backslash literal, so no joining happens.
			search: while (i < text.length) {
				const groupStart = i
				let candidate = ""
				for (;;) {
					const lineStart = i
					while (i < text.length && text[i] !== "\n" && text[i] !== "\r") {
						i++
					}
					const rawLine = text.slice(lineStart, i)
					// Leading tabs are stripped only for <<- heredocs.
					const line = stripTabs ? rawLine.replace(/^\t*/, "") : rawLine
					// The terminator line must be bounded by LF or EOF (a CR counts
					// only as the CR of a CRLF pair): a CR-only-bounded "EOF\r" is
					// body text to bash, so treating it as the terminator would
					// validate a heredoc the shell reports as unterminated.
					const boundedByEol =
						i >= text.length || text[i] === "\n" || (text[i] === "\r" && text[i + 1] === "\n")
					const endsAtLineBreak = text[i] === "\n" || (text[i] === "\r" && text[i + 1] === "\n")
					const trailingBackslashes = line.match(/\\*$/)?.[0].length ?? 0
					if (!quoted && endsAtLineBreak && trailingBackslashes % 2 === 1) {
						candidate += line.slice(0, -1) // drop the continuation backslash
						i += text[i] === "\r" ? 2 : 1
						continue
					}
					candidate += line
					if (candidate === delimiter && boundedByEol) {
						found = true
						bodyEnd = groupStart
						break search
					}
					break
				}
				if (i < text.length) {
					i++ // consume the newline of a body line
				}
			}
			if (!found) {
				// The body never ends: nothing after the opener can be trusted.
				return { error: errorAt("heredoc", start) }
			}
			if (!quoted) {
				const bodyError = walkBodyPayloads(bodyStart, bodyEnd, payloads, 0)
				if (bodyError) {
					return { error: bodyError }
				}
			}
			if (frames.length > 0) {
				// Inside an expansion no H placeholder is emitted, so without this
				// routing the collected payloads would never reach a re-scan. Hand
				// them to the innermost parameter-expansion ancestor exactly as a
				// directly nested substitution close does. A heredoc opened inside
				// $(…)/backtick/<( has no such ancestor: the enclosing substitution's
				// payload is re-scanned whole and recovers them there.
				innermostParam(frames, paramFramesOpen)?.payloads?.push(...payloads)
			}
			const id = outcome.heredocs.push(text.slice(start, i)) - 1
			outcome.heredocPayloads[id] = payloads
			// Inside an expansion region the host is masked wholesale anyway; only
			// top-level heredocs need a placeholder in the host text.
			if (frames.length === 0) {
				outcome.host += mark(`H${id}`)
			}
			return { end: i }
		}
		// No delimiter token at all (a bare `<<`, or `<<` followed only by
		// blanks, before end of line): bash rejects such input with a syntax
		// error and never executes it, so masking the opener through end of
		// input as one opaque word over-approximates a never-runnable
		// construct and cannot hide a live command.
		outcome.heredocs.push(text.slice(start, text.length))
		outcome.heredocPayloads[outcome.heredocs.length - 1] = payloads
		if (frames.length === 0) {
			outcome.host += mark(`H${outcome.heredocs.length - 1}`)
		}
		return { end: text.length }
	}

	/**
	 * Walk a heredoc body region `[start, end)` collecting command
	 * substitutions the shell would expand there.
	 *
	 * Outside an expansion region this walk tracks only the expansion
	 * delimiters and backslash escapes: a heredoc body is not tokenized, so a
	 * `"` or `#` in the body is literal text. Inside an expansion region the
	 * shell does tokenize, so a quote there opens a region exactly as the main
	 * scan treats it — the region masks the frame's closer and group tests, and
	 * a region still open at the end of the body fails closed like any other
	 * unclosed delimiter — while a word-initial `#` begins a comment that the
	 * shell skips to end of line. A closer with no opener inside the body is
	 * literal data (the shell prints it); a delimiter still open when the
	 * terminator line is reached is a structural error — the shell would never
	 * finish expanding the body, so whatever follows it is unaccountable.
	 *
	 * `depth` bounds the recursion through nested `$((…))` interiors; beyond
	 * `MAX_PAYLOAD_SCAN_DEPTH` the region fails closed instead of recursing into
	 * generated input.
	 */
	const walkBodyPayloads = (
		start: number,
		end: number,
		collect: string[],
		depth: number,
	): UnterminatedQuote | null => {
		if (depth > MAX_PAYLOAD_SCAN_DEPTH) {
			return errorAt("nesting-too-deep", start)
		}
		const frames: RegionFrame[] = []
		let localParamOpen = 0
		let i = start
		while (i < end) {
			const char = text[i]
			const top = frames[frames.length - 1]
			if (top) {
				if (top.escaped && char === "\\") {
					i += 2
					continue
				}
				// A `#` at the start of a word inside a `$(…)`/`<(` frame begins a
				// comment the shell skips to end of line (body regions span lines,
				// so the comment ends at the newline, not at the frame's end): a
				// `)` riding inside the comment never closes the frame, and the
				// continuation lines stay inside the same substitution. Quote and
				// backtick frames keep `#` literal — their regions reach this test
				// too — and so do parameter expansions (`${#var}` is the length
				// operator), so only substitution frames take the comment. The
				// word-boundary set is the top-level comment rule's whitespace
				// plus the metacharacters that end a word: a missed comment lets
				// its `)` slice the payload, so the boundary must be exact.
				if (
					char === "#" &&
					(top.kind === "command-substitution" || top.kind === "process-substitution") &&
					/[\s;&()|<>]/.test(text[i - 1])
				) {
					// Clamp at the region end: a comment running past it leaves the
					// frame open, and the still-open frame fails closed.
					i = Math.min(endOfLine(i), end)
					continue
				}
				if (char === top.closer) {
					if (top.groupDepth > 0) {
						// This closer matches an inner grouping paren opened inside
						// the region, not the region's own opener.
						top.groupDepth--
						i++
						continue
					}
					const closed = frames.pop() as RegionFrame
					if (QUOTE_FRAME_KINDS.includes(closed.kind)) {
						// Quote regions are opaque: nothing inside them is extracted,
						// and the enclosing frame resumes after the closing quote.
						i++
						continue
					}
					if (closed.kind === "parameter-expansion") {
						localParamOpen--
						if (frames.length === 0) {
							collect.push(...(closed.payloads ?? []))
						} else {
							innermostParam(frames, localParamOpen)?.payloads?.push(...(closed.payloads ?? []))
						}
					} else {
						// Slice the inner text only where a consumer exists: a close
						// nested with no parameter-expansion ancestor is recovered
						// when the enclosing payload is re-scanned, so slicing every
						// close eagerly would cost O(n²) on adversarial nesting.
						const paramAncestor = innermostParam(frames, localParamOpen)
						if (frames.length === 0 || paramAncestor) {
							const inner = text.slice(closed.contentStart, i).trim()
							if (paramAncestor) {
								paramAncestor.payloads?.push(inner)
							} else {
								collect.push(inner)
							}
						}
					}
					i++
					continue
				}
				// A quote frame is opaque except for its own closer and escapes; a
				// backtick region is opaque except for its closer (backticks do not
				// nest). Only expansion frames descend for nested constructs.
				if (QUOTE_FRAME_KINDS.includes(top.kind) || top.kind === "backtick") {
					i++
					continue
				}
				// A bare `(` inside a substitution region opens a subshell group the
				// shell balances independently of the region's closer; only its
				// depth matters here, so the group's `)` cannot slice the payload.
				if ((top.kind === "command-substitution" || top.kind === "process-substitution") && char === "(") {
					top.groupDepth++
					i++
					continue
				}
				// Inside an expansion frame a quote is shell syntax, not body text:
				// the region it opens masks everything up to its closer, so a `)`
				// or `(` inside quotes is neither a closer nor a group-opener. An
				// unclosed region fails at the end of the walk like any other
				// unclosed frame.
				const nestedQuote = openQuote(i)
				if (nestedQuote) {
					frames.push(nestedQuote)
					i = nestedQuote.contentStart
					continue
				}
			}
			if (char === "\\") {
				i += 2
				continue
			}
			if (char === "`") {
				frames.push({
					kind: "backtick",
					openIndex: i,
					closer: "`",
					contentStart: i + 1,
					escaped: true,
					groupDepth: 0,
					payloads: null,
				})
				i++
				continue
			}
			if (char === "$") {
				if (text[i + 1] === "(") {
					if (text[i + 2] === "(") {
						const arith = skipArithmetic(i)
						// An unclosed opener fails closed: the shell refuses the
						// input, and masking the rest of the body would hide it.
						if (!arith.closed) {
							return errorAt("arithmetic", i)
						}
						// $((…)) is expansion-active: the shell performs the
						// substitutions inside it, so they must balance and be
						// collected.
						const arithError = walkBodyPayloads(i + 3, arith.end - 2, collect, depth + 1)
						if (arithError) {
							return arithError
						}
						i = arith.end
						continue
					}
					frames.push({
						kind: "command-substitution",
						openIndex: i,
						closer: ")",
						contentStart: i + 2,
						escaped: true,
						groupDepth: 0,
						payloads: null,
					})
					i += 2
					continue
				}
				if (text[i + 1] === "{") {
					frames.push({
						kind: "parameter-expansion",
						openIndex: i,
						closer: "}",
						contentStart: i + 2,
						escaped: true,
						groupDepth: 0,
						payloads: [],
					})
					localParamOpen++
					i += 2
					continue
				}
				if (text[i + 1] === "[") {
					const arith = skipArithmetic(i)
					// An unclosed opener fails closed: the shell refuses the
					// input, and masking the rest of the body would hide it.
					if (!arith.closed) {
						return errorAt("arithmetic", i)
					}
					// $[…] is expansion-active exactly like $((…)): the shell
					// performs the substitutions inside it, so they must balance
					// and be collected.
					const arithError = walkBodyPayloads(i + 2, arith.end - 1, collect, depth + 1)
					if (arithError) {
						return arithError
					}
					i = arith.end
					continue
				}
				i++
				continue
			}
			if ((char === "<" || char === ">") && text[i + 1] === "(") {
				frames.push({
					kind: "process-substitution",
					openIndex: i,
					closer: ")",
					contentStart: i + 2,
					escaped: true,
					groupDepth: 0,
					payloads: null,
				})
				i += 2
				continue
			}
			i++
		}
		if (frames.length > 0) {
			// Report the outermost unclosed delimiter: the first construct the
			// shell could never finish expanding.
			const outermost = frames[0]
			return errorAt(outermost.kind, outermost.openIndex)
		}
		return null
	}

	/**
	 * Consume a `$((…))` or `$[…]` arithmetic expression. `closed` reports
	 * whether the closing delimiter was found; callers fail closed when it is
	 * missing (bash refuses an unclosed opener), and only a closed
	 * expression's interior is expansion-walked.
	 */
	const skipArithmetic = (i: number): { end: number; closed: boolean } => {
		if (text[i + 1] === "[") {
			const close = text.indexOf("]", i + 2)
			return close === -1 ? { end: text.length, closed: false } : { end: close + 1, closed: true }
		}
		// $(( … )): balance plain parens; an unbalanced scan runs to end of input.
		let depth = 2 // the two opening parens
		let j = i + 3
		while (j < text.length && depth > 0) {
			if (text[j] === "(") {
				depth++
			} else if (text[j] === ")") {
				depth--
			}
			j++
		}
		return { end: j, closed: depth === 0 }
	}

	/** End index just past a `$name` or `$<special>` token at `i`, or null. */
	const scanVariable = (i: number): number | null => {
		const next = text[i + 1]
		if (next === undefined) {
			return null
		}
		if (isIdentStart(next)) {
			let j = i + 1
			while (j < text.length && isIdentChar(text[j])) {
				j++
			}
			return j
		}
		if (SPECIAL_VAR_CHARS.includes(next)) {
			return i + 2
		}
		return null
	}

	/** End index past a `2>&1`-style redirection at `i`, or null. */
	const scanRedirection = (i: number): number | null => {
		let j = i
		if (text[j] === ">" && text[j + 1] === "&") {
			j += 2
			while (j < text.length && "0123456789".includes(text[j])) {
				j++
			}
			return j
		}
		while (j < text.length && "0123456789".includes(text[j])) {
			j++
		}
		if (j > i && text[j] === ">" && text[j + 1] === "&") {
			j += 2
			while (j < text.length && "0123456789".includes(text[j])) {
				j++
			}
			return j
		}
		return null
	}

	let i = 0
	while (i < text.length) {
		const char = text[i]
		const top = stack[stack.length - 1]

		if (top) {
			if (top.escaped && char === "\\") {
				i += 2
				continue
			}
			if (char === top.closer) {
				if (top.groupDepth > 0) {
					// This closer matches an inner grouping paren opened inside the
					// region, not the region's own opener: the subshell group
					// balances before the substitution frame does.
					top.groupDepth--
					i++
					continue
				}
				const closeEnd = i + 1
				const closed = stack.pop() as RegionFrame
				if (closed.kind === "parameter-expansion") {
					paramFramesOpen--
				}
				if (QUOTE_FRAME_KINDS.includes(closed.kind)) {
					// Quote regions restore verbatim; at the top level they mask to a
					// single opaque word so their contents can never tokenize as syntax.
					if (stack.length === 0) {
						const id = outcome.quotes.push(text.slice(closed.openIndex, closeEnd)) - 1
						outcome.host += mark(`Q${id}`)
					}
					i = closeEnd
					continue
				}
				if (stack.length === 0) {
					if (closed.kind === "parameter-expansion") {
						// The expansion's text stays verbatim in the host segment; its
						// inner substitutions are extracted independently.
						const id = outcome.params.push(text.slice(closed.openIndex, closeEnd)) - 1
						outcome.paramPayloads[id] = closed.payloads ?? []
						outcome.host += mark(`P${id}`)
					} else {
						const id = outcome.substitutions.push(text.slice(closed.contentStart, i).trim()) - 1
						outcome.host += mark(`S${id}`)
					}
					expansionCloseEnd = closeEnd
				} else {
					// Nested inside an expansion region: a substitution inside a
					// parameter expansion belongs to that expansion's payload list;
					// anything deeper is recovered when the enclosing payload is
					// re-scanned, so its inner text is sliced only where a consumer
					// exists (otherwise deep nesting would cost O(n²)).
					const paramAncestor = innermostParam(stack, paramFramesOpen)
					if (closed.kind === "parameter-expansion") {
						paramAncestor?.payloads?.push(...(closed.payloads ?? []))
					} else if (paramAncestor) {
						paramAncestor.payloads?.push(text.slice(closed.contentStart, i).trim())
					}
				}
				i = closeEnd
				continue
			}
			// A quote frame is opaque except for its own closer and escapes; a
			// backtick region is opaque except for its closer (backticks do not
			// nest). Only expansion frames descend for nested constructs.
			if (QUOTE_FRAME_KINDS.includes(top.kind) || top.kind === "backtick") {
				i++
				continue
			}
			// A bare `(` inside a substitution region opens a subshell group the
			// shell balances independently of the region's closer; tracking its
			// depth keeps the group's `)` from popping the substitution frame.
			// `(`/`)` inside a parameter expansion stay literal word characters.
			if ((top.kind === "command-substitution" || top.kind === "process-substitution") && char === "(") {
				top.groupDepth++
				i++
				continue
			}
			// Inside an expansion region: balance nested constructs, never emit host
			// text (the whole region is replaced by one placeholder when it closes).
			const nestedQuote = openQuote(i)
			if (nestedQuote) {
				stack.push(nestedQuote)
				i = nestedQuote.contentStart
				continue
			}
			if (char === "$") {
				if (text[i + 1] === "(") {
					if (text[i + 2] === "(") {
						const arith = skipArithmetic(i)
						// Fail closed here rather than letting the outer region
						// error at end of input: that would name the wrong opener
						// and silently drop the arithmetic's interior payloads.
						if (!arith.closed) {
							outcome.error = errorAt("arithmetic", i)
							return outcome
						}
						const arithPayloads: string[] = []
						const arithError = walkBodyPayloads(i + 3, arith.end - 2, arithPayloads, 0)
						if (arithError) {
							outcome.error = arithError
							return outcome
						}
						// The enclosing region is masked wholesale, so route the
						// substitutions to the innermost expansion ancestor like a
						// nested close does.
						innermostParam(stack, paramFramesOpen)?.payloads?.push(...arithPayloads)
						i = arith.end
						continue
					}
					stack.push({
						kind: "command-substitution",
						openIndex: i,
						closer: ")",
						contentStart: i + 2,
						escaped: true,
						groupDepth: 0,
						payloads: null,
					})
					i += 2
					continue
				}
				if (text[i + 1] === "{") {
					stack.push({
						kind: "parameter-expansion",
						openIndex: i,
						closer: "}",
						contentStart: i + 2,
						escaped: true,
						groupDepth: 0,
						payloads: [],
					})
					paramFramesOpen++
					i += 2
					continue
				}
				i++
				continue
			}
			if (char === "`") {
				stack.push({
					kind: "backtick",
					openIndex: i,
					closer: "`",
					contentStart: i + 1,
					escaped: true,
					groupDepth: 0,
					payloads: null,
				})
				i++
				continue
			}
			if ((char === "<" || char === ">") && text[i + 1] === "(") {
				stack.push({
					kind: "process-substitution",
					openIndex: i,
					closer: ")",
					contentStart: i + 2,
					escaped: true,
					groupDepth: 0,
					payloads: null,
				})
				i += 2
				continue
			}
			if (char === "<" && text[i + 1] === "<" && text[i + 2] !== "<") {
				const result = skipHeredoc(i, stack)
				if ("error" in result) {
					outcome.error = result.error
					return outcome
				}
				i = result.end
				continue
			}
			i++
			continue
		}

		// Nothing is open: full scanning with host emission.
		if (char === "\\") {
			// A backslash escapes the next character; a quote after it is literal.
			outcome.host += text.slice(i, i + 2)
			escapedWordCharEnd = i + 2
			i += 2
			continue
		}
		if (char === "#" && i === expansionCloseEnd) {
			// A `#` riding directly against the closer of an expansion or quote
			// region continues the surrounding word: the shell ends the expansion
			// at its closer but not the word, and starts a comment only at a word
			// start. The tokenizer comments at any unquoted `#`, so the character
			// goes through tokenization as an opaque placeholder (like the
			// mid-word case below) and expands back verbatim, keeping the rest of
			// the line parseable instead of dropping it as comment text.
			const id = outcome.variables.push("#") - 1
			outcome.host += mark(`V${id}`)
			i++
			continue
		}
		if (char === "#" && (i === 0 || (/\s/.test(text[i - 1]) && i !== escapedWordCharEnd))) {
			// Comment: pass the rest of the line through untouched. Quotes and
			// delimiters inside a comment are not shell syntax; shell-quote drops
			// the comment text when tokenizing. A `#` at the end of a `\c` escape
			// pair is excluded even when the escaped character is whitespace: the
			// escape makes it word content, so this `#` continues the word and the
			// masking branch below handles it.
			const end = endOfLine(i)
			outcome.host += text.slice(i, end)
			i = end
			continue
		}
		if (char === "#" && (!/[;&()|<>]/.test(text[i - 1]) || i === escapedWordCharEnd)) {
			// A `#` inside a word is an ordinary character to the shell: a
			// comment starts only at a word start. The tokenizer starts a comment
			// at any `#`, so a mid-word one goes through tokenization as an
			// opaque placeholder and expands back verbatim, instead of dropping
			// the rest of the line including a real separator riding after it.
			// The character right after a `\c` escape pair is also word interior
			// — an escaped character is a literal word character to the shell —
			// so a `#` at that position rides the placeholder channel even when
			// the raw character before it is whitespace or a metacharacter. What
			// reaches the tokenizer unmasked sits at a real word start (index 0,
			// after whitespace, or after a bare metacharacter), where the shell
			// starts a comment too.
			const id = outcome.variables.push("#") - 1
			outcome.host += mark(`V${id}`)
			i++
			continue
		}
		if (char === "<" && text[i + 1] === "<" && text[i + 2] === "<") {
			// Herestring (<<<): single-line stdin redirect with no body or
			// terminator; the word after it is an ordinary shell word.
			outcome.host += "<<<"
			i += 3
			continue
		}
		if (char === "<" && text[i + 1] === "<") {
			const result = skipHeredoc(i, stack)
			if ("error" in result) {
				outcome.error = result.error
				return outcome
			}
			i = result.end
			continue
		}
		if ((char === "<" || char === ">") && text[i + 1] === "(") {
			stack.push({
				kind: "process-substitution",
				openIndex: i,
				closer: ")",
				contentStart: i + 2,
				escaped: true,
				groupDepth: 0,
				payloads: null,
			})
			i += 2
			continue
		}
		if (char === "(") {
			// Bare grouping/array-assignment paren: host text, never extracted,
			// never an error (unclosed or not). The depth counter exists only so
			// a matching `)` is not misread as a stray closer.
			parenDepth++
			outcome.host += char
			i++
			continue
		}
		if (char === ")" && parenDepth > 0) {
			parenDepth--
			outcome.host += char
			i++
			continue
		}
		if (char === ")" || char === "}") {
			// A closer at depth 0 with no opener: the shell would refuse this
			// input, so fail closed instead of approving a partial decomposition.
			outcome.error = errorAt("stray-closer", i)
			return outcome
		}
		if (char === "`") {
			stack.push({
				kind: "backtick",
				openIndex: i,
				closer: "`",
				contentStart: i + 1,
				escaped: true,
				groupDepth: 0,
				payloads: null,
			})
			i++
			continue
		}
		if (char === "$") {
			const dollarQuote = openQuote(i)
			if (dollarQuote) {
				stack.push(dollarQuote)
				i = dollarQuote.contentStart
				continue
			}
			if (text[i + 1] === "(") {
				if (text[i + 2] === "(") {
					const arith = skipArithmetic(i)
					// An unclosed opener fails closed: masking the remainder
					// to end of input would hide its text behind the host word.
					if (!arith.closed) {
						outcome.error = errorAt("arithmetic", i)
						return outcome
					}
					// The shell performs command substitutions inside a
					// $((…)) exactly like anywhere else, so they are extracted
					// as independent segments and must balance.
					const arithPayloads: string[] = []
					const arithError = walkBodyPayloads(i + 3, arith.end - 2, arithPayloads, 0)
					if (arithError) {
						outcome.error = arithError
						return outcome
					}
					const id = outcome.arithmetic.push(text.slice(i, arith.end)) - 1
					outcome.arithmeticPayloads[id] = arithPayloads
					outcome.host += mark(`A${id}`)
					expansionCloseEnd = arith.end
					i = arith.end
					continue
				}
				stack.push({
					kind: "command-substitution",
					openIndex: i,
					closer: ")",
					contentStart: i + 2,
					escaped: true,
					groupDepth: 0,
					payloads: null,
				})
				i += 2
				continue
			}
			if (text[i + 1] === "{") {
				stack.push({
					kind: "parameter-expansion",
					openIndex: i,
					closer: "}",
					contentStart: i + 2,
					escaped: true,
					groupDepth: 0,
					payloads: [],
				})
				paramFramesOpen++
				i += 2
				continue
			}
			if (text[i + 1] === "[") {
				const arith = skipArithmetic(i)
				// An unclosed opener fails closed: masking the remainder
				// to end of input would hide its text behind the host word.
				if (!arith.closed) {
					outcome.error = errorAt("arithmetic", i)
					return outcome
				}
				// The shell performs command substitutions inside a $[…]
				// exactly like anywhere else, so they are extracted as
				// independent segments and must balance.
				const arithPayloads: string[] = []
				const arithError = walkBodyPayloads(i + 2, arith.end - 1, arithPayloads, 0)
				if (arithError) {
					outcome.error = arithError
					return outcome
				}
				const id = outcome.arithmetic.push(text.slice(i, arith.end)) - 1
				outcome.arithmeticPayloads[id] = arithPayloads
				outcome.host += mark(`A${id}`)
				expansionCloseEnd = arith.end
				i = arith.end
				continue
			}
			const varEnd = scanVariable(i)
			if (varEnd !== null) {
				const id = outcome.variables.push(text.slice(i, varEnd)) - 1
				outcome.host += mark(`V${id}`)
				i = varEnd
				continue
			}
			outcome.host += "$"
			i++
			continue
		}
		const quote = openQuote(i)
		if (quote) {
			stack.push(quote)
			i = quote.contentStart
			continue
		}
		if (char === ">" || "0123456789".includes(char)) {
			const redirEnd = scanRedirection(i)
			if (redirEnd !== null) {
				const id = outcome.redirections.push(text.slice(i, redirEnd)) - 1
				outcome.host += mark(`R${id}`)
				i = redirEnd
				continue
			}
		}
		outcome.host += char
		i++
	}

	if (stack.length > 0) {
		// Delimiters still open at end of input: report the outermost one — the
		// first construct the shell could never finish reading.
		const outermost = stack[0]
		outcome.error = errorAt(outermost.kind, outermost.openIndex)
	}

	return outcome
}

/**
 * Parse a heredoc delimiter word starting at position `start` in `command`.
 * The word is walked with bash's quoting rules: a quote character opens a
 * quote region anywhere in the word (mid-word as well as at the start), a
 * quote region spans newlines until its closing quote, and a backslash
 * escapes the next character — inside double quotes only the characters in
 * `DOUBLE_QUOTE_ESCAPABLE`, outside quotes anything (backslash-newline drops
 * the newline as a line continuation everywhere). Quote removal produces the
 * bare word a terminator line must equal exactly.
 *
 * Returns:
 * - `delimiter`: the word after quote removal (terminator text; empty for
 *   `<<''`, which bash terminates at the first blank body line).
 * - `endIndex`: index of the first character after the delimiter token.
 * - `quoted`: whether any quoting construct appeared -- a quoted/escaped
 *   delimiter suppresses all expansion in the body.
 * - `wordPresent`: whether any delimiter token appeared at all (bare `<<`
 *   before end of line has none).
 * - `malformed`: whether the word reached end of input with a quote region
 *   still open. bash then reads the delimiter as a multi-line word that can
 *   never match a body line while the opener line's tail keeps executing as
 *   ordinary syntax, so no body can be accounted for.
 */
function parseHeredocDelimiter(
	command: string,
	start: number,
): {
	delimiter: string
	endIndex: number
	quoted: boolean
	wordPresent: boolean
	malformed: boolean
} {
	let i = start
	let delimiter = ""
	let quoted = false
	// The quote region currently open inside the word, if any.
	let quote: "'" | '"' | null = null

	while (i < command.length) {
		const char = command[i]
		if (quote) {
			if (char === quote) {
				quote = null
			} else if (quote === '"' && char === "\\" && i + 1 < command.length) {
				// Inside double quotes only `DOUBLE_QUOTE_ESCAPABLE` is
				// escapable: the backslash drops before those characters and
				// stays literal text of the word before anything else.
				// Backslash-newline drops both (line continuation).
				if (command[i + 1] !== "\n") {
					const next = command[i + 1]
					delimiter += DOUBLE_QUOTE_ESCAPABLE.includes(next) ? next : char + next
				}
				i += 2
				continue
			} else {
				// Inside a quote, newlines and blanks are ordinary word content:
				// bash closes the word only at the matching quote.
				delimiter += char
			}
			i++
			continue
		}
		if (char === "'" || char === '"') {
			quote = char
			quoted = true
			i++
			continue
		}
		if (char === "\\") {
			quoted = true
			if (i + 1 < command.length) {
				if (command[i + 1] !== "\n") {
					delimiter += command[i + 1]
				}
				i += 2
				continue
			}
			i++
			continue
		}
		// An unquoted space/tab/newline/CR ends the word. A CR is a boundary so
		// a CRLF-bounded well-formed opener keeps its terminator line matchable
		// (the CR belongs to the line ending, not to the delimiter).
		if (char === " " || char === "\t" || char === "\n" || char === "\r") {
			break
		}
		delimiter += char
		i++
	}

	return {
		delimiter,
		endIndex: i,
		quoted,
		wordPresent: i > start,
		malformed: quote !== null,
	}
}

/** Look up the raw text a placeholder name stands for, or undefined. */
function lookupPlaceholder(name: string, outcome: ScanOutcome, includeSubstitutions: boolean): string | undefined {
	const index = Number(name.slice(1))
	switch (name[0]) {
		case "Q":
			return outcome.quotes[index]
		case "H":
			return outcome.heredocs[index]
		case "P":
			return outcome.params[index]
		case "V":
			return outcome.variables[index]
		case "R":
			return outcome.redirections[index]
		case "A":
			return outcome.arithmetic[index]
		case "S":
			// Substitutions are only restored inline on the crude-split fallback
			// path; the normal path turns them into independent segments.
			return includeSubstitutions ? outcome.substitutions[index] : undefined
		default:
			return undefined
	}
}

/**
 * Replace every sentinel-delimited placeholder in `text` with its raw text.
 * Split on the sentinel rather than a regex: a placeholder name is everything
 * between two sentinels by construction. A raw NUL in the input is rejected up
 * front by the scan (see QuoteType "nul-byte"), so no input can carry a
 * sentinel to collide with here.
 */
function expandPlaceholders(text: string, outcome: ScanOutcome, includeSubstitutions: boolean): string {
	if (!text.includes(NUL)) {
		return text
	}
	const parts = text.split(NUL)
	let out = ""
	for (let p = 0; p < parts.length; p++) {
		if (p % 2 === 0) {
			out += parts[p]
			continue
		}
		const value = lookupPlaceholder(parts[p], outcome, includeSubstitutions)
		if (value !== undefined) {
			out += value
		}
	}
	return out
}

/**
 * Split a command string into individual sub-commands by
 * chaining operators (&&, ||, ;, |, or &) and unquoted newlines.
 *
 * One quote-aware scan (`scanShellSyntax`) does all structure analysis in a
 * single left-to-right pass; `shell-quote` then tokenizes the masked host text:
 * - Quoted strings stay opaque, including multi-line quoted strings, which is
 *   why only unquoted newlines split commands (the key invariant: newlines
 *   inside a quoted string are argument text, never separators).
 * - Every command substitution — `$(…)`, backticks, `<(…)`, `>(…)` — is
 *   extracted with balanced-paren awareness wherever it sits (nested, inside a
 *   `${…}` expansion, inside a process substitution, or inside a heredoc with
 *   an unquoted delimiter) and becomes its own segment, so each inner command
 *   matches the allow/deny lists on its own. Parameter-expansion and heredoc
 *   hosts keep their verbatim text as one segment.
 * - PowerShell-style redirections (2>&1), variables, and arithmetic stay
 *   inside their host word.
 *
 * Returns a `ParseResult` containing the list of sub-commands and an optional
 * `parseError` that is non-null when the input is unaccountable (an
 * unterminated quote or heredoc, an expansion delimiter or arithmetic
 * expression opened but never closed, a stray closer, a raw NUL byte, or
 * substitution nesting beyond the re-scan depth cap). When `parseError` is
 * set the `commands` array contains
 * the raw input as a single opaque token: a command whose structure the parser
 * cannot fully account for must cost a prompt, never a free pass built on a
 * partial decomposition.
 */
export function parseCommand(command: string): ParseResult {
	// A NUL byte is not whitespace, so a NUL-bearing command still reaches the
	// scan, where the nul-byte guard rejects it.
	if (!command?.trim()) {
		return { commands: [], parseError: null }
	}

	// Run the shared state-machine scan once. It yields the masked host text,
	// the extracted substitution payloads, and the structural-error descriptor
	// in a single pass.
	const outcome = scanShellSyntax(command)

	// Reject syntactically malformed input. Return the raw input as a single
	// opaque token so callers surface the error to the agent rather than
	// splitting unsafe fragments that might be auto-approved in isolation.
	if (outcome.error !== null) {
		return { commands: [command], parseError: outcome.error }
	}

	const allCommands: string[] = []

	for (const line of outcome.host.split(/\r\n|\r|\n/)) {
		if (!line.trim()) {
			continue
		}
		allCommands.push(...parseLine(line, outcome, 0))
		if (outcome.error !== null) {
			return { commands: [command], parseError: outcome.error }
		}
	}

	return { commands: allCommands, parseError: null }
}

/**
 * Tokenize one masked host line into segments.
 *
 * A chain operator flushes the current segment. A substitution placeholder also
 * flushes and takes the place of its payload's own segments — the payload is
 * re-scanned through the same path, so nested substitutions become independent
 * segments. Placeholders that do not force a split (quotes, parameter
 * expansions, heredocs, variables, redirections, arithmetic) join the current
 * word and are restored verbatim; a parameter expansion, heredoc, or closed
 * `$((…))` additionally queues its extracted inner substitutions, which flush
 * right after the host segment that still contains their verbatim text.
 *
 * Structural errors found while recursing into payloads are recorded on
 * `outcome` (fail-closed); the caller checks it after every line. `depth`
 * counts payload re-entries and is capped by `scanPayloadSegments`.
 */
function parseLine(line: string, outcome: ScanOutcome, depth: number): string[] {
	let tokens: ShellToken[]
	try {
		tokens = parse(line) as ShellToken[]
	} catch (error) {
		// If shell-quote fails to parse, fall back to simple splitting. This path
		// does not recurse into payloads; every placeholder restores to its raw
		// (for substitutions: inner) text so callers never see internal markers.
		const message = error instanceof Error ? error.message : String(error)
		console.warn("shell-quote parse error:", message, "for command:", line)

		return line
			.split(/(?:&&|\|\||;|\||&)/)
			.map((cmd) => expandPlaceholders(cmd.trim(), outcome, true))
			.filter((cmd) => cmd.length > 0)
	}

	const commands: string[] = []
	let current: string[] = []
	let pendingPayloads: string[] = []

	const flush = (): void => {
		if (current.length > 0) {
			commands.push(expandPlaceholders(current.join(" "), outcome, false))
			current = []
		}
		for (const raw of pendingPayloads) {
			commands.push(...scanPayloadSegments(raw, outcome, depth + 1))
		}
		pendingPayloads = []
	}

	for (const token of tokens) {
		if (typeof token === "object" && "op" in token) {
			if (["&&", "||", ";", "|", "&"].includes(token.op)) {
				flush()
			} else {
				// Other operators (>, <) are part of the command word.
				current.push(token.op)
			}
			continue
		}
		if (typeof token !== "string") {
			continue
		}
		if (!token.includes(NUL)) {
			current.push(token)
			continue
		}
		// A word carrying placeholders: reconstruct non-substitution placeholders
		// for verbatim restoration, and treat substitution placeholders as segment
		// boundaries.
		const parts = token.split(NUL)
		let buf = ""
		for (let p = 0; p < parts.length; p++) {
			const part = parts[p]
			if (p % 2 === 0) {
				buf += part
				continue
			}
			const index = Number(part.slice(1))
			if (part[0] === "S") {
				if (buf) {
					current.push(buf)
					buf = ""
				}
				flush()
				commands.push(...scanPayloadSegments(outcome.substitutions[index] ?? "", outcome, depth + 1))
				continue
			}
			if (part[0] === "P") {
				pendingPayloads.push(...(outcome.paramPayloads[index] ?? []))
			}
			if (part[0] === "H") {
				pendingPayloads.push(...(outcome.heredocPayloads[index] ?? []))
			}
			if (part[0] === "A") {
				pendingPayloads.push(...(outcome.arithmeticPayloads[index] ?? []))
			}
			buf += `${NUL}${part}${NUL}`
		}
		if (buf) {
			current.push(buf)
		}
	}
	flush()

	return commands
}

/**
 * Re-scan an extracted substitution payload through the same scan + tokenize
 * path so nested substitutions become independent segments. Records structural
 * errors on `outcome` (the outer command then fails closed). Each re-entry
 * increments `depth`; past `MAX_PAYLOAD_SCAN_DEPTH` the command fails closed as
 * `nesting-too-deep` instead of re-scanning generated nesting until the call
 * stack overflows.
 */
function scanPayloadSegments(raw: string, outcome: ScanOutcome, depth: number): string[] {
	if (!raw.trim()) {
		return []
	}
	if (depth > MAX_PAYLOAD_SCAN_DEPTH) {
		outcome.error = {
			quoteType: "nesting-too-deep",
			openIndex: 0,
			message: unterminatedQuoteMessage("nesting-too-deep", 0, raw),
		}
		return []
	}
	const nested = scanShellSyntax(raw)
	if (nested.error !== null) {
		outcome.error = nested.error
		return []
	}
	const parts: string[] = []
	for (const line of nested.host.split(/\r\n|\r|\n/)) {
		if (!line.trim()) {
			continue
		}
		parts.push(...parseLine(line, nested, depth))
		if (nested.error !== null) {
			outcome.error = nested.error
			return []
		}
	}
	return parts
}
