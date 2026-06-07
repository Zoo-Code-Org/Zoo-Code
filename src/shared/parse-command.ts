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
 let inSingle = false
 let inDouble = false
 // Tracks whether the current single-quoted region was opened as ANSI-C
 // ($'...'), which -- unlike a POSIX single quote -- honors backslash escapes.
 let singleIsAnsiC = false
 // Index of the character that opened the currently active quoted region.
 let openIndex = -1

 for (let i = 0; i < command.length; i++) {
 	const char = command[i]

 	if (inSingle) {
 		if (singleIsAnsiC && char === "\\") {
 			// Skip the escaped character inside an ANSI-C string.
 			i++
 			continue
 		}
 		if (char === "'") {
 			inSingle = false
 			singleIsAnsiC = false
 		}
 		continue
 	}

 	if (inDouble) {
 		if (char === "\\") {
 			// Skip the escaped character inside a double-quoted string.
 			i++
 			continue
 		}
 		if (char === '"') {
 			inDouble = false
 		}
 		continue
 	}

 	// Outside any quoted region.
 	if (char === "\\") {
 		// A backslash escapes the next character, so a following quote is
 		// literal and must not open a region.
 		i++
 		continue
 	}

 	if (char === "#" && (i === 0 || /\s/.test(command[i - 1]))) {
 		// Start of a comment: skip to the end of the current line.
 		while (i < command.length && command[i] !== "\n" && command[i] !== "\r") {
 			i++
 		}
 		continue
 	}

 	// Herestring (<<<): single-line stdin redirect -- no body or terminator.
 	// Consume all three '<' and continue so the second '<' does not re-trigger
 	// the heredoc branch on the next iteration.
 	if (char === "<" && command[i + 1] === "<" && command[i + 2] === "<") {
 		i += 3
 		continue
 	}

 	// Heredoc opener: <<[-]? followed by an optional-quoted word. The body
 	// through the terminator line is treated as a single quoted region.
 	if (char === "<" && command[i + 1] === "<") {
 		const heredocOpenIndex = i
 		i += 2 // skip <<
 		if (command[i] === "-") i++ // optional - for <<-
 		// Skip horizontal whitespace between << and the delimiter word.
 		while (i < command.length && (command[i] === " " || command[i] === "\t")) {
 			i++
 		}
 		// Parse the delimiter word; quoting style determines expansion behavior
 		// inside the body but the terminator match is always the bare word.
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
 				// Strip leading tabs for <<- heredocs (terminator may be indented).
 				const line = command.slice(lineStart, i).replace(/^\t*/, "")
 				if (i < command.length) i++ // consume newline
 				if (line === delimiter) {
 					found = true
 					break
 				}
 			}
 			if (!found) {
 				return { quoteType: "heredoc", openIndex: heredocOpenIndex }
 			}
 		}
 		continue
 	}

 	if (char === "$" && command[i + 1] === "'") {
 		// ANSI-C quoting opens an escape-aware single-quoted region. The
 		// opener position points at the leading $ so callers can show $'.
 		inSingle = true
 		singleIsAnsiC = true
 		openIndex = i
 		i++
 		continue
 	}

 	if (char === "$" && command[i + 1] === '"') {
 		// Locale quoting: $"..." behaves like double quotes but the $ prefix
 		// is part of the token. Set inDouble and advance i by 1 (past $); the
 		// for-loop increment then moves past the opening " so the inDouble branch
 		// handles content from the character after ". Mirrors the ANSI-C pattern.
 		inDouble = true
 		openIndex = i
 		i++ // skip $; loop increment skips the opening "
 		continue
 	}

 	if (char === "'") {
 		inSingle = true
 		singleIsAnsiC = false
 		openIndex = i
 		continue
 	}

 	if (char === '"') {
 		inDouble = true
 		openIndex = i
 		continue
 	}
 }

 if (inSingle) {
 	return { quoteType: singleIsAnsiC ? "ansi-c" : "posix-single", openIndex }
 }
 if (inDouble) {
 	return { quoteType: "double", openIndex }
 }
 return null
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
 * Walk `command` left-to-right with the same state-machine rules used by
 * `findUnterminatedQuote` and replace every top-level quoted region with a
 * placeholder token. Returns the masked string and the array of original
 * quoted substrings so callers can restore them later.
 *
 * "Top-level" means outside any other quoted region and outside a `#` comment.
 * A `#` that follows whitespace (or is at position 0) starts a comment that
 * runs to the end of the current line; any quote characters inside that comment
 * are ignored and must not be masked, because they are not shell quoting.
 *
 * Supported quote styles:
 * - ANSI-C quoting  $'...'         -- escape-aware, matched before plain single quotes
 * - Locale quoting  $"..."         -- escape-aware, matched before plain double quotes
 * - POSIX single    '...'          -- fully opaque, no escapes
 * - Double          "..."          -- escape-aware (\X skips one char)
 * - Heredoc         <<WORD...WORD  -- body through terminator treated as one token
 */
