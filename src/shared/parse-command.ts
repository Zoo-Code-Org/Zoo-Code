import { parse } from "shell-quote"

export type ShellToken = string | { op: string } | { command: string }

/**
 * The kind of structural region a malformed-command error refers to.
 *
 * Quote and heredoc kinds describe regions that open and never close:
 *
 * - `posix-single` and `ansi-c` share the `'` delimiter. They follow different
 *   escaping rules, so the parser must tell them apart.
 * - `locale` and `double` share the `"` delimiter. A `$` prefix marks
 *   `locale`. The `$"..."` form is therefore a distinct token, and
 *   restoration stays accurate.
 * - `heredoc` covers `<<WORD`, `<<'WORD'`, `<<"WORD"`, and `<<\WORD` openers.
 *   Their body extends through the terminator line.
 *
 * Expansion kinds describe delimiters the scanner balances while it extracts
 * command substitutions. `stray-closer` is the opposite failure: a `}` with
 * no matching opener.
 *
 * - `command-substitution`: a `$(` that never closes.
 * - `process-substitution`: a `<(…` or `>(…` that never closes.
 * - `parameter-expansion`: a `${` that never closes.
 * - `backtick`: a backtick region that never closes.
 * - `arithmetic`: an arithmetic expression (`$((` or `$[`) that never
 *   closes.
 * - `stray-closer`: a `}` at nesting depth 0 with no matching `{`. The scan
 *   reports it outside any quoted region, comment, or heredoc body. A
 *   depth-0 `)` is host text instead. bash closes `case` patterns with `)`.
 *
 * Rejection kinds describe input the scan refuses outright. The scan never
 * tokenizes such input. Neither kind can grant an approval: the tool call
 * fails with an error instead of reaching the approval prompt:
 *
 * - `nul-byte`: a raw NUL byte anywhere in the command. NUL is the scan's
 *   placeholder sentinel. An input that contains one could corrupt the
 *   masked-text round trip.
 * - `nesting-too-deep`: the scan re-scans substitution payloads beyond
 *   `MAX_PAYLOAD_SCAN_DEPTH` levels. Such input is generated, not a human
 *   command.
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
 * `commands` is the list of individual sub-commands. The splitter cuts on
 * unquoted newlines and chain operators. When `parseError` is non-null, the
 * command string is malformed. Causes: an unterminated quote or heredoc, an
 * expansion delimiter or arithmetic expression that never closes, a stray
 * closer, a raw NUL byte, or substitution nesting beyond the re-scan depth
 * cap. `commands` then holds the raw input as one opaque token. Callers can
 * surface the error without splitting unsafe fragments.
 *
 * Callers that only need the sub-command list can destructure `{ commands }`.
 * A caller that must tell a parse error from a normal single-command result
 * also inspects `parseError`.
 */
export interface ParseResult {
	commands: string[]
	parseError: UnterminatedQuote | null
}

/**
 * The scan could not account for the delimiter this object describes. The
 * delimiter is a quote, heredoc, or expansion region that never closes, or a
 * `}` at depth 0 with no matching `{`.
 *
 * - `quoteType`: the kind of the offending construct.
 * - `openIndex`: the index, in the scanned command string, of the character
 *   that opened the region. For ANSI-C and locale quoting it points at the
 *   leading `$`. For heredocs it points at the first `<`. For a stray closer
 *   it points at the closer itself. The position lets a caller report a
 *   located error instead of a generic message.
 */
export interface UnterminatedQuote {
	quoteType: QuoteType
	openIndex: number
	/** Human-readable description suitable for surfacing to an agent as a tool error. */
	message: string
}

/**
 * Build the human-readable error message for a structural parse failure.
 * The message includes a short excerpt of the command around the offending
 * character. The excerpt gives the agent enough context to locate and fix the
 * problem.
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
 * Report the first structural problem in `command`. Return `null` when every
 * quoted region, heredoc, and expansion delimiter closes properly and no
 * closer appears without its opener.
 *
 * A regex cannot answer "can a shell parse this?" because shell syntax is
 * context-sensitive. Outside single quotes a backslash escapes the next
 * character. A `#` may begin a comment that the parser must ignore. A quote
 * inside double quotes is literal text. Nesting must be balanced. The shared
 * state-machine walk in `scanShellSyntax` mirrors POSIX tokenization. It
 * accepts legitimate multi-line quoted arguments and detects genuinely
 * malformed input.
 *
 * A shell never looks at unbalanced delimiter characters inside ordinary
 * quoted regions, so this check does not look at them either. They stay
 * parseable.
 *
 * @internal
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

/** An open region the scanner is inside. One entry per unclosed delimiter. */
interface RegionFrame {
	kind: FrameKind
	/** Index of the first character of the opening delimiter. */
	openIndex: number
	/** The single character that closes this region. */
	closer: string
	/** Index just after the opening delimiter. The region's content starts there. */
	contentStart: number
	/** Whether a backslash inside the region escapes the next character. */
	escaped: boolean
	/**
	 * For command/process-substitution frames: the number of bare `(` grouping
	 * parentheses that are open inside the region. A subshell group balances
	 * independently of the frame's own closer. While this counter is positive,
	 * a `)` matches the group and must not pop the frame.
	 */
	groupDepth: number
	/**
	 * For parameter-expansion frames: every command substitution the scan
	 * closed inside the expansion, at any nesting depth. A parameter expansion
	 * hides its text from the tokenizer. It must not stop substitution
	 * extraction, because the shell expands `${x:-$(cmd)}` exactly like
	 * `$(cmd)`.
	 */
	payloads: string[] | null
}

/**
 * One open region in the heredoc opener-line remainder walk. Mirrors just the
 * closer-balancing state of `RegionFrame`: enough to know when a top-level
 * region closes, which decides whether a following `#` continues the word.
 * `backtick` marks the opaque backtick kind: a backtick region balances only
 * against its own closer, never against a nested opener.
 */
interface RemainderFrame {
	/** The single character that closes this region. */
	closer: string
	/** Bare `(` grouping opened inside a `)`-closing region, not yet closed. */
	groupDepth: number
	/** Whether this is the opaque backtick kind. */
	backtick: boolean
}

/**
 * One scan fills this object. It holds the masked host text, the structural
 * error if one exists, and the masked-away constructs. The tokenizer restores
 * those constructs or recurses into them.
 */
