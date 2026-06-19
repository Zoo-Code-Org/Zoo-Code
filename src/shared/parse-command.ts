import { parse } from "shell-quote"

export type ShellToken = string | { op: string } | { command: string }

/**
 * The style of quoting that opened a region.
 *
 * - `posix-single` and `ansi-c` share the `'` delimiter but follow different
 *   escaping rules, so they must be distinguished.
 * - `locale` and `double` share the `"` delimiter but `locale` is prefixed with
 *   `$` (like ANSI-C), making `$"..."` a distinct token for accurate restoration.
 * - `heredoc` covers `<<WORD`, `<<'WORD'`, `<<"WORD"`, and `<<\WORD` openers
 *   whose body extends through the terminator line.
 */
export type QuoteType = "posix-single" | "ansi-c" | "double" | "locale" | "heredoc"

/**
 * The result of parsing a command string.
 *
 * `commands` is the list of individual sub-commands produced by splitting on
 * unquoted newlines and chain operators. When `parseError` is non-null the
 * command string is syntactically malformed (e.g. an unterminated quote) and
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
 * Describes the opening of a quoted region that is never closed.
 *
 * - `quoteType`: the style of the unterminated quote. `"heredoc"` means a
 *   `<<WORD` opener whose terminator line was never found.
 * - `openIndex`: the index in the original command string of the character that
 *   opened the region. For ANSI-C and locale quoting this points at the leading
 *   `$`. For heredocs this points at the first `<`. This position lets a future
 *   caller emit a located error (e.g. "unterminated heredoc near ...") instead
 *   of a generic message.
 */
export interface UnterminatedQuote {
	quoteType: QuoteType
	openIndex: number
	/** Human-readable description suitable for surfacing to an agent as a tool error. */
	message: string
}

/**
 * Build the human-readable error message for an unterminated quote.
 * Includes a short excerpt of the command around the opening delimiter
 * so the agent has enough context to locate and fix the problem.
 */
function unterminatedQuoteMessage(quoteType: QuoteType, openIndex: number, command: string): string {
	const labels: Record<QuoteType, string> = {
		"posix-single": "single quote (')",
		"ansi-c": "ANSI-C quote ($')",
		double: 'double quote (")',
		locale: 'locale quote ($")',
		heredoc: "heredoc (<<)",
	}
	const snippetStart = Math.max(0, openIndex - 10)
	const snippetEnd = Math.min(command.length, openIndex + 20)
	const prefix = snippetStart > 0 ? "..." : ""
	const suffix = snippetEnd < command.length ? "..." : ""
	const excerpt = prefix + command.slice(snippetStart, snippetEnd).replace(/\r?\n/g, "\\n") + suffix
	return `Malformed command: unterminated ${labels[quoteType]} at position ${openIndex} -- near: \`${excerpt}\`. `
}

/**
 * Scan a command string left-to-right with a small state machine and report the
 * first quoted region that is never closed, or `null` when every quoted region
 * is properly terminated.
 *
 * A regex cannot reliably answer "is this command well-quoted?" because quoting
 * is context-sensitive: a backslash escapes the next character outside single
 * quotes, `#` may begin a comment that should be ignored, and an apostrophe
 * inside double quotes (or vice versa) is literal text rather than a delimiter.
 * This walk mirrors how a POSIX shell tokenizes quoting so that legitimate
 * multi-line quoted arguments are accepted while genuinely unterminated quotes
 * (a shell syntax error) are detected.
 *
 * Rules implemented:
 * - Outside any quote, a backslash escapes the following character, so `\'` and
 *   `\"` are literal and do not open a region.
 * - Outside any quote, `#` begins a comment when it is at the start of the input
 *   or preceded by whitespace; the remainder of that line is ignored. A `#` that
 *   is attached to a word (e.g. `foo#bar`) is an ordinary character.
 * - Single quotes are opaque: no escapes apply, and the region ends only at the
 *   next `'`.
 * - Double quotes honor backslash escapes, so `\"` does not close the region.
 * - ANSI-C quoting ($'...') behaves like a single-quoted region for delimiter
 *   purposes but honors backslash escapes, so `\'` does not close it.
 * - Locale quoting ($"...") behaves like double quotes but is opened by `$"` so
 *   the leading `$` is part of the token (same pattern as ANSI-C).
 * - Heredoc (`<<WORD`, `<<'WORD'`, `<<"WORD"`, `<<\WORD`, `<<-WORD`) is a
 *   multi-line quoted region. The body extends from the character after the
 *   opener line's newline through the line that is exactly the terminator word
 *   (after stripping leading tabs for `<<-`). If no terminator line is found the
 *   heredoc is unterminated.
 */