function maskTopLevelQuotes(command: string): { masked: string; quotes: string[] } {
	const quotes: string[] = []
	let result = ""
	let i = 0

	while (i < command.length) {
		const char = command[i]

		// Outside any quoted region: handle backslash, comments, and quote openers.
		if (char === "\\") {
			// Backslash escapes the next character -- copy both and skip.
			result += command.slice(i, i + 2)
			i += 2
			continue
		}

		if (char === "#" && (i === 0 || /\s/.test(command[i - 1]))) {
			// Start of a comment: copy everything up to (but not including) the
			// next newline verbatim. Quotes inside comments are not shell quoting.
			const commentStart = i
			while (i < command.length && command[i] !== "\n" && command[i] !== "\r") {
				i++
			}
			result += command.slice(commentStart, i)
			continue
		}

		// Herestring (<<<): feed a single word as stdin. Not a heredoc -- has no
		// body region or terminator. Emit all three '<' verbatim and advance past
		// them so the second '<' does not re-trigger the heredoc branch below.
		if (char === "<" && command[i + 1] === "<" && command[i + 2] === "<") {
			result += "<<<"
			i += 3
			continue
		}

		// Heredoc opener: <<[-]? followed by an optional-quoted delimiter word.
		// The entire span from the opener through the terminator line is masked as
		// one token so that embedded newlines in the body are invisible to the
		// line splitter.
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
			// Scan body lines for the exact terminator. The match ends at the end of
			// the terminator line (including the terminator word but NOT its trailing
			// newline), so the newline remains in `masked` as a line separator for any
			// commands that follow the heredoc.
			if (delimiter.length > 0) {
				while (i < command.length) {
					const lineStart = i
					while (i < command.length && command[i] !== "\n" && command[i] !== "\r") {
						i++
					}
					const rawLine = command.slice(lineStart, i)
					const line = stripTabs ? rawLine.replace(/^\t*/, "") : rawLine
					// `i` now points at the newline (or end-of-string) after the line.
					// Do NOT advance past it here -- consume it only for non-terminator
					// lines so the terminator's newline stays available as a separator.
					if (line === delimiter) break
					if (i < command.length) i++ // consume newline of a body line
				}
			}
			const match = command.slice(start, i)
			quotes.push(match)
			result += `__TOPLEVEL_QUOTE_${quotes.length - 1}__`
			continue
		}

		if (char === "$" && command[i + 1] === "'") {
			// ANSI-C quoting: $'...', escape-aware. Scan for the closing '.
			const start = i
			i += 2 // skip $'
			while (i < command.length) {
				if (command[i] === "\\") {
					i += 2 // skip escaped char
				} else if (command[i] === "'") {
					i++ // consume closing '
					break
				} else {
					i++
				}
			}
			const match = command.slice(start, i)
			quotes.push(match)
			result += `__TOPLEVEL_QUOTE_${quotes.length - 1}__`
			continue
		}

		if (char === "$" && command[i + 1] === '"') {
			// Locale quoting: $"...", escape-aware like double quotes but the $
			// prefix is part of the token. Scan for the closing unescaped ".
			const start = i
			i += 2 // skip $"
			while (i < command.length) {
				if (command[i] === "\\") {
					i += 2 // skip escaped char
				} else if (command[i] === '"') {
					i++ // consume closing "
					break
				} else {
					i++
				}
			}
			const match = command.slice(start, i)
			quotes.push(match)
			result += `__TOPLEVEL_QUOTE_${quotes.length - 1}__`
			continue
		}

		if (char === "'") {
			// POSIX single quote: fully opaque, ends at the next literal '.
			const start = i
			i++ // skip opening '
			while (i < command.length && command[i] !== "'") {
				i++
			}
			if (i < command.length) {
				i++ // consume closing '
			}
			const match = command.slice(start, i)
			quotes.push(match)
			result += `__TOPLEVEL_QUOTE_${quotes.length - 1}__`
			continue
		}

		if (char === '"') {
			// Double quote: escape-aware, ends at the next unescaped ".
			const start = i
			i++ // skip opening "
			while (i < command.length) {
				if (command[i] === "\\") {
					i += 2 // skip escaped char
				} else if (command[i] === '"') {
					i++ // consume closing "
					break
				} else {
					i++
				}
			}
			const match = command.slice(start, i)
			quotes.push(match)
			result += `__TOPLEVEL_QUOTE_${quotes.length - 1}__`
			continue
		}

		// Ordinary character -- copy as-is.
		result += char
		i++
	}

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
 */
