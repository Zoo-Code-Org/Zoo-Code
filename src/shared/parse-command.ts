import { parse } from "shell-quote"

// Glob tokens are a distinct shape: shell-quote keeps the glob text on
// `pattern` and collapses the word itself to the literal `glob` op. Every
// other operator token carries only `op`.
export type ShellToken = string | { op: "glob"; pattern: string } | { op: string } | { command: string }

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
 * - `tokenize-failure`: the tokenizer rejected the masked host text. The
 *   masked text carries no active shell syntax, so a rejection means the
 *   scan's decomposition does not account for the input.
 * - `ambiguous-opener`: a `{` that meets its `$` only through a line
 *   continuation carrying a carriage return. The read models disagree about
 *   whether the joined bytes open a parameter expansion, so the scan masks
 *   nothing and refuses the input instead of guessing.
 * - `ambiguous-comment`: a `#` comment whose line ends at a lone carriage
 *   return. bash ends a comment only at a newline, so the comment text bash
 *   still reads extends past where this scan resumes parsing, and a quote
 *   opener among those bytes would open a live region here. The read models
 *   disagree about where the comment ends, so the scan refuses the input
 *   instead of guessing. A carriage return that is the CR of a CRLF pair is
 *   a line ending for both models and does not trigger this refusal.
 * - `payload-glob`: a glob word inside a re-scanned substitution payload.
 *   The tokenizer keeps only the literal `glob` for such a word, which
 *   under-approximates the files bash expands the pattern to. The scan
 *   refuses the input instead of reconstructing a bare `glob` word.
 * - `placeholder-glob`: a host-level glob word that shares its word with a
 *   masked construct. The collapsed word swallows the construct's
 *   placeholder, so the construct's payload — a command substitution's inner
 *   command — is never extracted, re-scanned, or checked. The collapsed word
 *   rides the host's allow rule to an approval while bash runs the embedded
 *   command. The scan refuses the input. A glob word with no placeholder is
 *   host text unchanged.
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
	| "tokenize-failure"
	| "ambiguous-opener"
	| "ambiguous-comment"
	| "payload-glob"
	| "placeholder-glob"

/**
 * The result of parsing a command string.
 *
 * `commands` is the list of individual sub-commands. The splitter cuts on
 * unquoted newlines and chain operators. When `parseError` is non-null, the
 * command string is malformed. Causes: an unterminated quote or heredoc, an
 * expansion delimiter or arithmetic expression that never closes, a stray
 * closer, a raw NUL byte, substitution nesting beyond the re-scan depth cap,
 * the shell tokenizer rejecting the masked command, a `{` opener joined to
 * its `$` across a carriage-return continuation, a comment that ends at a
 * lone carriage return, a glob word inside a re-scanned substitution payload,
 * or a host glob word carrying a masked construct. `commands` then holds the
 * raw input as one opaque token.
 * Callers can surface the error without splitting unsafe fragments.
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
		"tokenize-failure": "shell tokenizer rejected the masked command",
		"ambiguous-opener":
			"ambiguous parameter-expansion opener (a carriage return sits in the line continuation before `{`)",
		"ambiguous-comment":
			"comment terminated by a lone carriage return (the executing shell reads the comment as extending past it)",
		"payload-glob": "glob pattern inside a substitution payload (glob expansion cannot be accounted for)",
		"placeholder-glob":
			"glob word carrying a command substitution (substitution expansion cannot be accounted for)",
	}
	const problem =
		quoteType === "stray-closer" ||
		quoteType === "nul-byte" ||
		quoteType === "nesting-too-deep" ||
		quoteType === "ambiguous-opener" ||
		quoteType === "ambiguous-comment" ||
		quoteType === "payload-glob" ||
		quoteType === "placeholder-glob"
			? labels[quoteType]
			: `unterminated ${labels[quoteType]}`
	const snippetStart = Math.max(0, openIndex - 10)
	const snippetEnd = Math.min(command.length, openIndex + 20)
	const prefix = snippetStart > 0 ? "..." : ""
	const suffix = snippetEnd < command.length ? "..." : ""
	const excerpt = prefix + command.slice(snippetStart, snippetEnd).replace(/\r?\n/g, "\\n") + suffix
	return `Malformed command: ${problem} at position ${openIndex} -- near: \`${excerpt}\`. `
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
	/**
	 * Raw text of each host-level backslash-escaped glob character (`\*`,
	 * `\?`, `\[`). The escaped character is a literal to the shell, so the
	 * word cannot glob-expand on it; masking keeps the tokenizer from
	 * collapsing such a word.
	 */
	escapedGlobs: string[]
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
 * True when `pattern` carries a placeholder for a construct whose masked text
 * can hide a command the executing shell may run: a command substitution
 * (`S`), a quote region (`Q`), a parameter expansion (`P`), a heredoc (`H`),
 * or an arithmetic expression (`A`). A glob word that swallows one of these
 * loses the only channel that extracts and checks the construct's payload.
 * Variables (`V`), redirections (`R`), and escaped glob characters (`g`)
 * restore verbatim and carry no payload, so a glob word sharing its word with
 * one of those keeps its main-line host-glob behavior. The pattern is built
 * from `NUL` rather than a literal so the sentinel stays the scan's single
 * source of truth.
 */
function carriesExecutablePlaceholder(pattern: string): boolean {
	return new RegExp(`${NUL}[SQPHA]\\d+${NUL}`).test(pattern)
}

/**
 * True when `token` carries a masked escaped glob character in the same word
 * as a placeholder whose inner commands this loop cannot prove it has seen.
 * Masking the escaped glob keeps the word out of the tokenizer's glob
 * collapse, which is what exempts an escaped wildcard from the
 * placeholder-glob rejection; carrying such a word past that rejection only
 * makes sense when every construct in it still reaches the checks. A
 * substitution (`S`) does: the loop consumes it as a segment boundary and
 * re-scans its payload in full. A parameter expansion (`P`), heredoc (`H`),
 * arithmetic expression (`A`), quote region (`Q`), or redirection (`R`) does
 * not: the executing shell expands a command substitution that sits inside
 * double quotes within one of them (`${x:-"$(rm y)"}`), and that nested
 * command is absent from the payload list the host word queues, while a
 * region's raw text is restored verbatim. Variables (`V`) carry no payload.
 * So only `S`, `V`, and the escaped characters themselves take the accept
 * path; any other placeholder riding a masked escaped glob keeps the
 * rejection. Both patterns are built from `NUL` so the sentinel stays the
 * scan's single source of truth.
 */
function escapedGlobRidesUncheckedPlaceholder(token: string): boolean {
	return new RegExp(`${NUL}g\\d+${NUL}`).test(token) && new RegExp(`${NUL}[PHAQR]\\d+${NUL}`).test(token)
}

/**
 * Cap on payload re-scan depth. The scan re-scans every substitution payload
 * through the full path. With no cap, a few tens of KB of generated input
 * consumes minutes of CPU through quadratic suffix re-scans. The call stack
 * finally overflows. The cap fails closed instead. No hand-written command
 * nests a substitution 64 deep.
 */
const MAX_PAYLOAD_SCAN_DEPTH = 64

/**
 * Sentinel for "a region opens here but never closes", distinct from "no
 * region opens here". A closer scan that retries the next byte on either
 * reading re-walks the whole tail once per byte; masking the tail at this
 * reading keeps the scan linear. An unclosed region is bash's own syntax
 * error: the shell reads every later byte inside it, so the tail holds no
 * further region opener for the scan to find.
 */
const INERT_UNCLOSED = -1

/**
 * Bytes the shell ends a word at (default $IFS blanks plus metacharacters).
 * JS \s is wider than $IFS (VT, FF, NBSP, U+3000, …), and bash does not
 * word-split on the extras.
 */
const IFS_BLANK = /[ \t\n]/
const WORD_BOUNDARY_BEFORE = /[ \t\n;&()|<>]/

/**
 * True when the byte the shell sees before `text[i]` ends a word. A
 * backslash-newline pair is removed by the shell before tokenizing, so a
 * word-boundary test must read the shell's logical text, not the raw bytes.
 * A backslash run of length R ending at a newline pairs off left to right:
 * an odd R ends in the pairing backslash, so the newline is swallowed as a
 * continuation and the byte before the run is what precedes the word; an
 * even R leaves the newline standing as a real line break. Neither walk
 * carries an index bound: reading before index 0 yields undefined, which is
 * neither a newline nor a backslash, so the character tests stop both walks
 * at the start of input, where the word boundary is implicit.
 */
function logicalWordBoundaryBefore(text: string, i: number): boolean {
	let prev = i - 1
	while (text[prev] === "\n") {
		let run = 0
		while (text[prev - run - 1] === "\\") {
			run++
		}
		if (run % 2 === 0) {
			// Even run (including none): the newline is a real line break.
			break
		}
		prev -= run + 1
	}
	return prev < 0 || WORD_BOUNDARY_BEFORE.test(text[prev])
}

/**
 * The first index at or past `from` that falls outside a run of
 * backslash-newline line continuations -- the byte a standing unquoted byte is
 * really adjacent to, because the shell removes each pair before tokenizing
 * and every site that asks what follows a `$` or `<` opener shares this rule.
 * With `acrossLineEndingCR` each pair may also carry the carriage returns that
 * precede its newline: on the reference shell a CR between the backslash and
 * the newline does not stop the join, so an opener read that crosses a line
 * ending sees through those CR bytes.
 */