export function findUnterminatedQuote(command: string): UnterminatedQuote | null {
	return scanTopLevelQuotes(command).unterminatedQuote
}

/**
 * Describes a contiguous quoted region found at the top level of a command
 * string (outside any other quoted region and outside `#` comments).
 */
interface QuoteSpan {
	/** Index of the first character of the opening delimiter (e.g. `$` for `$'...'`). */
	start: number
	/** Index one past the last character of the closing delimiter. */
	end: number
	/** The style of quoting. */
	quoteType: QuoteType
}

/**
 * Result returned by the single shared state-machine walk.
 *
 * `spans` contains every well-formed top-level quoted region found.
 * `unterminatedQuote` is non-null when the walk ended inside an open region.
 */
interface ScanResult {
	spans: QuoteSpan[]
	unterminatedQuote: UnterminatedQuote | null
}

/**
 * Parse a heredoc delimiter word starting at position `start` in `command`.
 * The delimiter may be:
 * - Unquoted:        `EOF`     -- bare identifier characters
 * - Single-quoted:   `'EOF'`   -- literal body, strip outer quotes
 * - Double-quoted:   `"EOF"`   -- expandable body, strip outer quotes
 * - Backslash-escaped: `\EOF`  -- literal body, strip leading backslash
 *
 * Returns the bare delimiter word (for terminator line matching) and the index
 * of the first character after the delimiter token.
 */
function parseHeredocDelimiter(command: string, start: number): { delimiter: string; endIndex: number } {
	let i = start
	let delimiter = ""

	if (command[i] === "'") {
		i++ // skip opening '
		while (i < command.length && command[i] !== "'" && command[i] !== "\n") {
			delimiter += command[i++]
		}
		if (command[i] === "'") i++ // consume closing '
	} else if (command[i] === '"') {
		i++ // skip opening "
		while (i < command.length && command[i] !== '"' && command[i] !== "\n") {
			delimiter += command[i++]
		}
		if (command[i] === '"') i++ // consume closing "
	} else if (command[i] === "\\") {
		i++ // skip backslash
		while (i < command.length && command[i] !== "\n" && command[i] !== " " && command[i] !== "\t") {
			delimiter += command[i++]
		}
	} else {
		while (i < command.length && command[i] !== "\n" && command[i] !== " " && command[i] !== "\t") {
			delimiter += command[i++]
		}
	}

	return { delimiter, endIndex: i }
}

/**
 * Single shared state-machine walk used by both `findUnterminatedQuote` and
 * `maskTopLevelQuotes`. Walks `command` left-to-right, identifies every
 * top-level quoted region (outside any other quote and outside `#` comments),
 * and returns the list of spans together with an unterminated-quote descriptor
 * if the walk ends inside an open region.
 *
 * Rules (match POSIX shell tokenization):
 * - Outside any quote, `\X` escapes the next character so a quote after `\`
 *   is literal and does not open a region.
 * - `#` that follows whitespace (or is at position 0) starts a comment to end
 *   of line; quotes inside a comment are ignored.
 * - `<<<` is a herestring (single-line redirect), not a heredoc -- skip it.
 * - `<<` opens a heredoc whose body runs through the terminator line.
 * - `$'...'` is ANSI-C quoting (escape-aware single quote).
 * - `$"..."` is locale quoting (escape-aware double quote with `$` prefix).
 * - `'...'` is POSIX single quoting (fully opaque, no escapes).
 * - `"..."` is double quoting (escape-aware).
 *
 * Supported quote styles reported in spans/unterminatedQuote:
 * - `ansi-c`       $'...'
 * - `locale`       $"..."
 * - `posix-single` '...'
 * - `double`       "..."
 * - `heredoc`      <<WORD...WORD
 */