export function parseCommand(command: string): string[] {
	if (!command?.trim()) {
		return []
	}

	// Reject syntactically malformed input with an unterminated quote. Splitting
	// such a command on newlines is unsafe: a line intended to live inside the
	// unclosed quoted region would surface as an independent sub-command and
	// could be auto-approved in isolation (e.g. `sh -c 'echo a\necho b` would
	// otherwise yield a standalone `echo b`). Returning the whole raw input as
	// a single opaque token forces every auto-approval check to match the entire
	// string, which is effectively never on an allowlist, so the user is
	// prompted. LLM-generated commands with nested quotes hit this case often
	// enough to warrant explicit handling rather than best-effort splitting.
	if (findUnterminatedQuote(command) !== null) {
		return [command]
	}

	// Mask quoted strings before splitting on newlines so that newlines embedded
	// inside a quoted argument are not mistaken for command separators. The
	// masker uses the same state-machine rules as findUnterminatedQuote, which
	// means it correctly ignores quote characters that appear inside # comments
	// and therefore cannot confuse a comment-embedded quote with a real closing
	// delimiter on a subsequent line.
	const { masked, quotes: topLevelQuotes } = maskTopLevelQuotes(command)

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

	return allCommands
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
	const arrayIndexing: string[] = []
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
				arrayIndexing,
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
			arrayIndexing,
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
	arrayIndexing: string[],
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
	// Restore array indexing expressions
	result = result.replace(/__ARRAY_(\d+)__/g, (_, i) => arrayIndexing[parseInt(i)])
	// Restore arithmetic expressions
	result = result.replace(/__ARITH_(\d+)__/g, (_, i) => arithmeticExpressions[parseInt(i)])
	// Restore parameter expansions
	result = result.replace(/__PARAM_(\d+)__/g, (_, i) => parameterExpansions[parseInt(i)])
	// Restore variable references
	result = result.replace(/__VAR_(\d+)__/g, (_, i) => variables[parseInt(i)])
	result = result.replace(/__SUBSH_(\d+)__/g, (_, i) => subshells[parseInt(i)])
	return result
}