interface ScanOutcome {
	/**
	 * The scan replaces every quoted region, heredoc, parameter expansion,
	 * arithmetic expression, variable, and redirection with an opaque
	 * placeholder word. It replaces every command substitution with a boundary
	 * placeholder. The result contains no active shell syntax, so
	 * `shell-quote` can tokenize it safely.
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
	/** Raw text (redirect operator and delimiter word through terminator) of each heredoc. */
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
 * This sentinel separates placeholder names in masked host text. The scan
 * rejects any input that contains a raw NUL (`nul-byte`) up front. A
 * placeholder name can therefore never collide with command text. A printable
 * `__NAME_0__` marker could collide, because an input can contain it
 * literally.
 */
const NUL = "\x00"

/**
 * Cap on payload re-scan depth. The scan re-scans every substitution payload
 * through the full path. With no cap, a few tens of KB of generated input
 * consumes minutes of CPU through quadratic suffix re-scans. The call stack
 * finally overflows. The cap fails closed instead. No hand-written command
 * nests a substitution 64 deep.
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
 * Scan `text` once, from left to right, with quote awareness. The scan tracks
 * quote state, delimiter depth, and heredoc state at the same time. One pass
 * emits masked host text, extracted substitution payloads, and a structural
 * error.
 *
 * Shell scope: the scan parses bash/POSIX-style shell syntax only. The
 * reference shell on the Windows target is msys/Cygwin bash. The scan does
 * not parse other shells as such. It reads their input with the same bash
 * rules. PowerShell input shows two consequences. A backtick is PowerShell's
 * escape character. The scan reads a backtick as a command-substitution
 * opener. A backtick that never closes fails closed (`backtick`). `{ ... }`
 * is a PowerShell script block. The scan applies bash brace rules. Balanced
 * braces stay ordinary word content. An unmatched `}` at depth 0 fails closed
 * (`stray-closer`).
 *
 * Invariants the rest of the file depends on:
 *
 * - Quoted regions (`'…'`, `"…"`, `$'…'`, `$"…"`) are opaque to extraction.
 *   The scan masks their contents whole and returns them verbatim. An
 *   unbalanced delimiter inside one is never an error. A shell never parses
 *   them there. A shell does expand `"$(cmd)"`. Extraction inside quoted
 *   regions is deliberately out of scope, so such payloads stay masked.
 * - The scan extracts `$(…)`, backticks, `<(`, and `>(`. When one closes, its
 *   raw inner text becomes a payload segment. The host keeps only an opaque
 *   boundary placeholder. The inner commands then match the allow/deny lists
 *   on their own. The scan re-scans payloads, so nesting yields independent
 *   segments.
 * - `${…}` masks its text. The scan restores it verbatim into the host
 *   segment. The scan still descends into it. Substitutions inside a parameter
 *   expansion are still extracted and balance-checked. This includes
 *   substitutions inside a heredoc body opened within the expansion. Those
 *   payloads go to the expansion's payload list.
 * - `$((…))` masks the expression as one host word. It never balances as an
 *   extraction delimiter. The scan extracts substitutions inside a closed
 *   `$((…))` and balance-checks them, because the shell expands them there. An
 *   unclosed `$((` or `$[` fails closed (`arithmetic`). bash refuses the
 *   input. Masking the remainder to end of input could hide an unclosed `$(`
 *   inside it. The scan only masks the interior of a bare `$[…]`. It never
 *   looks for substitutions there. Bare `(`…`)` grouping (subshell groups,
 *   array assignments) also stays host text. An unclosed one is never an
 *   error. A stray `)` is never an error either. bash closes `case` patterns
 *   with `)`. The scan tracks a bare `{` so that brace expansion, `@{1}`
 *   revspecs, and `find -exec {}` placeholders balance instead of erroring.
 * - Fail-closed rule: an error results when the scan opens one of the four
 *   extraction delimiters and cannot close it. An unclosed arithmetic opener
 *   (`$((`/`$[`), a `}` at depth 0 with no matching `{`, and a raw NUL byte
 *   anywhere in the input are errors too. So is payload re-scanning deeper
 *   than `MAX_PAYLOAD_SCAN_DEPTH`. A closer that does not match the open
 *   region's kind is literal content. That matches the shell. The still-open
 *   region then fails at end of input.
 * - Heredocs: the scan masks the redirect operator and delimiter word, the
 *   body, and the terminator line as one opaque host word. The masked
 *   construct stays a single segment
 *   however many lines it spans. The text after the delimiter word on the
 *   opener line is live host text: it stays out of the mask and splits at
 *   operator characters like any other host text. Lines end only at a line
 *   feed (LF). A carriage return (CR)
 *   counts only as the CR of a CR-and-LF pair (CRLF) on the opener line. A
 *   CR-only-separated opener does not validate a heredoc. bash reports such a
 *   construct as unterminated. The scan matches body lines against the
 *   delimiter with every CR removed. The msys/Cygwin read layer strips CR
 *   before parsing. That layer is the reference shell on the Windows target.
 *   The strip reaches every CR in the construct, the delimiter word and the
 *   terminator line included. POSIX bash keeps every CR as ordinary content.
 *   The two models can place the terminator on different lines. Either
 *   direction of divergence is unsafe. An early close hands the remaining
 *   body back to the scanner as live syntax. There it can open a new heredoc
 *   that masks commands the other model executes. A late close masks them
 *   outright. A CR anywhere in the region from the opener line through the
 *   closing terminator line means the two layers do not read the same bytes.
 *   The parser cannot verify that both models close at the same line. Such
 *   heredocs fail closed for review. The parser does not guess which model
 *   decides the boundary. It over-rejects even a uniformly-CRLF construct
 *   whose models happen to agree. That is the accepted cost of never picking
 *   a model. The scan parses only heredocs whose region has no CR. There both
 *   models read byte-identical text. An unquoted-delimiter body is
 *   expansion-active. A substitution opened inside it is extracted and must
 *   balance before the terminator. A quoted or backslash-escaped delimiter
 *   suppresses expansion entirely in the body. The shell does not expand
 *   those. Such a body stays opaque and is never balance-checked. A body
 *   carries no comments and is not tokenized outside an expansion region. A
 *   `"` or `#` there is literal text. Inside an expansion region, quotes and
 *   word-initial `#` comments follow the shell's rules there. A comment ends
 *   at the newline, not at the region end. The scan walks the opener line's
 *   remainder (the text after the delimiter word) for substitutions even when
 *   the delimiter is quoted. Quoting suppresses expansion in the body only.
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
	// Counts the parameter-expansion frames open on `stack`. While this count
	// is 0, `innermostParam` returns without walking the stack.
	let paramFramesOpen = 0
	// Counts bare `(` grouping (subshell groups, array assignments). Grouping
	// stays host text. It is not one of the extraction/fail-closed delimiters.
	// An unclosed `(` is never an error. A `)` is never an error either, with
	// or without an opener. The counter only tracks the grouping depth. Both
	// `)` cases reach the host.
	let parenDepth = 0
	// A bare `{` (brace expansion, `@{1}` revspec, `find -exec {}` placeholder)
	// also stays host text. The scan tracks the depth so that a `}` matching
	// an open bare `{` is not reported as a stray closer. The balance tracking
	// is deliberately coarse. This code has no shell-context reading of `{`,
	// only a pair.
	let braceDepth = 0
	// Index just past the most recent expansion or quote region that the scan
	// closed at host level, or -1. This includes `$((…))`/`$[…]`. The shell
	// ends the expansion at such a closer but not the surrounding word. A `#`
	// directly there is word content, never a comment start.
	let expansionCloseEnd = -1
	// Index just past the most recent `\c` escape pair that the scan emitted
	// at host level, or -1. To the shell, the escaped character is an ordinary
	// word character. The word continues past the pair. A `#` directly at this
	// index is word content, even when the escaped character is whitespace or
	// a metacharacter in the raw text.
	let escapedWordCharEnd = -1

	const mark = (name: string): string => `${NUL}${name}${NUL}`

	const errorAt = (kind: QuoteType, openIndex: number): UnterminatedQuote => ({
		quoteType: kind,
		openIndex,
		message: unterminatedQuoteMessage(kind, openIndex, text),
	})

	// Reject a raw NUL before any masking. NUL is this scan's placeholder
	// sentinel. An input containing one could degrade a masked placeholder
	// into inert literal text. That would hide a substitution from the lists.
	// Rejecting at the scan head also covers `findUnterminatedQuote`, which
	// shares this scan.
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
	 * Return the innermost parameter-expansion frame on `frames`, if any.
	 * `paramOpen` is the caller's count of open parameter-expansion frames.
	 * When it is 0, this function returns without walking the stack. Deep
	 * non-expansion nesting then pays no stack scan per frame close.
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
	 * Consume an entire heredoc at `i`: the opener line, the body, and the
	 * terminator. The redirect operator and delimiter word through the
	 * terminator mask to one host word; the opener-line remainder after the
	 * delimiter word stays live host text. Return the index just past the
	 * terminator text. Return an error for an unterminated heredoc or for an
	 * unbalanced delimiter inside an expansion-active body.
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
			// The delimiter word still has an open quote region at end of
			// input. bash reads it as a multi-line word that can never match a
			// body line. The opener line's tail keeps executing as ordinary
			// syntax. The body and everything after it are unaccountable, so
			// fail closed.
			return { error: errorAt("heredoc", start) }
		}
		if (!wordPresent && endIndex < text.length && text[endIndex] !== "\n" && text[endIndex] !== "\r") {
			// The blank-skipping loop consumed every blank, so an unclaimed
			// character here is a metacharacter: bash reads it as an operator
			// token where the delimiter word belongs, and rejects the whole
			// command before executing anything. The no-word mask below is the
			// policy for `<<` plus blanks only; this shape fails closed.
			return { error: errorAt("heredoc", start) }
		}
		const payloads: string[] = []
		// This is the only place a heredoc mask is emitted. Every non-error
		// outcome of skipHeredoc returns through here, so every masked span
		// carries the same check. A CR byte anywhere in the construct from the
		// opener through the terminator leaves the two read layers reading
		// different bytes. msys strips each CR before parsing, and POSIX keeps
		// it as ordinary content. A close that one layer sees may not be the
		// close the other sees. A close that only one layer sees would hand
		// that model's remainder back to the scanner as live syntax. The parser
		// cannot verify that both layers close the construct the same way. The
		// heredoc fails closed instead of picking a model. The check spans the
		// whole construct, opener-line remainder included, even though the
		// remainder masks out below. A uniformly-CRLF construct whose layers
		// happen to agree is over-rejected. That is the accepted cost.
		/**
		 * Append the opener-line remainder `[from, to)` to the host text. These
		 * bytes are live syntax that the outer scan loop never revisits, so the
		 * walk applies that loop's live-text policy here: a mid-word `#`
		 * becomes an opaque placeholder (the tokenizer would otherwise start a
		 * comment there and drop the rest of the line, hiding live commands), a
		 * word-initial `#` passes through as the comment bash sees, a `#`
		 * directly after the closer of an expansion or process substitution
		 * continues the word and takes the placeholder, and a backslash escape
		 * pair stays verbatim. Quote characters pass through too; the walk only
		 * tracks the regions so a quoted `#` stays literal.
		 */
		const emitRemainder = (from: number, to: number): void => {
			let i = from
			// Index just past the most recent `\c` escape pair, or -1. The
			// escaped character is word content to the shell, so a `#` directly
			// after the pair continues the word.
			let escapedEnd = -1
			let quote: "'" | '"' | null = null
			// Mirrors the scan loop's expansion state: the closers this walk
			// must balance before a top-level region ends, and the index just
			// past the most recent top-level region closer. The shell ends the
			// region at its closer but not the surrounding word, so a `#`
			// directly at that index is word content, never a comment start.
			// An unclosed region cannot reach this walk: `walkBodyPayloads`
			// has already balance-checked the remainder and fails the heredoc
			// closed on a region left open.
			const frames: RemainderFrame[] = []
			let closerEnd = -1
			while (i < to) {
				const char = text[i]
				if (char === "\\" && quote !== "'") {
					// Inside single quotes a backslash is literal, so only an
					// unquoted or double-quoted backslash pairs with the next
					// character.
					outcome.host += text.slice(i, i + 2)
					escapedEnd = i + 2
					i += 2
					continue
				}
				if (char === "'" || char === '"') {
					if (quote === null) {
						quote = char
					} else if (quote === char) {
						quote = null
					}
					outcome.host += char
					i++
					continue
				}
				if (quote === null) {
					const top = frames[frames.length - 1]
					if (top?.backtick) {
						// A backtick region is opaque except for its closer:
						// backticks do not nest and the shell re-scans nothing
						// inside that would rebalance it.
						if (char === "`") {
							frames.pop()
							if (frames.length === 0) {
								closerEnd = i + 1
							}
						}
						outcome.host += char
						i++
						continue
					}
					if (top && char === top.closer) {
						if (top.groupDepth > 0) {
							// This closer matches an inner grouping paren, not
							// the region's own opener.
							top.groupDepth--
						} else {
							frames.pop()
							if (frames.length === 0) {
								closerEnd = i + 1
							}
						}
						outcome.host += char
						i++
						continue
					}
					if (top?.closer === ")" && char === "(") {
						// A bare `(` inside a `)`-closing region opens a group
						// the shell balances before the region's closer, so the
						// group's `)` cannot end the region. `(`/`)` inside a
						// `}`- or `]`-closing region stay literal.
						top.groupDepth++
						outcome.host += char
						i++
						continue
					}
					if (char === "$" && (text[i + 1] === "(" || text[i + 1] === "{" || text[i + 1] === "[")) {
						// A `$((` region starts with one inner group pending, so
						// it closes past its second `)`, like the loop's
						// arithmetic end.
						// Stryker disable next-line StringLiteral: either literal's erasure only leaves `doubleArith` false, and the walk re-counts the second `(` as an ordinary group paren at the same depth, so no reachable remainder emits different host bytes or splits.
						const doubleArith = text[i + 1] === "(" && text[i + 2] === "("
						const closer = text[i + 1] === "(" ? ")" : text[i + 1] === "[" ? "]" : "}"
						frames.push({ closer, groupDepth: doubleArith ? 1 : 0, backtick: false })
						outcome.host += char
						outcome.host += text[i + 1]
						if (doubleArith) {
							outcome.host += text[i + 2]
						}
						i += doubleArith ? 3 : 2
						continue
					}
					if (char === "`") {
						frames.push({ closer: "`", groupDepth: 0, backtick: true })
						outcome.host += char
						i++
						continue
					}
					if ((char === "<" || char === ">") && text[i + 1] === "(") {
						frames.push({ closer: ")", groupDepth: 0, backtick: false })
						outcome.host += `${char}(`
						i += 2
						continue
					}
				}
				if (char === "#" && quote === null) {
					if (i === closerEnd) {
						// A `#` directly after a region closer continues the
						// word: the shell ends the region at its closer but not
						// the word, and starts a comment only at a word start.
						// The placeholder keeps the rest of the line
						// tokenizable, as the mid-word case below does.
						const id = outcome.variables.push("#") - 1
						outcome.host += mark(`V${id}`)
						i++
						continue
					}
					const wordStart = i === from || /\s/.test(text[i - 1]) || /[;&()|<>]/.test(text[i - 1])
					if (wordStart && i !== escapedEnd) {
						// A comment starts only at a word start. The tokenizer
						// and bash agree here: both drop the text from the `#`
						// to end of line.
						outcome.host += text.slice(i, to)
						return
					}
					// Mid-word `#`: an ordinary character to the shell, a
					// comment start to the tokenizer. Mask it to an opaque
					// placeholder so the rest of the line survives tokenization.
					const id = outcome.variables.push("#") - 1
					outcome.host += mark(`V${id}`)
					i++
					continue
				}
				outcome.host += char
				i++
			}
		}
		const emitMask = (end: number): { end: number } | { error: UnterminatedQuote } => {
			const fullSpan = text.slice(start, end)
			if (fullSpan.includes("\r")) {
				return { error: errorAt("heredoc", start) }
			}
			// The shell expands the text after the delimiter word on the opener
			// line. That remainder is live syntax, not opaque body: the mask
			// covers the redirect operator and delimiter word through the
			// terminator, while the opener-line remainder stays out of the
			// region and reaches the host text through the same masking the scan
			// applies to live text. A no-word opener masks through end of input
			// instead. The metacharacter guard in `skipHeredoc` fails a no-word
			// opener whose break was metacharacter-caused closed before any mask
			// is emitted, so the openers reaching this mask are `<<` plus blanks:
			// their line remainder is nothing but those blanks.
			const region = wordPresent ? text.slice(start, endIndex) + text.slice(remainderEnd, end) : fullSpan
			const id = outcome.heredocs.push(region) - 1
			outcome.heredocPayloads[id] = payloads
			// Inside an expansion region, the host is masked wholesale anyway.
			// Only top-level heredocs need a placeholder in the host text. The
			// emission appends the opener-line remainder as live host text; the
			// split at chain operators happens later, when `parseLine`
			// tokenizes. Inside a frame, the payload re-scan runs this emission
			// at top level.
			if (frames.length === 0) {
				outcome.host += mark(`H${id}`)
				if (wordPresent) {
					emitRemainder(endIndex, remainderEnd)
				}
			}
			return { end }
		}
		// The shell expands the opener line's remainder after the delimiter,
		// even when the delimiter is quoted. Quoting suppresses expansion in
		// the body only. Walk the remainder unconditionally. An error there
		// fails the whole heredoc closed, like a body error does.
		const remainderEnd = endOfLine(endIndex)
		// bash joins a backslash-newline pair before tokenizing, even inside
		// double quotes. An odd unquoted backslash run at the end of the
		// remainder therefore joins the rest of the opener line's syntax onto
		// the first body line, while the remainder cut here stops blindly at
		// that newline. The remainder cannot account for the joined bytes, so
		// the heredoc fails closed. Inside single quotes a backslash is
		// literal and no joining happens, so the guard stays silent there.
		if (wordPresent) {
			let backslashRun = 0
			while (remainderEnd - 1 - backslashRun >= endIndex && text[remainderEnd - 1 - backslashRun] === "\\") {
				backslashRun++
			}
			if (backslashRun % 2 === 1) {
				// Decide whether the backslash run opens the join: walk the
				// remainder's quote state up to the run. Only a single-quote
				// region keeps the backslash literal.
				let quote: "'" | '"' | null = null
				let j = endIndex
				while (j < remainderEnd - backslashRun) {
					const char = text[j]
					if (quote === "'") {
						if (char === "'") {
							quote = null
						}
						j++
						continue
					}
					if (quote === '"') {
						if (char === "\\") {
							j += 2
							continue
						}
						if (char === '"') {
							quote = null
						}
						j++
						continue
					}
					if (char === "\\") {
						j += 2
						continue
					}
					if (char === "'" || char === '"') {
						quote = char
					}
					j++
				}
				if (quote !== "'") {
					return { error: errorAt("heredoc", start) }
				}
			}
		}
		const remainderError = walkBodyPayloads(endIndex, remainderEnd, payloads, 0)
		if (remainderError) {
			return { error: remainderError }
		}
		// The opener line must end at LF so that the body starts on the next
		// line. A CR is valid only as the CR of a CRLF pair. A lone CR is not a
		// bash line terminator. Accepting one as the opener's end would
		// validate CR-separated input that the shell refuses as an unterminated
		// heredoc.
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
			// Raw scan index at the terminator match. The mask-emission guard
			// tests the region [start, rawIndex). Use this index, not the scan
			// index: at the match, the back-step adjustments shift the scan
			// index off the terminator line's line ending.
			let rawIndex = bodyStart
			// The terminator search emulates the shell's read layer. A line
			// runs to LF, or to end of input. POSIX bash keeps every CR as
			// ordinary content. The msys/Cygwin read layer strips every CR
			// before parsing. That layer is the reference shell on the Windows
			// target. `EO<CR>F` therefore arrives as the terminator `EOF` and
			// closes the heredoc early there. The strip also reaches the
			// delimiter word. After a CRLF opener line, POSIX reads the
			// delimiter `EOF<CR>` where msys reads `EOF`. A CR from the opener
			// line through the closing terminator line leaves the two layers
			// reading different bytes. The close then cannot be verified in a
			// model-independent way. The mask-emission guard above tests every
			// masked span against this region, so such heredocs fail closed for
			// review. This over-rejects even a uniformly-CRLF construct whose
			// models happen to agree. That is the accepted cost. A CR-free
			// region is byte-identical under both models, so it parses. bash
			// joins a backslash-newline pair before it matches the delimiter.
			// An unquoted logical line whose stripped content ends in an odd
			// number of backslashes therefore flows into the next physical
			// line. A quoted delimiter makes the backslash literal, so no
			// joining happens. The CR strip happens in the read layer and
			// quoting does not affect it. `<<-` strips leading tabs from the
			// fully joined line afterwards. It never strips from a physical
			// line on its own.
			search: while (i < text.length) {
				const groupStart = i
				let candidate = ""
				for (;;) {
					const lineStart = i
					while (i < text.length && text[i] !== "\n") {
						i++
					}
					const logicalLine = text.slice(lineStart, i).replace(/\r/g, "")
					const trailingBackslashes = logicalLine.match(/\\*$/)?.[0].length ?? 0
					if (!quoted && text[i] === "\n" && trailingBackslashes % 2 === 1) {
						candidate += logicalLine.slice(0, -1) // drop the continuation backslash
						i++ // consume the newline of the continued line
						continue
					}
					candidate += logicalLine
					// `<<-` strips leading tabs from the fully joined logical
					// line. The strip runs after continuation joining, and only
					// once. A tab that opens a continuation line stays inside
					// the candidate. An early-terminator match therefore cannot
					// hide live commands.
					const candidateText = stripTabs ? candidate.replace(/^\t+/, "") : candidate
					if (candidateText === delimiter) {
						rawIndex = i
						found = true
						bodyEnd = groupStart
						// The match is on the CR-stripped logical line. The raw
						// line-ending byte that the scan would have stopped at
						// sits back before the strip point. It is the CR of a
						// CRLF-terminated terminator line. It is also a lone CR
						// that is the whole raw terminator text: that line
						// strips to empty and matches an empty delimiter right
						// after a line break.
						if (i > 0 && text[i] === "\n" && text[i - 1] === "\r") {
							i--
						}
						if (i > 0 && text[i] === "\r" && i - 1 >= bodyStart && text[i - 1] === "\n") {
							i--
						}
						break search
					}
					break
				}
				if (i < text.length) {
					i++ // consume the newline of a body line
				}
			}
			if (!found) {
				// The body never ends. Nothing after the opener can be trusted.
				return { error: errorAt("heredoc", start) }
			}
			if (!quoted) {
				const bodyError = walkBodyPayloads(bodyStart, bodyEnd, payloads, 0)
				if (bodyError) {
					return { error: bodyError }
				}
			}
			if (frames.length > 0) {
				// Inside an expansion, no H placeholder is emitted. Without this
				// routing, the collected payloads would never reach a re-scan.
				// Hand them to the innermost parameter-expansion ancestor,
				// exactly as a directly nested substitution close does. A
				// heredoc opened inside $(…)/backtick/<( has no such ancestor.
				// The enclosing substitution's payload is re-scanned whole and
				// recovers them there.
				innermostParam(frames, paramFramesOpen)?.payloads?.push(...payloads)
			}
			return emitMask(rawIndex)
		}
		// No delimiter token appeared, and the break was not metacharacter-caused
		// -- the metacharacter guard above already fails those shapes closed: a
		// bare `<<`, or `<<` followed only by blanks, before end of line. bash
		// rejects such input with a syntax error and never executes it. The
		// opener therefore masks through end of input as one opaque word, over a
		// construct that can never run. The mask is sound only while both read
		// layers see the same bytes. The region test at the mask-emission guard
		// above fails the mask closed when a CR enters the span. This
		// over-rejects the CR-touched shapes whose layers happen to agree. That
		// is the accepted cost of keeping one region rule.
		return emitMask(text.length)
	}

	/**
	 * Walk the heredoc body region `[start, end)`. Collect the command
	 * substitutions that the shell would expand there.
	 *
	 * Outside an expansion region, this walk tracks only the expansion
	 * delimiters and backslash escapes. A heredoc body is not tokenized, so a
	 * `"` or `#` in the body is literal text. Inside an expansion region the
	 * shell does tokenize. A quote there opens a region exactly as the main
	 * scan treats it. The region masks the frame's closer and the group tests.
	 * A region still open at the end of the body fails closed, like any other
	 * unclosed delimiter. A word-initial `#` begins a comment, and the shell
	 * skips it to end of line. A closer with no opener inside the body is
	 * literal data, and the shell prints it. A delimiter still open when the
	 * terminator line is reached is a structural error. The shell would never
	 * finish expanding the body, so whatever follows it is unaccountable.
	 *
	 * `depth` bounds the recursion through nested `$((…))` interiors. Beyond
	 * `MAX_PAYLOAD_SCAN_DEPTH`, the region fails closed instead of recursing
	 * into generated input.
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
				// A `#` at the start of a word inside a `$(…)`/`<(` frame
				// begins a comment. The shell skips the comment to end of line.
				// Body regions span lines, so the comment ends at the newline,
				// not at the frame's end. A `)` inside the comment never closes
				// the frame, and the continuation lines stay inside the same
				// substitution. Quote and backtick frames keep `#` literal.
				// Their regions reach this test too. Parameter expansions also
				// keep it literal: `${#var}` is the length operator. Only
				// substitution frames take the comment. The word-boundary set
				// is the top-level comment rule's whitespace plus the
				// metacharacters that end a word. A missed comment lets its `)`
				// slice the payload, so the boundary must be exact.
				if (
					char === "#" &&
					(top.kind === "command-substitution" || top.kind === "process-substitution") &&
					/[\s;&()|<>]/.test(text[i - 1])
				) {
					// Clamp at the region end. A comment that runs past it
					// leaves the frame open, and the still-open frame fails
					// closed.
					i = Math.min(endOfLine(i), end)
					continue
				}
				if (char === top.closer) {
					if (top.groupDepth > 0) {
						// This closer matches an inner grouping paren that
						// opened inside the region. It does not match the
						// region's own opener.
						top.groupDepth--
						i++
						continue
					}
					const closed = frames.pop() as RegionFrame
					if (QUOTE_FRAME_KINDS.includes(closed.kind)) {
						// Quote regions are opaque. Nothing inside them is
						// extracted. The enclosing frame resumes after the
						// closing quote.
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
						// Slice the inner text only where a consumer exists. A
						// nested close with no parameter-expansion ancestor is
						// recovered when the enclosing payload is re-scanned.
						// Slicing every close eagerly would cost O(n²) on
						// adversarial nesting.
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
				// A quote frame is opaque except for its own closer and its
				// escapes. A backtick region is opaque except for its closer.
				// Backticks do not nest. Only expansion frames descend for
				// nested constructs.
				if (QUOTE_FRAME_KINDS.includes(top.kind) || top.kind === "backtick") {
					i++
					continue
				}
				// A bare `(` inside a substitution region opens a subshell
				// group. The shell balances that group independently of the
				// region's closer. Only its depth matters here, so the group's
				// `)` cannot slice the payload.
				if ((top.kind === "command-substitution" || top.kind === "process-substitution") && char === "(") {
					top.groupDepth++
					i++
					continue
				}
				// Inside an expansion frame, a quote is shell syntax, not body
				// text. The region it opens masks everything up to its closer.
				// A `)` or `(` inside quotes is therefore neither a closer nor
				// a group-opener. An unclosed region fails at the end of the
				// walk, like any other unclosed frame.
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
						if (arith.commandSubstitution) {
							// bash reads this opener as `$(` plus a group, not
							// arithmetic. The loop re-reads the group's `(` as
							// a group paren, like the adjacent `$(` push.
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
						// An unclosed opener fails closed. The shell refuses the
						// input, and masking the rest of the body would hide it.
						if (!arith.closed) {
							return errorAt("arithmetic", i)
						}
						// $((…)) is expansion-active. The shell performs the
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
					// An unclosed opener fails closed. The shell refuses the
					// input, and masking the rest of the body would hide it.
					if (!arith.closed) {
						return errorAt("arithmetic", i)
					}
					// $[…] is expansion-active, exactly like $((…)). The shell
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
			// Report the outermost unclosed delimiter. It is the first construct
			// the shell could never finish expanding.
			const outermost = frames[0]
			return errorAt(outermost.kind, outermost.openIndex)
		}
		return null
	}

	/**
	 * Consume a `$((…))` or `$[…]` arithmetic expression. `closed` reports
	 * whether the scan found the closing delimiter. Callers fail closed when
	 * it is missing, because bash refuses an unclosed opener. The scan walks
	 * only a closed expression's interior for expansions. `commandSubstitution`
	 * marks a `$((` that bash does not read as arithmetic at all: arithmetic
	 * syntax requires the two closers to be adjacent (`))`), so when the
	 * depth-1 `)` is not immediately followed by another `)`, bash reads `$(`
	 * plus a subshell group instead. Such callers must open a
	 * command-substitution frame rather than mask the region as arithmetic.
	 */
	const skipArithmetic = (i: number): { end: number; closed: boolean; commandSubstitution?: boolean } => {
		if (text[i + 1] === "[") {
			const close = text.indexOf("]", i + 2)
			return close === -1 ? { end: text.length, closed: false } : { end: close + 1, closed: true }
		}
		// $(( … )) balances plain parens. An unbalanced scan runs to end of input.
		let depth = 2 // the two opening parens
		let j = i + 3
		while (j < text.length && depth > 0) {
			if (text[j] === "(") {
				depth++
			} else if (text[j] === ")") {
				depth--
				// Inside valid arithmetic the depth-1 `)` is by construction
				// the first character of the `))` token. Anything else is a
				// command substitution whose group closes at this `)`.
				if (depth === 1 && text[j + 1] !== ")") {
					return { end: i + 2, closed: false, commandSubstitution: true }
				}
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
					// This closer matches an inner grouping paren that opened
					// inside the region. It does not match the region's own
					// opener. The subshell group balances before the
					// substitution frame does.
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
					// Quote regions restore verbatim. At the top level they mask
					// to a single opaque word, so their contents can never
					// tokenize as syntax.
					if (stack.length === 0) {
						const id = outcome.quotes.push(text.slice(closed.openIndex, closeEnd)) - 1
						outcome.host += mark(`Q${id}`)
					}
					i = closeEnd
					continue
				}
				if (stack.length === 0) {
					if (closed.kind === "parameter-expansion") {
						// The expansion's text stays verbatim in the host segment.
						// Its inner substitutions are extracted independently.
						const id = outcome.params.push(text.slice(closed.openIndex, closeEnd)) - 1
						outcome.paramPayloads[id] = closed.payloads ?? []
						outcome.host += mark(`P${id}`)
					} else {
						const id = outcome.substitutions.push(text.slice(closed.contentStart, i).trim()) - 1
						outcome.host += mark(`S${id}`)
					}
					expansionCloseEnd = closeEnd
				} else {
					// The frame is nested inside an expansion region. A
					// substitution inside a parameter expansion belongs to that
					// expansion's payload list. Anything deeper is recovered
					// when the enclosing payload is re-scanned. Slice its inner
					// text only where a consumer exists. Otherwise deep nesting
					// would cost O(n²).
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
			// A quote frame is opaque except for its own closer and its
			// escapes. A backtick region is opaque except for its closer.
			// Backticks do not nest. Only expansion frames descend for nested
			// constructs.
			if (QUOTE_FRAME_KINDS.includes(top.kind) || top.kind === "backtick") {
				i++
				continue
			}
			// A bare `(` inside a substitution region opens a subshell group.
			// The shell balances that group independently of the region's
			// closer. Tracking its depth keeps the group's `)` from popping the
			// substitution frame. `(`/`)` inside a parameter expansion stay
			// literal word characters.
			if ((top.kind === "command-substitution" || top.kind === "process-substitution") && char === "(") {
				top.groupDepth++
				i++
				continue
			}
			// Inside an expansion region, balance nested constructs and never
			// emit host text. When the region closes, it is replaced by one
			// placeholder.
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
						if (arith.commandSubstitution) {
							// bash reads this opener as `$(` plus a group, not
							// arithmetic. The loop re-reads the group's `(` as
							// a group paren, like the adjacent `$(` push.
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
						// Fail closed here instead of letting the outer region
						// error at end of input. That would name the wrong
						// opener and silently drop the arithmetic's interior
						// payloads.
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
						// The enclosing region is masked wholesale. Route the
						// substitutions to the innermost expansion ancestor, like
						// a nested close does.
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
			// Inside a parameter expansion, bash reads `<<` as an arithmetic
			// shift, or as literal word text. It never reads it as a heredoc
			// opener. There, the scan consumes `<<` as an ordinary character.
			// Only command-substitution and process-substitution frames reach
			// the heredoc scan. The shell tokenizes those as command contexts,
			// and a heredoc opened there is real. Quote and backtick frames are
			// opaque before this point.
			if (char === "<" && text[i + 1] === "<" && text[i + 2] !== "<" && top.kind !== "parameter-expansion") {
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

		// Nothing is open. Scan fully and emit host text.
		if (char === "\\") {
			// A backslash escapes the next character. A quote after it is
			// literal.
			outcome.host += text.slice(i, i + 2)
			escapedWordCharEnd = i + 2
			i += 2
			continue
		}
		if (char === "#" && i === expansionCloseEnd) {
			// A `#` directly after the closer of an expansion or quote region
			// continues the surrounding word. The shell ends the expansion at
			// its closer but not the word. It starts a comment only at a word
			// start. The tokenizer starts a comment at any unquoted `#`. Send
			// the character through tokenization as an opaque placeholder, as
			// the mid-word case below does. It expands back verbatim. The rest
			// of the line stays parseable instead of dropping as comment text.
			const id = outcome.variables.push("#") - 1
			outcome.host += mark(`V${id}`)
			i++
			continue
		}
		if (char === "#" && (i === 0 || (/\s/.test(text[i - 1]) && i !== escapedWordCharEnd))) {
			// Comment: pass the rest of the line through untouched. Quotes and
			// delimiters inside a comment are not shell syntax. shell-quote drops
			// the comment text when it tokenizes. This branch also excludes a `#`
			// at the end of a `\c` escape pair, even when the escaped character
			// is whitespace. The escape makes it word content, so that `#`
			// continues the word and the masking branch below handles it.
			const end = endOfLine(i)
			outcome.host += text.slice(i, end)
			i = end
			continue
		}
		if (char === "#" && (!/[;&()|<>]/.test(text[i - 1]) || i === escapedWordCharEnd)) {
			// A `#` inside a word is an ordinary character to the shell. A
			// comment starts only at a word start. The tokenizer starts a comment
			// at any `#`. Send a mid-word `#` through tokenization as an opaque
			// placeholder so it expands back verbatim. Otherwise it would drop
			// the rest of the line, including a real separator after it. The
			// character right after a `\c` escape pair is also word interior. An
			// escaped character is a literal word character to the shell. A `#`
			// at that position therefore uses the placeholder channel, even when
			// the raw character before it is whitespace or a metacharacter. What
			// reaches the tokenizer unmasked sits at a real word start: index 0,
			// after whitespace, or after a bare metacharacter. There the shell
			// starts a comment too.
			const id = outcome.variables.push("#") - 1
			outcome.host += mark(`V${id}`)
			i++
			continue
		}
		if (char === "<" && text[i + 1] === "<" && text[i + 2] === "<") {
			// Herestring (<<<): a single-line stdin redirect with no body and no
			// terminator. The word after it is an ordinary shell word.
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
			// A bare grouping or array-assignment paren is host text. It is
			// never extracted, and it is never an error, closed or not. The
			// depth counter exists only so that a matching `)` is not read as a
			// stray closer.
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
		if (char === "{") {
			// A bare brace (brace expansion, `@{1}` revspec, `find -exec {}`
			// placeholder) is host text. It is never extracted, and it is never
			// an error. The depth counter exists only so that a matching `}` is
			// not read as a stray closer.
			braceDepth++
			outcome.host += char
			i++
			continue
		}
		if (char === "}" && braceDepth > 0) {
			braceDepth--
			outcome.host += char
			i++
			continue
		}
		if (char === "}") {
			// A `}` at depth 0 with no matching `{` stays fail-closed. The
			// parser cannot tell a literal brace word from a decomposition whose
			// opener it lost. An unaccountable closer never reaches approval: the
			// tool call fails with an error. Rejecting a literal `}` argument is
			// the accepted cost.
			outcome.error = errorAt("stray-closer", i)
			return outcome
		}
		// A `)` at depth 0 is host text. bash closes `case` patterns with `)`.
		// With the frame stack empty, a closer cannot hide a substitution: any
		// `$(…)` after it is still extracted and allowlist-checked.
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
					if (arith.commandSubstitution) {
						// bash reads this opener as `$(` plus a group, not
						// arithmetic. The loop re-reads the group's `(` as a
						// group paren, like the adjacent `$(` push, so the
						// group's command is extracted independently.
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
					// An unclosed opener fails closed. Masking the remainder to
					// end of input would hide its text behind the host word.
					if (!arith.closed) {
						outcome.error = errorAt("arithmetic", i)
						return outcome
					}
					// The shell performs command substitutions inside a $((…))
					// exactly like anywhere else. Extract them as independent
					// segments, and make them balance.
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
				// An unclosed opener fails closed. Masking the remainder to
				// end of input would hide its text behind the host word.
				if (!arith.closed) {
					outcome.error = errorAt("arithmetic", i)
					return outcome
				}
				// The shell performs command substitutions inside a $[…] exactly
				// like anywhere else. Extract them as independent segments, and
				// make them balance.
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
		// Delimiters are still open at end of input. Report the outermost one.
		// It is the first construct the shell could never finish reading.
		const outermost = stack[0]
		outcome.error = errorAt(outermost.kind, outermost.openIndex)
	}

	return outcome
}

/**
 * Parse a heredoc delimiter word. The word starts at position `start` in
 * `command`. The walk applies bash's quoting rules. A quote character opens a
 * quote region anywhere in the word, mid-word as well as at the start. A
 * quote region spans newlines until its closing quote. A backslash escapes the
 * next character. Inside double quotes, only the characters in
 * `DOUBLE_QUOTE_ESCAPABLE` are escapable. Outside quotes, anything is. A
 * backslash-newline pair drops the newline as a line continuation everywhere.
 * Quote removal produces the bare word. A terminator line must equal that word
 * exactly.
 *
 * Returns:
 * - `delimiter`: the word after quote removal. It is the terminator text. It
 *   is empty for `<<''`, which bash terminates at the first blank body line.
 * - `endIndex`: index of the first character after the delimiter token.
 * - `quoted`: whether any quoting construct appeared. A quoted or escaped
 *   delimiter suppresses all expansion in the body.
 * - `wordPresent`: whether any delimiter token appeared at all. A bare `<<`
 *   before end of line has none.
 * - `malformed`: whether the word reached end of input with a quote region
 *   still open. bash then reads the delimiter as a multi-line word that can
 *   never match a body line. The opener line's tail keeps executing as
 *   ordinary syntax. No body can be accounted for.
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
				// Inside double quotes, only `DOUBLE_QUOTE_ESCAPABLE` is
				// escapable. The backslash drops before those characters.
				// Before anything else it stays literal text of the word. A
				// backslash-newline pair drops both characters (line
				// continuation).
				if (command[i + 1] !== "\n") {
					const next = command[i + 1]
					delimiter += DOUBLE_QUOTE_ESCAPABLE.includes(next) ? next : char + next
				}
				i += 2
				continue
			} else {
				// Inside a quote, newlines and blanks are ordinary word
				// content. bash closes the word only at the matching quote.
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
		// An unquoted blank, line ending, or shell metacharacter ends the word.
		// bash tokenizes `cat <<E|grep x` as the delimiter word `E` followed by
		// a live operator, exactly like `cat <<E | grep x`. The msys read layer
		// strips CR, so there the CR is line-ending content, not part of the
		// delimiter word. A CR-bounded delimiter word leaves its CR inside the
		// construct's region. The region test at mask emission in skipHeredoc
		// then fails such a heredoc closed, whether or not a terminator line
		// matches. A `(` or `)` breaks the word only at word start. bash
		// recognizes a metacharacter only at token start; glued after a
		// nonempty word token it is a syntax error, never a separator. Breaking
		// there would turn input bash rejects into an approvable heredoc whose
		// live remainder swallows the parenthesized text without splitting it.
		// A metacharacter at word start leaves the word empty, and the no-word
		// path then accounts for the opener instead.
		const breakSet = i === start ? " \t\n\r|&;()<>" : " \t\n\r|&;<>"
		if (breakSet.includes(char)) {
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

/** Look up the raw text that a placeholder name stands for, or undefined. */
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
			// The crude-split fallback path is the only path that restores
			// substitutions inline. The normal path turns them into independent
			// segments.
			return includeSubstitutions ? outcome.substitutions[index] : undefined
		default:
			return undefined
	}
}

/**
 * Replace every sentinel-delimited placeholder in `text` with its raw text.
 * Split on the sentinel rather than with a regex. By construction, a
 * placeholder name is everything between two sentinels. The scan rejects a raw
 * NUL in the input up front (see QuoteType "nul-byte"), so no input can carry
 * a sentinel that collides with the ones used here.
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
 * Split a command string into individual sub-commands. The splitter cuts on
 * chaining operators (&&, ||, ;, |, or &) and on unquoted newlines.
 *
 * One quote-aware scan (`scanShellSyntax`) does all structure analysis in a
 * single left-to-right pass. `shell-quote` then tokenizes the masked host
 * text:
 * - Quoted strings stay opaque. That includes multi-line quoted strings. That
 *   is why only unquoted newlines split commands. The key invariant: a newline
 *   inside a quoted string is argument text, never a separator.
 * - The scan extracts every command substitution with balanced-paren
 *   awareness, wherever it sits: nested, inside a `${…}` expansion, inside a
 *   process substitution, or inside a heredoc with an unquoted delimiter. Each
 *   becomes its own segment, so each inner command matches the allow/deny
 *   lists on its own. Parameter-expansion and heredoc hosts keep their
 *   verbatim text as one segment.
 * - PowerShell-style redirections (2>&1), variables, and arithmetic stay
 *   inside their host word.
 *
 * The result is a `ParseResult`. It contains the list of sub-commands and an
 * optional `parseError`. The error is non-null when the input cannot be
 * accounted for: an unterminated quote or heredoc, an expansion delimiter or
 * arithmetic expression opened but never closed, a stray closer, a raw NUL
 * byte, or substitution nesting beyond the re-scan depth cap. When
 * `parseError` is set, the `commands` array contains the raw input as a single
 * opaque token. A command whose structure the parser cannot fully account for
 * must never reach approval: the tool call fails with an error instead. It
 * must not get a free pass built on a partial decomposition.
 */
export function parseCommand(command: string): ParseResult {
	// A NUL byte is not whitespace. A NUL-bearing command therefore still
	// reaches the scan, where the nul-byte guard rejects it.
	if (!command?.trim()) {
		return { commands: [], parseError: null }
	}

	// Run the shared state-machine scan once. One pass yields the masked host
	// text, the extracted substitution payloads, and the structural-error
	// descriptor.
	const outcome = scanShellSyntax(command)

	// Reject syntactically malformed input. Return the raw input as a single
	// opaque token. Callers then surface the error to the agent instead of
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
 * A chain operator flushes the current segment. A substitution placeholder
 * also flushes, and it takes the place of its payload's own segments. The
 * payload is re-scanned through the same path, so nested substitutions become
 * independent segments. Placeholders that do not force a split join the
 * current word and are restored verbatim. Those are quotes, parameter
 * expansions, heredocs, variables, redirections, and arithmetic. A parameter
 * expansion, heredoc, or closed `$((…))` also queues its extracted inner
 * substitutions. They flush right after the host segment that still contains
 * their verbatim text.
 *
 * The scan records structural errors found while it recurses into payloads on
 * `outcome` (fail-closed). The caller checks `outcome` after every line.
 * `depth` counts payload re-entries, and `scanPayloadSegments` caps it.
 */
function parseLine(line: string, outcome: ScanOutcome, depth: number): string[] {
	let tokens: ShellToken[]
	try {
		tokens = parse(line) as ShellToken[]
	} catch (error) {
		// If shell-quote fails to parse, fall back to simple splitting. This
		// path does not recurse into payloads. Every placeholder restores to
		// its raw text (for substitutions: the inner text), so callers never
		// see internal markers.
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
		// This word carries placeholders. Reconstruct the non-substitution
		// placeholders for verbatim restoration. Treat substitution
		// placeholders as segment boundaries.
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
 * Re-scan an extracted substitution payload through the same scan and
 * tokenize path, so nested substitutions become independent segments. The scan
 * records structural errors on `outcome`, and the outer command then fails
 * closed. Each re-entry increments `depth`. Past `MAX_PAYLOAD_SCAN_DEPTH`, the
 * command fails closed as `nesting-too-deep`. It does not re-scan generated
 * nesting until the call stack overflows.
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