function scanTopLevelQuotes(command: string): ScanResult {
	const spans: QuoteSpan[] = []
	let i = 0

	while (i < command.length) {
		const char = command[i]

		// Outside any quoted region: handle backslash, comments, and quote openers.
		if (char === "\\") {
			// Backslash escapes the next character; a quote after it is literal.
			i += 2
			continue
		}

		if (char === "#" && (i === 0 || /\s/.test(command[i - 1]))) {
			// Comment: skip to end of line. Quotes inside are not shell quoting.
			while (i < command.length && command[i] !== "\n" && command[i] !== "\r") {
				i++
			}
			continue
		}

		// Herestring (<<<): single-line stdin redirect -- no body or terminator.
		if (char === "<" && command[i + 1] === "<" && command[i + 2] === "<") {
			i += 3
			continue
		}

		// Heredoc opener: <<[-]? followed by an optional-quoted delimiter word.
		if (char === "<" && command[i + 1] === "<") {
			const start = i
			i += 2 // skip <<
			const stripTabs = command[i] === "-"
			if (stripTabs) i++
			// Skip horizontal whitespace between << and the delimiter word.
			while (i < command.length && (command[i] === " " || command[i] === "\t")) {
				i++
			}
			const { delimiter, endIndex } = parseHeredocDelimiter(command, i)
			i = endIndex
			// Advance past the remainder of the opener line.
			while (i < command.length && command[i] !== "\n") i++
			if (i < command.length) i++ // consume newline
			if (delimiter.length > 0) {
				let found = false
				while (i < command.length) {
					const lineStart = i
					while (i < command.length && command[i] !== "\n" && command[i] !== "\r") {
						i++
					}
					// Strip leading tabs only for <<- heredocs.
					const rawLine = command.slice(lineStart, i)
					const line = stripTabs ? rawLine.replace(/^\t*/, "") : rawLine
					// Do NOT advance past the terminator's newline -- leave it as a
					// separator for any command that follows the heredoc.
					if (line === delimiter) {
						found = true
						break
					}
					if (i < command.length) i++ // consume newline of a body line
				}
				if (!found) {
					return {
						spans,
						unterminatedQuote: {
							quoteType: "heredoc",
							openIndex: start,
							message: unterminatedQuoteMessage("heredoc", start, command),
						},
					}
				}
			}
			spans.push({ start, end: i, quoteType: "heredoc" })
			continue
		}

		// ANSI-C quoting: $'...', escape-aware.
		if (char === "$" && command[i + 1] === "'") {
			const start = i
			i += 2 // skip $'
			let closed = false
			while (i < command.length) {
				if (command[i] === "\\") {
					i += 2 // skip escaped char
				} else if (command[i] === "'") {
					i++ // consume closing '
					closed = true
					break
				} else {
					i++
				}
			}
			if (!closed) {
				return {
					spans,
					unterminatedQuote: {
						quoteType: "ansi-c",
						openIndex: start,
						message: unterminatedQuoteMessage("ansi-c", start, command),
					},
				}
			}
			spans.push({ start, end: i, quoteType: "ansi-c" })
			continue
		}

		// Locale quoting: $"...", escape-aware like double quotes.
		if (char === "$" && command[i + 1] === '"') {
			const start = i
			i += 2 // skip $"
			let closed = false
			while (i < command.length) {
				if (command[i] === "\\") {
					i += 2 // skip escaped char
				} else if (command[i] === '"') {
					i++ // consume closing "
					closed = true
					break
				} else {
					i++
				}
			}
			if (!closed) {
				return {
					spans,
					unterminatedQuote: {
						quoteType: "locale",
						openIndex: start,
						message: unterminatedQuoteMessage("locale", start, command),
					},
				}
			}
			spans.push({ start, end: i, quoteType: "locale" })
			continue
		}

		// POSIX single quote: fully opaque, ends at the next literal '.
		if (char === "'") {
			const start = i
			i++ // skip opening '
			while (i < command.length && command[i] !== "'") {
				i++
			}
			if (i >= command.length) {
				// No closing quote found.
				return {
					spans,
					unterminatedQuote: {
						quoteType: "posix-single",
						openIndex: start,
						message: unterminatedQuoteMessage("posix-single", start, command),
					},
				}
			}
			i++ // consume closing '
			spans.push({ start, end: i, quoteType: "posix-single" })
			continue
		}

		// Double quote: escape-aware, ends at the next unescaped ".
		if (char === '"') {
			const start = i
			i++ // skip opening "
			let closed = false
			while (i < command.length) {
				if (command[i] === "\\") {
					i += 2 // skip escaped char
				} else if (command[i] === '"') {
					i++ // consume closing "
					closed = true
					break
				} else {
					i++
				}
			}
			if (!closed) {
				return {
					spans,
					unterminatedQuote: {
						quoteType: "double",
						openIndex: start,
						message: unterminatedQuoteMessage("double", start, command),
					},
				}
			}
			spans.push({ start, end: i, quoteType: "double" })
			continue
		}

		// Ordinary character -- advance.
		i++
	}

	return { spans, unterminatedQuote: null }
}