function continuationRunEndFrom(text: string, from: number, acrossLineEndingCR: boolean): number {
	let j = from
	while (text[j] === "\\") {
		let k = j + 1
		// Stryker disable next-line ConditionalExpression: the two named entries pass the flag's two values, so this flip makes both CR-tolerant, and the delimiter walk's only differing shape (`$\<CR><LF>` before a quote) returns the same heredoc malformed result either way.
		if (acrossLineEndingCR) {
			while (text[k] === "\r") {
				k++
			}
		}
		if (text[k] !== "\n") {
			break
		}
		j = k + 1
	}
	return j
}

/**
 * The strict entry, for the question of which bytes the tokenizer removes
 * inside a word: a carriage return survives inside a word, so the run stops
 * at the first CR it meets.
 */
function continuationRunEnd(text: string, from: number): number {
	// Stryker disable next-line BooleanLiteral: this entry passing true instead of false is the same flip as the run's CR flag, and every shape where that differs is a heredoc malformed result under either reading.
	return continuationRunEndFrom(text, from, false)
}

/**
 * The opener entry, for the question of whether an unquoted `$`, `{`, or `(`
 * can meet an opener byte across a line ending in the executing shell: the
 * reference shell joins across the CR bytes that may sit in the pair, so the
 * run steps over them.
 */
function openerContinuationRunEnd(text: string, from: number): number {
	return continuationRunEndFrom(text, from, true)
}

/**
 * True when at least one carriage return sits inside the opener continuation
 * run that spans `from` to `arm`. The `{` opener arm treats such a join as
 * ambiguous: unlike the `(` arms, whose CR-joined openers the reference shell
 * demonstrably executes, a CR-joined `${` reads as an expansion under one
 * model of the shell and as separate syntax under another. That arm fails
 * closed instead of masking, so an ambiguous opener can never carry an
 * approval.
 */
function openerRunCarriesCR(text: string, from: number, arm: number): boolean {
	return text.slice(from, arm).includes("\r")
}

/**
 * Trim only the blanks a shell reader drops at the edges of a word run. JS
 * `trim` also strips the exotic characters bash reads as ordinary word bytes;
 * dropping them would move a following `#` from mid-word to word start, where
 * a re-scan reads it as a comment start and hides what bash expands.
 */