/**
 * Walk `command` and replace every top-level quoted region with a placeholder
 * token. Returns the masked string and the array of original quoted substrings
 * so callers can restore them later.
 *
 * Delegates all state-machine logic to `scanTopLevelQuotes`, ensuring
 * consistent quoting rules with `findUnterminatedQuote`. An unterminated quote
 * is treated as a span that runs to the end of the string so the masked output
 * is always well-formed and the subsequent split never exposes a fragment of
 * a malformed command.
 */
function maskTopLevelQuotes(command: string): { masked: string; quotes: string[] } {
	const { spans, unterminatedQuote } = scanTopLevelQuotes(command)

	// If the command has an unterminated quote, treat the unclosed region as a
	// span running to the end of the string. This is safe because parseCommand
	// already guards against unterminated quotes and returns the raw command as
	// a single token before calling maskTopLevelQuotes -- but the fallback
	// ensures maskTopLevelQuotes is robust even when called directly.
	const effectiveSpans: QuoteSpan[] =
		unterminatedQuote !== null
			? [
					...spans,
					{ start: unterminatedQuote.openIndex, end: command.length, quoteType: unterminatedQuote.quoteType },
				]
			: spans

	const quotes: string[] = []
	let result = ""
	let pos = 0

	for (const span of effectiveSpans) {
		// Copy the unquoted text between the previous span end and this span start.
		result += command.slice(pos, span.start)
		// Replace the quoted span with a placeholder.
		quotes.push(command.slice(span.start, span.end))
		result += `__TOPLEVEL_QUOTE_${quotes.length - 1}__`
		pos = span.end
	}

	// Copy any remaining text after the last span (or the whole string if no spans).
	result += command.slice(pos)

	return { masked: result, quotes }
}

/**
 * Split a command string into individual sub-commands by
 * chaining operators (&&, ||, ;, |, or &) and unquoted newlines.
 *
 * Uses shell-quote to properly handle:
 * - Quoted strings (preserves quotes, including multi-line quoted strings)
 * - Subshell commands ($(cmd), `cmd`, <(cmd), >(cmd))
 * - PowerShell redirections (2>&1)
 * - Chain operators (&&, ||, ;, |, &)
 * - Newlines as command separators (only when outside quoted strings)
 *
 * Key invariant: newlines that appear inside a quoted string (single or double)
 * are part of that string argument and must NOT be treated as command separators.
 * Only unquoted newlines split commands. For example:
 *
 *   sh -c 'python3 -c "
 *   import sys
 *   print(sys.version)
 *   "'
 *
 * ...is a single command, not multiple commands split at each newline.
 *
 * Returns a `ParseResult` containing the list of sub-commands and an optional
 * `parseError` that is non-null when the input contains a shell syntax error
 * (currently: an unterminated quote or heredoc). When `parseError` is set the
 * `commands` array contains the raw input as a single opaque token; callers
 * should surface the error rather than proceeding with auto-approval.
 */
export function parseCommand(command: string): ParseResult {
	if (!command?.trim()) {
		return { commands: [], parseError: null }
	}

	// Run the shared state-machine scan once. It gives us both the list of
	// top-level quoted spans (used by maskTopLevelQuotes) and the parse-error
	// descriptor (used here to detect malformed input) in a single pass.
	const { unterminatedQuote } = scanTopLevelQuotes(command)

	// Reject syntactically malformed input -- an unterminated quote is a shell
	// syntax error. Return the raw input as a single opaque token so callers
	// can surface the error to the agent rather than splitting unsafe fragments
	// that might be auto-approved in isolation.
	if (unterminatedQuote !== null) {
		return { commands: [command], parseError: unterminatedQuote }
	}

	// Pre-escape any literal __ sequences present in the raw command so they
	// cannot collide with the internal placeholder tokens (e.g. __QUOTE_0__)
	// used during masking and splitting. \x00 (the null byte, U+0000) is the
	// sentinel: it encodes end-of-string at the C/OS level, so the OS terminates
	// any command string at the first \x00 -- meaning a real shell command can
	// never contain one. It therefore cannot appear in any command text the
	// parser receives and will never match a placeholder regex. The post-unescape
	// step at the return converts \x00 back to __ in every output command.
	const escapedCommand = command.replace(/__/g, "\x00")

	// Mask quoted strings before splitting on newlines so that newlines embedded
	// inside a quoted argument are not mistaken for command separators. The
	// masker delegates to scanTopLevelQuotes internally, ensuring identical
	// quoting rules with the check above.
	const { masked, quotes: topLevelQuotes } = maskTopLevelQuotes(escapedCommand)

	// Split on unquoted newlines (all line-ending formats).
	const lines = masked.split(/\r\n|\r|\n/)
	const allCommands: string[] = []

	for (const line of lines) {
		if (!line.trim()) {
			continue
		}

		// Restore top-level quote placeholders before per-line parsing so that
		// parseCommandLine sees the original quoted content and can apply its own
		// masking for operator splitting.
		const restoredLine = line.replace(/__TOPLEVEL_QUOTE_(\d+)__/g, (_, i) => topLevelQuotes[parseInt(i)])

		// If the restored line contains embedded newlines it means a top-level
		// quote (e.g. a heredoc) spanned multiple lines. The entire restored
		// string is a single atomic command -- passing it through parseCommandLine
		// would let shell-quote split on the embedded newlines and << operators.
		if (restoredLine.includes("\n")) {
			allCommands.push(restoredLine)
			continue
		}

		const lineCommands = parseCommandLine(restoredLine)
		allCommands.push(...lineCommands)
	}

	// Unescape \x00 back to __ in every output command. This reverses the
	// pre-escape applied above to prevent literal __ tokens in the input from
	// colliding with internal placeholder names. split/join is used instead of
	// a regex literal to avoid triggering the no-control-regex lint rule.
	return { commands: allCommands.map((cmd) => cmd.split("\x00").join("__")), parseError: null }
}

/**
 * Parse a single line of commands.
 */