const trimScanBlanks = (value: string): string => value.replace(/^[ \t\n]+/, "").replace(/[ \t\n]+$/, "")

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
 *   balance before the terminator. A backslash-newline is a continuation the
 *   shell removes before tokenizing; it does not quote the delimiter, so the
 *   body stays expansion-active like any other unquoted body. A quoted or
 *   backslash-escaped delimiter suppresses expansion entirely: the shell does
 *   not expand those, and such a body stays opaque and is never
 *   balance-checked. A body
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
		// Stryker disable next-line ArrayDeclaration: a placeholder id is the post-push length minus one, so seeding this array cannot change which entry a `g<id>` name resolves to; no input distinguishes the mutant.
		escapedGlobs: [],
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
	// Index just past the most recent frame close inside an open frame, or -1.
	// A `#` directly there continues the word like the host-level rule above.
	// A group-paren closer is a word boundary — bash comments `$( (x)# )` — so
	// only frame-kind pops set this index.
	// Stryker disable next-line UnaryOperator: the guard only consults this sentinel at a frame-comment position, and the scan index is never 1 inside a frame (frame content starts at least two past the opener), so no reachable input distinguishes `+1` from `-1`.
	let frameCloseEnd = -1
	// Index just past the most recent ordinary `\c` escape pair consumed
	// inside an open frame, or -1. To the shell the escaped character is an
	// ordinary word character, so a `#` directly after the pair continues the
	// word instead of starting a comment, even when the escaped character is a
	// blank. A backslash-newline pair is excluded: the shell removes that pair
	// before tokenizing, so it leaves no word content behind, and the frame
	// comment rule decides a `#` after it against the logical boundary instead.
	// Stryker disable next-line NumberLiteral,UnaryOperator: the replacements for this -1 sentinel (0, 1, and +1) can never equal the scan index at a frame-comment position — frame content starts at least two past the frame's opener — so no reachable input distinguishes them from `-1`.
	let frameEscapeEnd = -1
	// Index just past the most recent `\c` escape pair that the scan emitted
	// at host level, or -1. To the shell, the escaped character is an ordinary
	// word character. The word continues past the pair. A `#` directly at this
	// index is word content, even when the escaped character is whitespace or
	// a metacharacter in the raw text. A backslash-newline pair is excluded:
	// the shell removes that pair before tokenizing, so it leaves no word
	// content behind, and the comment rule decides a following `#` against the
	// logical boundary instead.
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
	// Rejecting at the scan head protects the placeholder sentinel everywhere
	// the masked text travels.
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

	// True when the scan's line ending at `end` is a lone carriage return: a
	// CR not followed by an LF. The comment branches stop a comment at the
	// first newline or carriage return, but the executing shell ends comments
	// only at newlines. When the terminator is a lone CR, the comment bytes
	// the shell still reads extend past this index, and quote openers among
	// them would open a live region in this scan while the shell keeps them
	// comment text. A CR followed by an LF is a CRLF pair — one line ending
	// for both models — and stays parseable.
	const terminatesAtLoneCR = (end: number): boolean => text[end] === "\r" && text[end + 1] !== "\n"

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
	 * terminator. Heredoc redirects chained on the opener line each get a
	 * body: bash reads those bodies sequentially from the input stream, so
	 * each chained body starts on the line after the previous construct's
	 * terminator and runs to its own. The redirect operator and delimiter word
	 * through the last terminator mask to one host word; the opener-line
	 * remainder after the delimiter word stays live host text. Return the
	 * index just past the last terminator text. Return an error when the outer
	 * heredoc or any chained body is unterminated, or for an unbalanced
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
			// The walk cannot determine the terminator: the word reached end
			// of input with a quote region still open, so bash reads a
			// multi-line word that can never match a body line, or it contains
			// an unquoted ANSI-C/locale quoting occurrence whose quote removal
			// the walk does not reproduce, so bash closes the heredoc at a
			// line this walk never derives. Either way the body and everything
			// after it are unaccountable, so fail closed.
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
		// Chained heredoc openers found on the opener line, in scan order.
		// bash reads their bodies sequentially from the input stream, so the
		// terminator search for each one starts after the previous construct's
		// terminator line. The scan resolves them after the outer body search.
		const chainOpeners: number[] = []
		// The live opener-line remainder's host text, buffered by
		// `emitRemainder`. The scan emits it right after the H placeholder once
		// the chain is resolved.
		let remainderHost = ""
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
		// whole construct, opener-line remainder and every chained body
		// included, even though the remainder masks out below. A uniformly-CRLF
		// construct whose layers happen to agree is over-rejected. That is the
		// accepted cost.
		/**
		 * Append the opener-line remainder `[from, to)` to the construct's
		 * buffered host text. These bytes are live syntax that the outer scan
		 * loop never revisits, so the walk applies that loop's live-text policy
		 * here: a mid-word `#`
		 * becomes an opaque placeholder (the tokenizer would otherwise start a
		 * comment there and drop the rest of the line, hiding live commands), a
		 * word-initial `#` passes through as the comment bash sees, a `#`
		 * directly after the closer of an expansion or process substitution
		 * continues the word and takes the placeholder, and a backslash escape
		 * pair stays verbatim. Quote characters pass through too; the walk only
		 * tracks the regions so a quoted `#` stays literal. A top-level `${…}`
		 * region is the exception: the tokenizer throws on expansion bytes it
		 * cannot expand, so the region's bytes are diverted out of the host and
		 * the host carries the region's `P` placeholder instead, the same
		 * masking the main loop applies to parameter expansions.
		 *
		 * A word-start `<<` in the remainder is another heredoc redirect on the
		 * same line. The walk records it as a chained opener; the caller
		 * searches its body after the outer body, because bash reads chained
		 * bodies sequentially from the input stream, each starting after the
		 * previous construct's terminator line. The opener bytes pass into the
		 * host text as ordinary word bytes; the single H placeholder spans the
		 * whole chain. Without the collection the chained body lines would be
		 * re-scanned as live text, and bash's body-expanded bytes would hide
		 * from the decomposition.
		 *
		 * Returns null when the walk completes, and the error of a chain that
		 * exceeds the generated-input cap.
		 */
		const emitRemainder = (from: number, to: number): UnterminatedQuote | null => {
			let i = from
			// Index just past the most recent `\c` escape pair, or -1. The
			// escaped character is word content to the shell, so a `#` directly
			// after the pair continues the word.
			let escapedEnd = -1
			let quote: "'" | '"' | null = null
			// Whether the open `quote` region was opened by `$'`, whose body
			// escapes the next byte even when the quote byte is `'`.
			let escapedQuote = false
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
			// Index of the `$` of the open top-level `${` region, or -1. Raw
			// `${` bytes make the tokenizer throw (`Bad substitution`), which
			// hands the caller a tokenizer rejection instead of a decomposition
			// that silently drops the substitutions the expansion closed, like
			// `$(zap x)` inside `${x:-$(zap x)}`. While this region is open its
			// bytes stay out of the host; the matching `}` turns the region's raw
			// text into a `P` placeholder. The region's inner substitutions are
			// already in `payloads` through the `walkBodyPayloads` pre-walk.
			let maskedStart = -1
			// Whether the `<<` at `at` is followed by a delimiter word before
			// end of line. The no-word opener's mask-through-end-of-input
			// policy is sound at end of command, where bash's syntax error
			// guarantees nothing executes. Mid-line it is not: bash reads the
			// delimiter word from a later line, expanding it there, so a no-word
			// chain opener mid-line would mask executed bytes unscanned. Such
			// openers stay with the byte-wise walk and the outer body scan.
			const chainHasWord = (at: number): boolean => {
				let k = at + 2
				if (text[k] === "-") {
					k++
				}
				while (text[k] === " " || text[k] === "\t") {
					k++
				}
				return k < text.length && !" \t\n\r|&;()<>".includes(text[k])
			}
			while (i < to) {
				const char = text[i]
				if (char === "\\" && (quote !== "'" || escapedQuote)) {
					// Inside plain single quotes a backslash is literal, so only
					// an unquoted, double-quoted, or ANSI-C-quoted backslash
					// pairs with the next character.
					if (maskedStart === -1) {
						remainderHost += text.slice(i, i + 2)
					}
					escapedEnd = i + 2
					i += 2
					continue
				}
				if (char === "$" && quote === null && text[i + 1] === "'") {
					// Track the ANSI-C region so its escaped `\'` cannot end the
					// region early: an early close re-reads region bytes as live
					// syntax, and the reversed pairing reads the word's live tail
					// as quoted, hiding it from the chained-opener test below.
					quote = "'"
					escapedQuote = true
					if (maskedStart === -1) {
						remainderHost += "$'"
					}
					i += 2
					continue
				}
				if (char === "'" || char === '"') {
					if (quote === null) {
						quote = char
					} else if (quote === char) {
						quote = null
						escapedQuote = false
					}
					if (maskedStart === -1) {
						remainderHost += char
					}
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
						if (maskedStart === -1) {
							remainderHost += char
						}
						i++
						continue
					}
					if (top && char === top.closer) {
						if (top.groupDepth > 0) {
							// This closer matches an inner grouping paren, not
							// the region's own opener.
							top.groupDepth--
							if (maskedStart === -1) {
								remainderHost += char
							}
						} else {
							frames.pop()
							if (maskedStart !== -1 && frames.length === 0) {
								const id = outcome.params.push(text.slice(maskedStart, i + 1)) - 1
								remainderHost += mark(`P${id}`)
								maskedStart = -1
							} else {
								if (frames.length === 0) {
									closerEnd = i + 1
								}
								if (maskedStart === -1) {
									remainderHost += char
								}
							}
						}
						i++
						continue
					}
					if (top?.closer === ")" && char === "(") {
						// A bare `(` inside a `)`-closing region opens a group
						// the shell balances before the region's closer, so the
						// group's `)` cannot end the region. `(`/`)` inside a
						// `}`- or `]`-closing region stay literal.
						top.groupDepth++
						if (maskedStart === -1) {
							remainderHost += char
						}
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
						if (closer === "}" && frames.length === 1) {
							maskedStart = i
						} else if (maskedStart === -1) {
							remainderHost += char
							remainderHost += text[i + 1]
							if (doubleArith) {
								remainderHost += text[i + 2]
							}
						}
						i += doubleArith ? 3 : 2
						continue
					}
					if (char === "`") {
						frames.push({ closer: "`", groupDepth: 0, backtick: true })
						if (maskedStart === -1) {
							remainderHost += char
						}
						i++
						continue
					}
					if ((char === "<" || char === ">") && text[i + 1] === "(") {
						frames.push({ closer: ")", groupDepth: 0, backtick: false })
						if (maskedStart === -1) {
							remainderHost += `${char}(`
						}
						i += 2
						continue
					}
					if (char === "<" && text[i + 1] === "<" && text[i + 2] === "<") {
						// A herestring (<<<) is one operator, never a heredoc
						// opener: consume all three bytes so the scan never
						// re-reads the operator's second `<` at a shifted
						// position, where the first byte no longer marks a
						// herestring. The main loop's herestring branches
						// apply the same rule at their levels.
						if (maskedStart === -1) {
							remainderHost += "<<<"
						}
						i += 3
						continue
					}
					// A second heredoc redirect on the opener line, under the
					// main scan's own guards: the `<<<` herestring is consumed
					// above, and the empty-frames test stands in for the
					// parameter-expansion frame-kind exclusion (there bash
					// reads `<<` as shift or word text). Record the opener;
					// the caller searches its body after the outer body,
					// because bash reads chained bodies sequentially from the
					// input stream. The `<<` token bytes pass into the host
					// text; the delimiter word follows them through the walk
					// as ordinary word text.
					if (char === "<" && text[i + 1] === "<" && frames.length === 0 && chainHasWord(i)) {
						// Beyond the scan's existing generated-input cap the
						// chain fails closed, like every other unbounded-work
						// guard in this file: no hand-written command chains
						// that many heredocs on one line.
						if (chainOpeners.length >= MAX_PAYLOAD_SCAN_DEPTH) {
							return errorAt("heredoc", i)
						}
						chainOpeners.push(i)
						const dash = text[i + 2] === "-"
						if (maskedStart === -1) {
							remainderHost += dash ? "<<-" : "<<"
						}
						i += dash ? 3 : 2
						continue
					}
				}
				if (char === "#" && quote === null) {
					if (maskedStart !== -1) {
						// A `#` inside the masked expansion region is region
						// text, like the length operator in `${#var}`. It
						// travels with the placeholder, never as a comment.
						i++
						continue
					}
					if (i === closerEnd) {
						// A `#` directly after a region closer continues the
						// word: the shell ends the region at its closer but not
						// the word, and starts a comment only at a word start.
						// The placeholder keeps the rest of the line
						// tokenizable, as the mid-word case below does.
						const id = outcome.variables.push("#") - 1
						remainderHost += mark(`V${id}`)
						i++
						continue
					}
					const wordStart = i === from || IFS_BLANK.test(text[i - 1]) || /[;&()|<>]/.test(text[i - 1])
					if (wordStart && i !== escapedEnd) {
						// A comment starts only at a word start. The tokenizer
						// and bash agree here: both drop the text from the `#`
						// to end of line.
						remainderHost += text.slice(i, to)
						return null
					}
					// Mid-word `#`: an ordinary character to the shell, a
					// comment start to the tokenizer. Mask it to an opaque
					// placeholder so the rest of the line survives tokenization.
					const id = outcome.variables.push("#") - 1
					remainderHost += mark(`V${id}`)
					i++
					continue
				}
				if (maskedStart === -1) {
					remainderHost += char
				}
				i++
			}
			return null
		}
		/**
		 * Search for a heredoc terminator line in `[from, text.length)`. The
		 * search emulates the shell's read layer. A line runs to LF, or to end
		 * of input. POSIX bash keeps every CR as ordinary content. The
		 * msys/Cygwin read layer strips every CR before parsing. That layer is
		 * the reference shell on the Windows target. `EO<CR>F` therefore
		 * arrives as the terminator `EOF` and closes the heredoc early there.
		 * The strip also reaches the delimiter word. After a CRLF opener line,
		 * POSIX reads the delimiter `EOF<CR>` where msys reads `EOF`. A CR from
		 * the opener line through the closing terminator line leaves the two
		 * layers reading different bytes. The close then cannot be verified in
		 * a model-independent way. The mask-emission guard tests every masked
		 * span against the construct's region, so such heredocs fail closed for
		 * review. This over-rejects even a uniformly-CRLF construct whose
		 * models happen to agree. That is the accepted cost. A CR-free region
		 * is byte-identical under both models, so it parses. bash joins a
		 * backslash-newline pair before it matches the delimiter. An unquoted
		 * logical line whose stripped content ends in an odd number of
		 * backslashes therefore flows into the next physical line. A quoted
		 * delimiter makes the backslash literal, so no joining happens. The CR
		 * strip happens in the read layer and quoting does not affect it. `<<-`
		 * strips leading tabs from the fully joined line afterwards. It never
		 * strips from a physical line on its own. Return the body span
		 * `[bodyStart, bodyEnd)` and `rawIndex`: the index of the line-ending
		 * byte of the terminator line, or end of input when the terminator is
		 * the final line. Return null when no terminator line appears.
		 */
		const findTerminator = (
			from: number,
			delim: string,
			isQuoted: boolean,
			strip: boolean,
		): { rawIndex: number; bodyStart: number; bodyEnd: number } | null => {
			const bodyStart = from
			let i = from
			while (i < text.length) {
				const groupStart = i
				let candidate = ""
				for (;;) {
					const lineStart = i
					while (i < text.length && text[i] !== "\n") {
						i++
					}
					const logicalLine = text.slice(lineStart, i).replace(/\r/g, "")
					const trailingBackslashes = logicalLine.match(/\\*$/)?.[0].length ?? 0
					if (!isQuoted && text[i] === "\n" && trailingBackslashes % 2 === 1) {
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
					const candidateText = strip ? candidate.replace(/^\t+/, "") : candidate
					if (candidateText === delim) {
						return { rawIndex: i, bodyStart, bodyEnd: groupStart }
					}
					break
				}
				if (i < text.length) {
					i++ // consume the newline of a body line
				}
			}
			return null
		}
		// Emit the single H placeholder spanning `start` through `finalEnd` —
		// the last terminator of the chain — and append the live opener-line
		// remainder that `emitRemainder` buffered. `endIndex` is the index just
		// past the outer delimiter word, so the masked region skips the opener-
		// line remainder exactly once no matter how long the chain is. A no-word
		// opener masks through end of input instead; the metacharacter guard
		// above fails a no-word opener whose break was metacharacter-caused
		// closed before any mask is emitted, so the openers reaching this mask
		// are `<<` plus blanks: their line remainder is nothing but those
		// blanks.
		const emitMask = (finalEnd: number): { end: number } | { error: UnterminatedQuote } => {
			const fullSpan = text.slice(start, finalEnd)
			if (fullSpan.includes("\r")) {
				return { error: errorAt("heredoc", start) }
			}
			const region = wordPresent ? text.slice(start, endIndex) + text.slice(remainderEnd, finalEnd) : fullSpan
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
					outcome.host += remainderHost
				}
			}
			return { end: finalEnd }
		}
		// The shell expands the opener line's remainder after the delimiter,
		// even when the delimiter is quoted. Quoting suppresses expansion in
		// the body only. Walk the remainder unconditionally. An error there
		// fails the whole heredoc closed, like a body error does.
		const remainderEnd = endOfLine(endIndex)
		// bash discards a word-start `#` comment before tokenizing, so nothing
		// after that `#` on the opener line is live syntax. The backslash and
		// quote guards and the payload walk below read the remainder prefix
		// through this index; reading the discarded comment bytes would refuse
		// openers bash runs. The word-start and escape tests mirror the
		// comment branch of the live-text scan; the quoting rules match
		// `quoteStateAt` below. The mask region and the line-termination check
		// keep the physical `remainderEnd`.
		const commentOnset = (): number => {
			let j = endIndex
			let quote: "'" | '"' | null = null
			// Whether the open `quote` region was opened by `$'` or `$"`. Inside
			// such a region a backslash escapes the next byte, unlike inside a
			// plain single-quoted region where it is literal.
			let escapedQuote = false
			// Index just past the most recent `\c` escape pair, or -1. The
			// escaped character is word content to the shell, so a `#` directly
			// after the pair continues the word and cannot start a comment.
			// Stryker disable next-line NumberLiteral: the operator's replacements for this -1 sentinel are 0 and 1, and every `j` compared against it starts at or past the index after a `<<` (>= 2), so no replacement can block a different `#`.
			let escapedEnd = -1
			// Mirrors the remainder walk's expansion state: the closers this
			// scan must balance, and the index just past the most recent region
			// closer that emptied the frames. The shell ends a region at its
			// closer but not the surrounding word, so a `#` directly at that
			// index continues the word instead of starting a comment. A `)`
			// that closes no region (`case` pattern terminator, subshell group)
			// pops nothing and leaves the index untouched, so a `#` glued after
			// it still starts a comment.
			const frames: RemainderFrame[] = []
			// Stryker disable next-line NumberLiteral,UnaryOperator: the replacements for this -1 sentinel (0, 1, and +1) can never equal a `j`, which starts at or past the index after a `<<` (>= 2) and only advances past bytes this index gets assigned from.
			let closerEnd = -1
			while (j < remainderEnd) {
				const char = text[j]
				if (char === "\\" && (quote !== "'" || escapedQuote)) {
					escapedEnd = j + 2
					j += 2
					continue
				}
				if (quote === null) {
					const top = frames[frames.length - 1]
					if (top?.backtick) {
						// A backtick region is opaque except for its closer:
						// backticks do not nest, so nothing inside one opens a
						// frame that could take the closer's index.
						if (char === "`") {
							frames.pop()
							// Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: only a `#` glued after the backtick reads this index, and a backtick is neither blank nor metacharacter, so it never starts a word and no reachable input changes the scan's return.
							if (frames.length === 0) {
								// Stryker disable next-line ArithmeticOperator: `j - 1` marks a byte the scan has already passed -- the only byte it can block sits behind the moving index, so no reachable remainder returns a different onset.
								closerEnd = j + 1
							}
						}
						j++
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
								closerEnd = j + 1
							}
						}
						j++
						continue
					}
					if (top?.closer === ")" && char === "(") {
						// A bare `(` inside a `)`-closing region opens a group
						// the shell balances before the region's closer, so the
						// group's `)` cannot end the region.
						top.groupDepth++
						j++
						continue
					}
					if (char === "$" && (text[j + 1] === "'" || text[j + 1] === '"')) {
						// ANSI-C and locale quoting open an escaped region that
						// runs to the first unescaped copy of the quote byte,
						// like `openQuote`'s `ansi-c` and `locale` kinds. Pairing
						// raw quote bytes instead lets an escaped `\'` end the
						// region early and re-reads the word's live tail.
						const quoteByte: "'" | '"' = text[j + 1] === "'" ? "'" : '"'
						quote = quoteByte
						escapedQuote = true
						j += 2
						continue
					}
					if (char === "$" && (text[j + 1] === "(" || text[j + 1] === "{" || text[j + 1] === "[")) {
						// A `$((` region starts with one inner group pending,
						// so it closes past its second `)`.
						// Stryker disable next-line StringLiteral,ConditionalExpression: every reading that leaves `doubleArith` false re-counts the second `(` as an ordinary group paren at the same index and depth, so no reachable remainder moves the closer index.
						const doubleArith = text[j + 1] === "(" && text[j + 2] === "("
						const closer = text[j + 1] === "(" ? ")" : text[j + 1] === "[" ? "]" : "}"
						frames.push({ closer, groupDepth: doubleArith ? 1 : 0, backtick: false })
						j += doubleArith ? 3 : 2
						continue
					}
					if (char === "`") {
						// Stryker disable next-line StringLiteral: the frames stack consumes a backtick frame through the `backtick` flag's opaque branch, which matches the closer byte directly and never reads this string, so erasing it changes no pop.
						frames.push({ closer: "`", groupDepth: 0, backtick: true })
						j++
						continue
					}
					if ((char === "<" || char === ">") && text[j + 1] === "(") {
						frames.push({ closer: ")", groupDepth: 0, backtick: false })
						j += 2
						continue
					}
					if (char === "#" && j !== escapedEnd) {
						// The word-start rule mirrors the live-text scan's
						// comment branch: after a blank or a metacharacter, or
						// at the very start of the remainder, and never
						// directly at a region closer, where the shell ends
						// the region without ending the word.
						if (
							j !== closerEnd &&
							// Stryker disable next-line ConditionalExpression: the delimiter word absorbs `#`, so the remainder never starts with one; the disjunct's false replacement cannot move an onset, and the line's other condition readings stay pinned by parse-command.spec.ts's onset rows.
							(j === endIndex || IFS_BLANK.test(text[j - 1]) || /[;&()|<>]/.test(text[j - 1]))
						) {
							return j
						}
					} else if (char === "'" || char === '"') {
						quote = char
					}
				} else if (char === quote) {
					quote = null
					escapedQuote = false
				}
				j++
			}
			return remainderEnd
		}
		const liveRemainderEnd = commentOnset()
		// The quote state of the remainder `[from, to)`, with the same semantics
		// the remainder walk applies: outside single quotes a backslash pairs
		// with the next character, a region opened by `$'` or `$"` is escaped so
		// its backslash pairs even under the `'` quote byte, and only a matching
		// quote character closes an open region.
		const quoteStateAt = (from: number, to: number): "'" | '"' | null => {
			let quote: "'" | '"' | null = null
			let escapedQuote = false
			let j = from
			while (j < to) {
				const char = text[j]
				if (char === "\\" && (quote !== "'" || escapedQuote)) {
					j += 2
					continue
				}
				if (quote === null) {
					if (char === "$" && (text[j + 1] === "'" || text[j + 1] === '"')) {
						const quoteByte: "'" | '"' = text[j + 1] === "'" ? "'" : '"'
						quote = quoteByte
						escapedQuote = true
						j += 2
						continue
					}
					if (char === "'" || char === '"') {
						quote = char
					}
				} else if (char === quote) {
					quote = null
					escapedQuote = false
				}
				j++
			}
			return quote
		}
		if (wordPresent) {
			// bash joins a backslash-newline pair before tokenizing, even inside
			// double quotes. An odd unquoted backslash run at the end of the live
			// remainder therefore joins the rest of the opener line's syntax onto
			// the first body line, while the remainder cut here stops blindly at
			// that newline. The remainder cannot account for the joined bytes, so
			// the heredoc fails closed. Inside single quotes a backslash is
			// literal and no joining happens, so the guard stays silent there.
			let backslashRun = 0
			while (
				liveRemainderEnd - 1 - backslashRun >= endIndex &&
				text[liveRemainderEnd - 1 - backslashRun] === "\\"
			) {
				backslashRun++
			}
			if (backslashRun % 2 === 1 && quoteStateAt(endIndex, liveRemainderEnd - backslashRun) !== "'") {
				return { error: errorAt("heredoc", start) }
			}
			// bash carries a quote opened on the opener line across the newline.
			// When that quote closes on a later line, the bytes after its closer
			// are live syntax on a line this cut already masks as body, hidden
			// from the decomposition, so the heredoc fails closed. The cut test
			// is the next same-kind quote byte after the remainder; reading an
			// escaped closer as a close only over-rejects. A quote that never
			// closes again is bash's own syntax error: bash reads one unterminated
			// word and executes nothing, so those openers stay acceptable.
			const residualQuote = quoteStateAt(endIndex, liveRemainderEnd)
			if (residualQuote !== null && text.indexOf(residualQuote, remainderEnd) !== -1) {
				return { error: errorAt("heredoc", start) }
			}
		}
		const remainderError = walkBodyPayloads(endIndex, liveRemainderEnd, payloads, 0, true)
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
		if (wordPresent) {
			// Collect the chained openers on the opener line and buffer the
			// live remainder's host bytes. The bytes after a word-start `#`
			// stay uncollected: bash discards that comment before tokenizing,
			// so a `<<` inside it never opens a redirect.
			const remainderWalkError = emitRemainder(endIndex, remainderEnd)
			if (remainderWalkError) {
				return { error: remainderWalkError }
			}
			const outer = findTerminator(i, delimiter, quoted, stripTabs)
			if (!outer) {
				// The body never ends. Nothing after the opener can be trusted.
				return { error: errorAt("heredoc", start) }
			}
			if (!quoted) {
				const bodyError = walkBodyPayloads(outer.bodyStart, outer.bodyEnd, payloads, 0)
				if (bodyError) {
					return { error: bodyError }
				}
			}
			// bash reads a chained redirect's body from the input stream right
			// after the previous construct's terminator line, so each search
			// starts just past the previous terminator's line ending. A chained
			// body that never reaches its terminator is unaccountable: bash
			// keeps reading to end of input and expands every byte there, while
			// the main scan would read the leftover lines under its live-text
			// rules, where a `#` line hides commands bash executes. The whole
			// construct fails closed instead.
			let finalEnd = outer.rawIndex
			let searchStart = outer.rawIndex < text.length ? outer.rawIndex + 1 : outer.rawIndex
			for (const opener of chainOpeners) {
				let k = opener + 2
				const chainStrip = text[k] === "-"
				if (chainStrip) {
					k++
				}
				while (text[k] === " " || text[k] === "\t") {
					k++
				}
				const chain = parseHeredocDelimiter(text, k)
				if (chain.malformed) {
					// The walk cannot determine this chained delimiter's
					// terminator: an open quote region at end of input, or an
					// unquoted ANSI-C/locale quoting occurrence whose quote
					// removal the walk does not reproduce, so bash closes the
					// heredoc at a line this walk never derives. The body is
					// unaccountable, so fail closed.
					return { error: errorAt("heredoc", opener) }
				}
				const chainBody = findTerminator(searchStart, chain.delimiter, chain.quoted, chainStrip)
				if (!chainBody) {
					return { error: errorAt("heredoc", start) }
				}
				if (!chain.quoted) {
					const chainBodyError = walkBodyPayloads(chainBody.bodyStart, chainBody.bodyEnd, payloads, 0)
					if (chainBodyError) {
						return { error: chainBodyError }
					}
				}
				finalEnd = chainBody.rawIndex
				searchStart = chainBody.rawIndex < text.length ? chainBody.rawIndex + 1 : chainBody.rawIndex
			}
			// Inside an expansion no H placeholder is emitted, but the
			// enclosing frame's close hands its whole text to the expansion's
			// payload list, and re-scanning that text re-enters this heredoc
			// and collects these payloads there. Pushing them here as well
			// would emit each one twice.
			return emitMask(finalEnd)
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
	 *
	 * `maskTopLevelQuotes` marks the region as an opener-line remainder rather
	 * than a body: bash tokenizes the remainder, so a balanced top-level
	 * `'…'` span there undergoes quote removal and executes nothing inside it.
	 * A `"` tracks the double-quote state because a single quote inside a
	 * double-quoted word is literal while the word still expands. An unquoted
	 * `'` whose pair lies outside the region stays a literal character: bash
	 * carries it across the newline, and the residual-quote guard in
	 * `skipHeredoc` accounts for that shape. Bodies keep `'` literal: a heredoc
	 * body is not tokenized, so `'` there is data that cannot hide a payload.
	 */
	const walkBodyPayloads = (
		start: number,
		end: number,
		collect: string[],
		depth: number,
		maskTopLevelQuotes = false,
	): UnterminatedQuote | null => {
		if (depth > MAX_PAYLOAD_SCAN_DEPTH) {
			return errorAt("nesting-too-deep", start)
		}
		const frames: RegionFrame[] = []
		let dqOpen = false
		// Index just past the most recent non-group frame close in this walk,
		// or -1. The shell ends an expansion at its closer but not the
		// surrounding word, so a `#` directly there continues the word instead
		// of starting a comment. A group-paren closer is a word boundary, so
		// the group path never sets this index.
		// Stryker disable next-line UnaryOperator: every walk starts at or past index 2 and frame content starts later still, so the sentinel `+1` can never equal the scan index at a frame-comment position, and no reachable input distinguishes it from `-1`.
		let frameCloseEnd = -1
		// Index just past the most recent ordinary `\c` escape pair consumed
		// inside a frame, or -1. The escaped character is word content to the
		// shell, so a `#` directly after the pair continues the word even when
		// the escaped character is a blank. A backslash-newline pair is
		// excluded: the shell removes it before tokenizing, leaving no word
		// content, so the frame comment rule decides a `#` after it against the
		// logical boundary instead.
		// Stryker disable next-line NumberLiteral,UnaryOperator: the replacements for this -1 sentinel (0, 1, +1) can never equal the scan index at a frame-comment position — frame content starts past index 2 — so no reachable input distinguishes them from `-1`.
		let frameEscapeEnd = -1
		let i = start
		while (i < end) {
			const char = text[i]
			const top = frames[frames.length - 1]
			if (top) {
				if (top.escaped && char === "\\") {
					// A backslash-newline pair is removed by the shell before
					// tokenizing, so recording it as a word-continuation end
					// would exempt a `#` that follows from the comment rule and
					// hide a comment that swallows the frame closer. Byte
					// consumption is identical either way.
					if (text[i + 1] !== "\n") {
						frameEscapeEnd = i + 2
					}
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
				// is the default $IFS blanks plus the metacharacters that end
				// a word. A missed comment lets its `)` slice the payload, so
				// the boundary must be exact. Directly at `frameCloseEnd` the
				// word also continues: a closer that popped a nested frame ends
				// the expansion, not the word. Directly at `frameEscapeEnd` it
				// continues too: the escaped character — a blank included — is
				// word content, so the raw blank before the `#` is not a real
				// word boundary. The boundary byte is the one the shell sees,
				// so backslash-newline continuations are walked over first.
				if (
					char === "#" &&
					(top.kind === "command-substitution" || top.kind === "process-substitution") &&
					i !== frameCloseEnd &&
					i !== frameEscapeEnd &&
					logicalWordBoundaryBefore(text, i)
				) {
					// A comment terminated by a lone CR reads differently in
					// the executing shell, so its region extent is ambiguous.
					// Fail closed instead of guessing how far the shell's
					// comment reaches into the region.
					const lineEnd = endOfLine(i)
					if (terminatesAtLoneCR(lineEnd)) {
						return errorAt("ambiguous-comment", i)
					}
					// Clamp at the region end. A comment that runs past it
					// leaves the frame open, and the still-open frame fails
					// closed.
					i = Math.min(lineEnd, end)
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
					frameCloseEnd = i + 1
					if (QUOTE_FRAME_KINDS.includes(closed.kind)) {
						// Quote regions are opaque. Nothing inside them is
						// extracted. The enclosing frame resumes after the
						// closing quote.
						i++
						continue
					}
					// One emission channel per payload, as in the main scan: a
					// frame delivers only when a parameter expansion is its
					// directly enclosing frame. A deeper close rides the
					// enclosing chain's outermost slice and is recovered when
					// that payload is re-scanned; pushing its slice here too
					// would emit it twice. Slicing every close eagerly would
					// also cost O(n²) on adversarial nesting.
					if (closed.kind === "parameter-expansion") {
						const parent = frames[frames.length - 1]
						if (frames.length === 0) {
							collect.push(...(closed.payloads ?? []))
						} else {
							// Stryker disable next-line ArrayDeclaration: a closed parameter-expansion frame always carries a payload list, so the empty-coalesce default has no reachable reader.
							parent.payloads?.push(...(closed.payloads ?? []))
						}
					} else {
						const parent = frames[frames.length - 1]
						if (frames.length === 0) {
							collect.push(trimScanBlanks(text.slice(closed.contentStart, i)))
						} else {
							parent.payloads?.push(trimScanBlanks(text.slice(closed.contentStart, i)))
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
			if (maskTopLevelQuotes) {
				if (char === '"') {
					dqOpen = !dqOpen
					i++
					continue
				}
				if (char === "$" && !dqOpen && text[i + 1] === "'") {
					// An ANSI-C word is opaque to its first unescaped `'`, like
					// `openQuote`'s `ansi-c` kind: its `\'` escapes, so pairing
					// raw quote bytes would end the word early and re-read the
					// bytes bash keeps inside it, or (reversed) swallow the live
					// bytes after it. An unterminated region is bash's own
					// syntax error: the shell reads one word to end of input
					// and expands nothing there, so the rest of the region
					// carries no payload.
					let k = i + 2
					while (k < end) {
						if (text[k] === "\\") {
							k += 2
							continue
						}
						if (text[k] === "'") {
							break
						}
						k++
					}
					i = k < end ? k + 1 : end
					continue
				}
				if (char === "'" && !dqOpen) {
					const close = text.indexOf("'", i + 1)
					if (close !== -1 && close < end) {
						i = close + 1
						continue
					}
				}
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
				const arm = openerContinuationRunEnd(text, i + 1)
				if (text[arm] === "(") {
					// skipArithmetic reads the `$((` bytes as adjacent, so the
					// arithmetic arm stays at raw adjacency. A `$` the join
					// brings to a `(` followed by another `(` takes the
					// command-substitution push below instead, where the loop
					// re-reads the second `(` as a group paren.
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
						frameCloseEnd = arith.end
						i = arith.end
						continue
					}
					frames.push({
						kind: "command-substitution",
						openIndex: i,
						closer: ")",
						contentStart: arm + 1,
						escaped: true,
						groupDepth: 0,
						payloads: null,
					})
					i = arm + 1
					continue
				}
				if (text[arm] === "{") {
					if (openerRunCarriesCR(text, i + 1, arm)) {
						// A carriage return inside the continuation leaves the
						// joined `${` ambiguous between read models of the
						// executing shell. Masking the region could hide a
						// brace group one model runs as separate live syntax,
						// so this opener fails closed instead of masking.
						return errorAt("ambiguous-opener", i)
					}
					frames.push({
						kind: "parameter-expansion",
						openIndex: i,
						closer: "}",
						// Stryker disable next-line ArithmeticOperator: a parameter-expansion frame's close routes payloads through its payload list and its host text slices from the opener, so this content start has no reader and no emitted byte can differ.
						contentStart: arm + 1,
						escaped: true,
						groupDepth: 0,
						payloads: [],
					})
					i = arm + 1
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
			if (char === "<" || char === ">") {
				const psArm = openerContinuationRunEnd(text, i + 1)
				if (text[psArm] === "(") {
					frames.push({
						kind: "process-substitution",
						openIndex: i,
						closer: ")",
						contentStart: psArm + 1,
						escaped: true,
						groupDepth: 0,
						payloads: null,
					})
					i = psArm + 1
					continue
				}
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
	 * Index after the region of shell syntax that opens at `i`, `INERT_UNCLOSED`
	 * when a region opens there but never closes, or null when no region opens
	 * there. The regions counted here are inert to a delimiter scan: the shell
	 * reads each interior with its own matching rules, so none can contain the
	 * enclosing scan's closer. Quotes follow `openQuote`'s escaping; a backtick
	 * region ends at the next backtick and does not nest; a `${…}` body
	 * balances nested `${…}` regions and treats bare parens as literal word
	 * text; a `$(…)` body balances nested `${…}` regions and bare grouping
	 * parens.
	 *
	 * `substitutionIsText` stops `$(` from opening a region. bash's legacy
	 * `$[…]` arithmetic reader ends the expression at an unquoted `]` even
	 * inside an open command substitution, so the `$[…]` closer scan must keep
	 * seeing that byte. The input where the `]` is the substitution's own
	 * closer is a shell error; skipping it lets the interior walk report the
	 * still-open `$(`.
	 *
	 * A region still open at end of input is bash's own unclosed-delimiter
	 * error: the shell reads every later byte inside that region, so the tail
	 * holds no further region opener for an enclosing closer scan to find.
	 * Reporting the case separately from "no region" lets that scan mask the
	 * tail instead of re-running this walk from the next byte; conflating the
	 * two readings rescans the whole tail once per byte.
	 */
	const skipInertRegion = (i: number, substitutionIsText = false): number | null => {
		const quote = openQuote(i)
		const dollarNext = text[i] === "$" ? text[i + 1] : ""
		if (quote === null && text[i] !== "`" && dollarNext !== "{" && !(dollarNext === "(" && !substitutionIsText)) {
			return null
		}
		// One open region. `opaque` regions read only their closer; inside the
		// others, nested regions still open. `groups` marks a command-context
		// region, where a bare `(` opens a subshell group the shell balances
		// before the region's own closer.
		const frames: { closer: string; escaped: boolean; opaque: boolean; groups: boolean }[] = []
		let j = i
		if (quote) {
			frames.push({ closer: quote.closer, escaped: quote.escaped, opaque: true, groups: false })
			j = quote.contentStart
		} else if (text[i] === "`") {
			frames.push({ closer: "`", escaped: true, opaque: true, groups: false })
			j++
		} else if (dollarNext === "{") {
			frames.push({ closer: "}", escaped: true, opaque: false, groups: false })
			j += 2
		} else {
			frames.push({ closer: ")", escaped: true, opaque: false, groups: true })
			j += 2
		}
		while (j < text.length && frames.length > 0) {
			const top = frames[frames.length - 1]
			const char = text[j]
			if (top.escaped && char === "\\") {
				j += 2
				continue
			}
			if (char === top.closer) {
				frames.pop()
				j++
				continue
			}
			// Quote and backtick regions are opaque except for their closer and
			// their escapes. Backticks do not nest.
			if (top.opaque) {
				j++
				continue
			}
			const nestedQuote = openQuote(j)
			if (nestedQuote) {
				frames.push({ closer: nestedQuote.closer, escaped: nestedQuote.escaped, opaque: true, groups: false })
				j = nestedQuote.contentStart
				continue
			}
			if (char === "`") {
				frames.push({ closer: "`", escaped: true, opaque: true, groups: false })
				j++
				continue
			}
			if (char === "$" && text[j + 1] === "{") {
				frames.push({ closer: "}", escaped: true, opaque: false, groups: false })
				j += 2
				continue
			}
			if (char === "$" && text[j + 1] === "(") {
				frames.push({ closer: ")", escaped: true, opaque: false, groups: true })
				j += 2
				continue
			}
			if (char === "(" && top.groups) {
				frames.push({ closer: ")", escaped: true, opaque: false, groups: true })
				j++
				continue
			}
			j++
		}
		return frames.length === 0 ? j : INERT_UNCLOSED
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
			// `$[…]` balances plain brackets: a subscript's `[` opens one the
			// shell closes last-open-first, so the expression ends at the
			// depth-zero `]`. Regions the shell reads with their own rules are
			// inert here, exactly as in the `$((` loop below.
			let depth = 1 // the opening bracket
			let j = i + 2
			// Set once the scan passes an unclosed frame-kind region (`$(`,
			// `${`, backtick). The shell reads every later byte inside that
			// region, so no later byte can open one: plain counting finishes
			// the scan instead of re-walking the tail at each byte. An
			// expression closed through such a masked tail still holds that
			// opener in its interior, so the interior walk fails it closed.
			// An unclosed quote is invisible to that walk, which reads a
			// top-level quote as literal text, so it ends the expression
			// unclosed at the opener instead — bash refuses that input too.
			let maskedTail = false
			while (j < text.length) {
				const jumped = maskedTail ? null : skipInertRegion(j, true)
				if (jumped === INERT_UNCLOSED) {
					if (openQuote(j) !== null) {
						// Stryker disable next-line ObjectLiteral: the callers only test `closed`'s falsiness on this path and fail closed immediately, never reading `end`, so an empty object emits the same error and host bytes.
						return { end: text.length, closed: false }
					}
					maskedTail = true
					j++
					continue
				}
				if (jumped !== null) {
					j = jumped
					continue
				}
				if (text[j] === "[") {
					depth++
				} else if (text[j] === "]") {
					depth--
					if (depth === 0) {
						return { end: j + 1, closed: true }
					}
				}
				j++
			}
			return { end: text.length, closed: false }
		}
		// $(( … )) balances plain parens. An unbalanced scan runs to end of input.
		let depth = 2 // the two opening parens
		let j = i + 3
		// The `$[…]` loop's masked-tail rule applies here too, unclosed-quote
		// split included: past an unclosed frame-kind region the shell opens
		// nothing else, so plain counting keeps the scan linear without
		// changing what the depth sees, while an unclosed quote ends the
		// expression because the interior walk reads it as literal text.
		let maskedTail = false
		while (j < text.length && depth > 0) {
			const jumped = maskedTail ? null : skipInertRegion(j)
			if (jumped === INERT_UNCLOSED) {
				if (openQuote(j) !== null) {
					// Stryker disable next-line ObjectLiteral: the callers only test `closed`'s falsiness on this path and fail closed immediately, never reading `end`, so an empty object emits the same error and host bytes.
					return { end: text.length, closed: false }
				}
				maskedTail = true
				j++
				continue
			}
			if (jumped !== null) {
				j = jumped
				continue
			}
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
				// A backslash-newline pair is removed by the shell before
				// tokenizing, so recording it as a word-continuation end would
				// exempt a `#` that follows from the comment rule and hide a
				// comment that swallows the frame closer. Byte consumption is
				// identical either way.
				if (text[i + 1] !== "\n") {
					frameEscapeEnd = i + 2
				}
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
						const id = outcome.substitutions.push(trimScanBlanks(text.slice(closed.contentStart, i))) - 1
						outcome.host += mark(`S${id}`)
					}
					expansionCloseEnd = closeEnd
				} else {
					// The frame is nested inside an open region. Its content
					// reaches the segment list through one channel: when the
					// enclosing chain's outermost member closes directly inside
					// a parameter expansion, its text joins that expansion's
					// payload list, and re-scanning that payload extracts every
					// substitution nested anywhere beneath it. Delivering a
					// deeper frame's slice as well would emit its content
					// twice — once directly, once through the enclosing
					// payload's re-scan — and slicing every close eagerly would
					// cost O(n²) on adversarial nesting. So a frame delivers
					// only when the expansion is its directly enclosing frame.
					// A parameter-expansion frame carries its payload list
					// rather than its text: an enclosing expansion restores its
					// text verbatim and never re-scans it, so merging the list
					// into the enclosing expansion is that list's only carrier.
					frameCloseEnd = closeEnd
					const parent = stack[stack.length - 1]
					if (closed.kind === "parameter-expansion") {
						// Stryker disable next-line ArrayDeclaration: a closed parameter-expansion frame always carries a payload list, so the empty-coalesce default has no reachable reader.
						parent.payloads?.push(...(closed.payloads ?? []))
					} else {
						parent.payloads?.push(trimScanBlanks(text.slice(closed.contentStart, i)))
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
			// A `#` at the start of a word inside a `$(…)`/`<(` frame begins a
			// comment. bash discards the comment bytes before parsing, so
			// nothing after them on the line executes, and the comment runs to
			// end of line, not to the frame's closer. A `$(` or `)` inside the
			// comment therefore never opens or closes a frame. Quote and
			// backtick frames keep `#` literal and are opaque before this
			// point. A parameter expansion keeps it too: `${#var}` and
			// `${x#pat}` are operator syntax. The word-boundary set is the
			// body walk's rule: the default $IFS blanks plus the
			// metacharacters that end a word, so a `#` glued to a word stays
			// word text. Directly at `frameCloseEnd` the word continues as
			// well: a closer that popped a nested frame ends the expansion,
			// not the word. Directly at `frameEscapeEnd` it continues too: the
			// escaped character — a blank included — is word content, so the
			// raw blank before the `#` is not a real word boundary. The
			// boundary byte is the one the shell sees, so backslash-newline
			// continuations are walked over before the test.
			if (
				char === "#" &&
				(top.kind === "command-substitution" || top.kind === "process-substitution") &&
				i !== frameCloseEnd &&
				i !== frameEscapeEnd &&
				logicalWordBoundaryBefore(text, i)
			) {
				// A comment terminated by a lone CR reads differently in the
				// executing shell. The comment (quotes inside it included)
				// extends past where this scan resumes, so the region extent
				// is ambiguous and the input fails closed.
				const lineEnd = endOfLine(i)
				if (terminatesAtLoneCR(lineEnd)) {
					outcome.error = errorAt("ambiguous-comment", i)
					return outcome
				}
				i = lineEnd
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
				const arm = openerContinuationRunEnd(text, i + 1)
				if (text[arm] === "(") {
					// skipArithmetic reads the `$((` bytes as adjacent, so the
					// arithmetic arm stays at raw adjacency. A `$` the join
					// brings to a `(` followed by another `(` takes the
					// command-substitution push below instead, where the loop
					// re-reads the second `(` as a group paren.
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
						// substitutions into the payload list only when the
						// arithmetic sits directly inside an expansion: from any
						// deeper frame the enclosing chain's delivered text
						// re-scan re-enters this arithmetic and collects them
						// there, so a push here would emit each twice.
						if (stack[stack.length - 1] === innermostParam(stack, paramFramesOpen)) {
							// Stryker disable next-line OptionalChaining: the guard just proved the innermost expansion exists and every expansion frame carries a payload list, so neither optional chain here can short-circuit on reachable input.
							innermostParam(stack, paramFramesOpen)?.payloads?.push(...arithPayloads)
						}
						frameCloseEnd = arith.end
						i = arith.end
						continue
					}
					stack.push({
						kind: "command-substitution",
						openIndex: i,
						closer: ")",
						contentStart: arm + 1,
						escaped: true,
						groupDepth: 0,
						payloads: null,
					})
					i = arm + 1
					continue
				}
				if (text[arm] === "{") {
					if (openerRunCarriesCR(text, i + 1, arm)) {
						// Same fail-closed rule as the `{` arm of the body
						// walk: a CR in the continuation makes the joined
						// opener ambiguous, so the scan refuses the input
						// instead of masking the region behind a frame.
						outcome.error = errorAt("ambiguous-opener", i)
						return outcome
					}
					stack.push({
						kind: "parameter-expansion",
						openIndex: i,
						closer: "}",
						// Stryker disable next-line ArithmeticOperator: a parameter-expansion frame's close routes payloads through its payload list and its host text slices from the opener, so this content start has no reader and no emitted byte can differ.
						contentStart: arm + 1,
						escaped: true,
						groupDepth: 0,
						payloads: [],
					})
					paramFramesOpen++
					i = arm + 1
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
			if (char === "<" || char === ">") {
				const psArm = openerContinuationRunEnd(text, i + 1)
				if (text[psArm] === "(") {
					stack.push({
						kind: "process-substitution",
						openIndex: i,
						closer: ")",
						contentStart: psArm + 1,
						escaped: true,
						groupDepth: 0,
						payloads: null,
					})
					i = psArm + 1
					continue
				}
			}
			// Inside a parameter expansion, bash reads `<<` as an arithmetic
			// shift, or as literal word text. It never reads it as a heredoc
			// opener. There, the scan consumes `<<` as an ordinary character.
			// Only command-substitution and process-substitution frames reach
			// the heredoc scan. The shell tokenizes those as command contexts,
			// and a heredoc opened there is real. Quote and backtick frames are
			// opaque before this point.
			if (char === "<" && text[i + 1] === "<" && text[i + 2] === "<") {
				// A herestring (<<<) is one operator, never a heredoc opener.
				// Consume all three characters: stopping at the second `<`
				// would pass the heredoc guard below and open a heredoc on the
				// herestring word.
				i += 3
				continue
			}
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
			// literal. A backslash-newline pair is removed by the shell before
			// tokenizing, so recording it as a word-continuation end would
			// exempt a `#` that follows from the comment rule and hide a
			// comment that swallows the rest of the line. Byte consumption is
			// identical either way.
			// An escaped glob metacharacter is a literal word character to the
			// shell, so the word cannot glob-expand on it. The tokenizer would
			// still read the raw `\c` pair as a live glob and collapse the whole
			// word, swallowing any masked construct that shares the word. Mask
			// the pair as an opaque placeholder instead: the word keeps its
			// placeholder structure, the escape survives restoration, and a
			// substitution sharing the word still reaches extraction.
			const escapedChar = text[i + 1]
			if (escapedChar === "*" || escapedChar === "?" || escapedChar === "[") {
				const id = outcome.escapedGlobs.push(text.slice(i, i + 2)) - 1
				outcome.host += mark(`g${id}`)
				// Stryker disable next-line ArithmeticOperator: both readers test the raw byte before the pair end, one of `*?[` — neither a word boundary for the comment branch nor a metacharacter for the placeholder branch, so the value decides nothing.
				escapedWordCharEnd = i + 2
				i += 2
				continue
			}
			outcome.host += text.slice(i, i + 2)
			if (text[i + 1] !== "\n") {
				escapedWordCharEnd = i + 2
			}
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
		if (char === "#" && logicalWordBoundaryBefore(text, i) && i !== escapedWordCharEnd) {
			// Comment: pass the rest of the line through untouched. Quotes and
			// delimiters inside a comment are not shell syntax. shell-quote drops
			// the comment text when it tokenizes. This branch also excludes a `#`
			// at the end of a `\c` escape pair, even when the escaped character
			// is whitespace. The escape makes it word content, so that `#`
			// continues the word and the masking branch below handles it. The
			// boundary byte is the one the shell sees, so backslash-newline
			// continuations are walked over before the test.
			const end = endOfLine(i)
			// A comment terminated by a lone CR ends at a different byte for
			// the executing shell: the shell's comment (quotes inside it
			// included) extends past where this scan resumes, and a quote
			// opener among those bytes would open a live region here while
			// the shell never sees it as syntax. The disagreement cannot be
			// resolved by either reading, so the input fails closed.
			if (terminatesAtLoneCR(end)) {
				outcome.error = errorAt("ambiguous-comment", i)
				return outcome
			}
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
		if (char === "<" || char === ">") {
			const psArm = openerContinuationRunEnd(text, i + 1)
			if (text[psArm] === "(") {
				stack.push({
					kind: "process-substitution",
					openIndex: i,
					closer: ")",
					contentStart: psArm + 1,
					escaped: true,
					groupDepth: 0,
					payloads: null,
				})
				i = psArm + 1
				continue
			}
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
			const arm = openerContinuationRunEnd(text, i + 1)
			if (text[arm] === "(") {
				// skipArithmetic reads the `$((` bytes as adjacent, so the
				// arithmetic arm stays at raw adjacency. A `$` the join brings
				// to a `(` followed by another `(` takes the
				// command-substitution push below instead, where the loop
				// re-reads the second `(` as a group paren.
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
					contentStart: arm + 1,
					escaped: true,
					groupDepth: 0,
					payloads: null,
				})
				i = arm + 1
				continue
			}
			if (text[arm] === "{") {
				if (openerRunCarriesCR(text, i + 1, arm)) {
					// Same fail-closed rule as the other `{` arms: a CR in the
					// continuation makes the joined opener ambiguous, so the
					// scan refuses the input instead of masking the region
					// behind an expansion frame.
					outcome.error = errorAt("ambiguous-opener", i)
					return outcome
				}
				stack.push({
					kind: "parameter-expansion",
					openIndex: i,
					closer: "}",
					// Stryker disable next-line ArithmeticOperator: a parameter-expansion frame's content start has no reader — its close routes payloads through the frame's payload list and its host text slices from the opener — so any value here emits identical bytes.
					contentStart: arm + 1,
					escaped: true,
					groupDepth: 0,
					payloads: [],
				})
				paramFramesOpen++
				i = arm + 1
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
 *   delimiter suppresses all expansion in the body. A backslash-newline pair
 *   is a continuation the shell removes before tokenizing the word, so it is
 *   not a quoting construct and leaves the body expansion-active.
 * - `wordPresent`: whether any delimiter token appeared at all. A bare `<<`
 *   before end of line has none.
 * - `malformed`: whether this walk cannot determine the terminator bash will
 *   use: the word reached end of input with a quote region still open, or it
 *   contains an unquoted ANSI-C/locale quoting occurrence whose quote removal
 *   the walk does not reproduce — adjacency read from the shell's
 *   continuation-removed view. bash then reads a multi-line word no body line
 *   can match, or closes the heredoc at a line this walk never derives. No
 *   body can be accounted for.
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
	// bash removes backslash-newline line continuations before tokenizing, so
	// a `$'` or `$"` occurrence can form from bytes on separate physical
	// lines: `a$` plus a continuation plus `'b'` is the word `a$'b'`. bash
	// applies ANSI-C/locale quote removal to every unquoted such occurrence —
	// mid-word, at the start, and across any run of continuations joining the
	// bytes — before matching the delimiter word against a terminator line, so
	// such a word closes the heredoc at text this walk never derives
	// (`$'EOF'` terminates at `EOF`, not `$EOF`; the joined `a$\<LF>'b'` at
	// `ab`). The terminator is undeterminable: fail closed. An escaped `\$` is
	// a literal dollar, a `$` inside a quote region is ordinary word content,
	// and any byte that survives the removal (a space) keeps the pair apart
	// for bash too; the walk reproduces all three exactly.
	let ansiCPrefix = false

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
			if (i + 1 < command.length) {
				// bash removes a backslash-newline pair as a line continuation
				// before tokenizing, so the pair never quotes the delimiter
				// word and leaves no byte of itself in the word.
				if (command[i + 1] !== "\n") {
					quoted = true
					delimiter += command[i + 1]
				}
				i += 2
				continue
			}
			// A backslash at end of input has nothing to escape: bash drops
			// the dangling byte from the word as well, but the word is still
			// an escaping construct, so the body stays opaque.
			// Stryker disable next-line BooleanLiteral: this branch only runs when the backslash is the input's last byte, so no body or terminator can follow and the quoting flag cannot reach any observable.
			quoted = true
			i++
			continue
		}
		// The unquoted path: the escaped `\$` was consumed as a literal above,
		// so a `$` still standing here can open the byte pair bash removes
		// quotes for. bash removes backslash-newline pairs before tokenizing,
		// so the pair counts even when a run of line continuations separates
		// the bytes.
		if (char === "$") {
			const j = continuationRunEnd(command, i + 1)
			if (command[j] === "'" || command[j] === '"') {
				ansiCPrefix = true
			}
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
		malformed: quote !== null || ansiCPrefix,
	}
}

/** Look up the raw text that a placeholder name stands for, or undefined. */
function lookupPlaceholder(name: string, outcome: ScanOutcome): string | undefined {
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
		case "g":
			return outcome.escapedGlobs[index]
		case "R":
			return outcome.redirections[index]
		case "A":
			return outcome.arithmetic[index]
		case "S":
			// A substitution placeholder never reaches restoration: the tokenize
			// path consumes it as a segment boundary and routes its payload
			// through the re-scan, and a tokenizer rejection fails the whole
			// command closed before any restoration runs.
			return undefined
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
function expandPlaceholders(text: string, outcome: ScanOutcome): string {
	// Stryker disable next-line BooleanLiteral: substitution placeholders never reach decision-path restoration (the word loop consumes them as segment boundaries), so no input distinguishes true from false here.
	return expandPlaceholdersWith(text, outcome, false)
}

/**
 * Message-path variant of `expandPlaceholders`: it also renders substitution
 * placeholders as their `$(…)` payload text. A rejection excerpt quotes the
 * offending word back to the reader, and dropping the substitution there would
 * hide the very construct the message names. Decision paths keep using
 * `expandPlaceholders`: a substitution payload reaches those through segment
 * extraction and the re-scan, never through restored host text.
 */
function expandPlaceholdersForMessage(text: string, outcome: ScanOutcome): string {
	return expandPlaceholdersWith(text, outcome, true)
}

function expandPlaceholdersWith(text: string, outcome: ScanOutcome, withSubstitutions: boolean): string {
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
		if (withSubstitutions && parts[p][0] === "S") {
			// Stryker disable next-line StringLiteral: every `S<id>` name was emitted at its push, so the registry entry always exists and the fallback is unreachable.
			const raw = outcome.substitutions[Number(parts[p].slice(1))] ?? ""
			out += `$(${raw})`
			continue
		}
		const value = lookupPlaceholder(parts[p], outcome)
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
 * byte, substitution nesting beyond the re-scan depth cap, or the shell
 * tokenizer rejecting the masked command. When `parseError` is set, the
 * `commands` array contains the raw input as a single opaque token. A command
 * whose structure the parser cannot fully account for must never reach
 * approval: the tool call fails with an error instead. It must not get a free
 * pass built on a partial decomposition.
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
		allCommands.push(...parseLine(line, outcome, 0, false))
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
 * `fromPayload` marks a re-scan of an extracted substitution payload: there a
 * glob token fails closed, because the reconstructed word would be the bare
 * literal `glob` instead of the files bash expands the pattern to.
 */
function parseLine(line: string, outcome: ScanOutcome, depth: number, fromPayload: boolean): string[] {
	let tokens: ShellToken[]
	try {
		tokens = parse(line) as ShellToken[]
	} catch {
		// The masked host text carries no active shell syntax, so a tokenizer
		// rejection means the decomposition cannot account for this line.
		// Splitting on operators here would not recurse into payloads — a
		// substitution's inner text would ride its host word, letting a hidden
		// command ride the host's allowlist match to an approval. Fail closed
		// on the shared error channel: the caller re-checks `outcome` after
		// every line and returns the raw input as one opaque token.
		// Both the line and the tokenizer's error text may echo payload
		// content (shell-quote embeds slices of the offending input). The
		// returned message reaches the model and the command-status UI, so
		// like the console warning it carries no content — only the fixed
		// classification, never an echo of the rejected command.
		console.warn(`shell-quote parse error: tokenizer rejected a ${line.length}-character command line`)
		outcome.error = {
			quoteType: "tokenize-failure",
			openIndex: 0,
			message: "Malformed command: shell tokenizer rejected the command.",
		}
		return []
	}

	const commands: string[] = []
	let current: string[] = []
	let pendingPayloads: string[] = []

	const flush = (): void => {
		if (current.length > 0) {
			commands.push(expandPlaceholders(current.join(" "), outcome))
			current = []
		}
		for (const raw of pendingPayloads) {
			commands.push(...scanPayloadSegments(raw, outcome, depth + 1))
		}
		pendingPayloads = []
	}

	for (const token of tokens) {
		if (typeof token === "object" && "op" in token) {
			if (["&&", "||", ";", "|", "&", "|&"].includes(token.op)) {
				flush()
			} else if (token.op === "glob" && fromPayload) {
				// The tokenizer reduces a glob word to `{ op: "glob" }` and
				// keeps the pattern only on `pattern`, which this
				// reconstruction drops. The re-scanned payload would then
				// carry the bare word `glob` — a word that matches allow and
				// deny prefixes no more specifically than the files bash may
				// expand the pattern to, and possibly to denylisted binaries.
				// That under-approximation cannot carry an approval, so the
				// payload fails closed on the shared error channel.
				outcome.error = {
					quoteType: "payload-glob",
					openIndex: 0,
					// The excerpt quotes the command back to the user, so expand
					// the placeholders first: the raw masked text would expose
					// the placeholder sentinel and internal names in a message
					// the model also reads. Substitutions render as their payload
					// text so the excerpt shows the construct it rejects.
					message: unterminatedQuoteMessage("payload-glob", 0, expandPlaceholdersForMessage(line, outcome)),
				}
				return []
			} else if (
				// Stryker disable next-line ConditionalExpression,LogicalOperator: only glob tokens carry `pattern` at runtime, so widening the `in` check (to true, or across the `&&`) sends every reachable token to the same branch; the operand exists only to type the pattern access.
				"pattern" in token &&
				carriesExecutablePlaceholder(token.pattern)
			) {
				// A host-level glob word that shares its word with a masked
				// construct swallows that construct's placeholder into the
				// collapsed pattern. The placeholder never reaches the word
				// loop below, so the construct's payload — a command
				// substitution's inner command — is never extracted,
				// re-scanned, or checked. The collapsed word `glob` then rides
				// the host's allow rule to an approval while bash runs the
				// embedded command. A glob word that shares its word only with
				// a payload-free variable or redirection keeps its main-line
				// host-glob behavior. Only placeholder-carrying glob words fail
				// closed, on the shared error channel like `payload-glob`.
				outcome.error = {
					quoteType: "placeholder-glob",
					openIndex: 0,
					// Expand before excerpting: the raw masked line would expose
					// the placeholder sentinel and internal names in a message
					// the model also reads. Substitutions render as their payload
					// text so the excerpt shows the construct it rejects.
					message: unterminatedQuoteMessage(
						"placeholder-glob",
						0,
						expandPlaceholdersForMessage(line, outcome),
					),
				}
				// Stryker disable next-line ArrayDeclaration: with the error already recorded, `parseCommand` discards this list and returns the raw input as the one opaque token, so no reachable test can observe the difference between `[]` and a non-empty list.
				return []
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
		// This word carries placeholders. A masked escaped glob sharing the
		// word with a placeholder whose inner commands this loop cannot prove
		// it has seen stays on the placeholder-glob rejection channel: masking
		// hides the word from the tokenizer's glob collapse, and a substitution
		// the region's payload list does not carry would otherwise ride the
		// accept path unexamined while the executing shell runs it.
		if (escapedGlobRidesUncheckedPlaceholder(token)) {
			outcome.error = {
				quoteType: "placeholder-glob",
				openIndex: 0,
				message: unterminatedQuoteMessage("placeholder-glob", 0, expandPlaceholdersForMessage(line, outcome)),
			}
			// Stryker disable next-line ArrayDeclaration: with the error already recorded, `parseCommand` discards this list and returns the raw input as the one opaque token, so no reachable test can observe the difference between `[]` and a non-empty list.
			return []
		}
		// Reconstruct the non-substitution placeholders for verbatim
		// restoration. Treat substitution placeholders as segment boundaries.
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
		parts.push(...parseLine(line, nested, depth, true))
		if (nested.error !== null) {
			outcome.error = nested.error
			return []
		}
	}
	return parts
}