function parseCommandLine(command: string): string[] {
	if (!command?.trim()) return []

	// Storage for replaced content
	const redirections: string[] = []
	const subshells: string[] = []
	const quotes: string[] = []
	const singleQuotes: string[] = []
	const arithmeticExpressions: string[] = []
	const variables: string[] = []
	const parameterExpansions: string[] = []

	// First handle PowerShell redirections by temporarily replacing them
	let processedCommand = command.replace(/\d*>&\d*/g, (match) => {
		redirections.push(match)
		return `__REDIR_${redirections.length - 1}__`
	})

	// Handle arithmetic expressions: $((...)) pattern
	// Match the entire arithmetic expression including nested parentheses
	processedCommand = processedCommand.replace(/\$\(\([^)]*(?:\)[^)]*)*\)\)/g, (match) => {
		arithmeticExpressions.push(match)
		return `__ARITH_${arithmeticExpressions.length - 1}__`
	})

	// Handle $[...] arithmetic expressions (alternative syntax)
	processedCommand = processedCommand.replace(/\$\[[^\]]*\]/g, (match) => {
		arithmeticExpressions.push(match)
		return `__ARITH_${arithmeticExpressions.length - 1}__`
	})

	// Handle parameter expansions: ${...} patterns (including array indexing)
	// This covers ${var}, ${var:-default}, ${var:+alt}, ${#var}, ${var%pattern}, etc.
	processedCommand = processedCommand.replace(/\$\{[^}]+\}/g, (match) => {
		parameterExpansions.push(match)
		return `__PARAM_${parameterExpansions.length - 1}__`
	})

	// Handle process substitutions: <(...) and >(...)
	processedCommand = processedCommand.replace(/[<>]\(([^)]+)\)/g, (_, inner) => {
		subshells.push(inner.trim())
		return `__SUBSH_${subshells.length - 1}__`
	})

	// Handle locale quoting: $"...". This must run before variable masking for
	// the same reason as ANSI-C: without it the generic double-quote masker would
	// strip the outer quotes leaving a bare $ that the variable regex absorbs,
	// corrupting the placeholder. The whole token (including $") is stored in the
	// double-quote bucket so it is restored verbatim.
	processedCommand = processedCommand.replace(/\$"(?:[^"\\]|\\.)*"/g, (match) => {
		quotes.push(match)
		return `__QUOTE_${quotes.length - 1}__`
	})

	// Handle ANSI-C quoting: $'...'. This must run before variable masking so the
	// leading $ is captured as part of the quoted unit rather than being treated
	// as a variable expansion (which would corrupt a following placeholder).
	// ANSI-C strings interpret backslash escapes, so the pattern is escape-aware.
	// The whole token (including the $ and quotes) is preserved in the single-
	// quote bucket so it is restored verbatim.
	processedCommand = processedCommand.replace(/\$'(?:[^'\\]|\\.)*'/g, (match) => {
		singleQuotes.push(match)
		return `__SQUOTE_${singleQuotes.length - 1}__`
	})

	// Handle simple variable references: $varname pattern
	// This prevents shell-quote from splitting $count into separate tokens
	processedCommand = processedCommand.replace(/\$[a-zA-Z_][a-zA-Z0-9_]*/g, (match) => {
		variables.push(match)
		return `__VAR_${variables.length - 1}__`
	})

	// Handle special bash variables: $?, $!, $#, $$, $@, $*, $-, $0-$9
	processedCommand = processedCommand.replace(/\$[?!#$@*\-0-9]/g, (match) => {
		variables.push(match)
		return `__VAR_${variables.length - 1}__`
	})

	// Then handle subshell commands $() and back-ticks
	processedCommand = processedCommand
		.replace(/\$\((.*?)\)/g, (_, inner) => {
			subshells.push(inner.trim())
			return `__SUBSH_${subshells.length - 1}__`
		})
		.replace(/`(.*?)`/g, (_, inner) => {
			subshells.push(inner.trim())
			return `__SUBSH_${subshells.length - 1}__`
		})

	// Mask quoted strings (single and double) so their contents -- including
	// operators like &&, |, ; and any embedded newlines -- are not treated as
	// command separators. A single left-to-right scan with an alternation is used
	// so that whichever quote opens first wins, preventing a quote of one style
	// inside a string of the other style from starting a spurious match.
	//
	// Single quotes are matched literally (POSIX single quotes are fully opaque,
	// no escaping inside them). Double quotes use an escape-aware pattern so that
	// an escaped quote (\") does not prematurely terminate the match. Negated
	// character classes match newlines, so multi-line quoted strings are captured
	// as a single token.
	processedCommand = processedCommand.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (match) => {
		if (match.startsWith("'")) {
			singleQuotes.push(match)
			return `__SQUOTE_${singleQuotes.length - 1}__`
		}
		quotes.push(match)
		return `__QUOTE_${quotes.length - 1}__`
	})

	let tokens: ShellToken[]
	try {
		tokens = parse(processedCommand) as ShellToken[]
	} catch (error: any) {
		// If shell-quote fails to parse, fall back to simple splitting
		console.warn("shell-quote parse error:", error.message, "for command:", processedCommand)

		// Simple fallback: split by common operators
		const fallbackCommands = processedCommand
			.split(/(?:&&|\|\||;|\||&)/)
			.map((cmd) => cmd.trim())
			.filter((cmd) => cmd.length > 0)

		// Restore all placeholders for each command
		return fallbackCommands.map((cmd) =>
			restorePlaceholders(
				cmd,
				quotes,
				singleQuotes,
				redirections,
				arithmeticExpressions,
				parameterExpansions,
				variables,
				subshells,
			),
		)
	}

	const commands: string[] = []
	let currentCommand: string[] = []

	for (const token of tokens) {
		if (typeof token === "object" && "op" in token) {
			// Chain operator - split command
			if (["&&", "||", ";", "|", "&"].includes(token.op)) {
				if (currentCommand.length > 0) {
					commands.push(currentCommand.join(" "))
					currentCommand = []
				}
			} else {
				// Other operators (>) are part of the command
				currentCommand.push(token.op)
			}
		} else if (typeof token === "string") {
			// Check if it's a subshell placeholder
			const subshellMatch = token.match(/__SUBSH_(\d+)__/)
			if (subshellMatch) {
				if (currentCommand.length > 0) {
					commands.push(currentCommand.join(" "))
					currentCommand = []
				}
				commands.push(subshells[parseInt(subshellMatch[1])])
			} else {
				currentCommand.push(token)
			}
		}
	}

	// Add any remaining command
	if (currentCommand.length > 0) {
		commands.push(currentCommand.join(" "))
	}

	// Restore all placeholders
	return commands.map((cmd) =>
		restorePlaceholders(
			cmd,
			quotes,
			singleQuotes,
			redirections,
			arithmeticExpressions,
			parameterExpansions,
			variables,
			subshells,
		),
	)
}

/**
 * Helper function to restore placeholders in a command string.
 */
function restorePlaceholders(
	command: string,
	quotes: string[],
	singleQuotes: string[],
	redirections: string[],
	arithmeticExpressions: string[],
	parameterExpansions: string[],
	variables: string[],
	subshells: string[],
): string {
	let result = command
	// Restore double-quoted strings
	result = result.replace(/__QUOTE_(\d+)__/g, (_, i) => quotes[parseInt(i)])
	// Restore single-quoted strings
	result = result.replace(/__SQUOTE_(\d+)__/g, (_, i) => singleQuotes[parseInt(i)])
	// Restore redirections
	result = result.replace(/__REDIR_(\d+)__/g, (_, i) => redirections[parseInt(i)])
	// Restore arithmetic expressions
	result = result.replace(/__ARITH_(\d+)__/g, (_, i) => arithmeticExpressions[parseInt(i)])
	// Restore parameter expansions
	result = result.replace(/__PARAM_(\d+)__/g, (_, i) => parameterExpansions[parseInt(i)])
	// Restore variable references
	result = result.replace(/__VAR_(\d+)__/g, (_, i) => variables[parseInt(i)])
	result = result.replace(/__SUBSH_(\d+)__/g, (_, i) => subshells[parseInt(i)])
	return result
}
