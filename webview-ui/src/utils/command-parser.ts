import { parse } from "shell-quote"
import { parseCommand } from "@roo/parse-command"

/**
 * Extract command patterns from a command string.
 * Returns at most 3 levels: base command, command + first argument, and command + first two arguments.
 * Stops at flags (-), paths (/\~), file extensions (.ext), or special characters (:).
 *
 * Uses parseCommand (heredoc- and unterminated-quote-aware) to split the input
 * into safe sub-commands before tokenizing with shell-quote, so that heredoc
 * bodies and multi-line opaque tokens are never fed raw to shell-quote.
 */
export function extractPatternsFromCommand(command: string): string[] {
	if (!command?.trim()) return []

	const patterns = new Set<string>()

	// Split into sub-commands using the heredoc- and quote-aware parser so that
	// constructs like heredocs or unterminated quotes are not broken up by
	// shell-quote's operator splitting.
	const { commands: subCommands } = parseCommand(command)

	for (const subCmd of subCommands) {
		extractPatternsFromSingleCommand(subCmd, patterns)
	}

	return Array.from(patterns).sort()
}

/**
 * Extract patterns from a single sub-command (no chaining operators) using
 * shell-quote for word tokenization. Called only after parseCommand has already
 * ensured the input is a safe, single-line sub-command.
 */
function extractPatternsFromSingleCommand(command: string, patterns: Set<string>): void {
	if (!command?.trim()) return

	// A sub-command that still contains a newline is a multi-line opaque token
	// (heredoc body, unterminated quote). shell-quote cannot safely tokenize it,
	// so extract only the leading word and stop.
	if (command.includes("\n")) {
		const firstWord = command.trim().split(/\s+/)[0]
		if (firstWord && !/^\d+$/.test(firstWord)) patterns.add(firstWord)
		return
	}

	try {
		const parsed = parse(command)
		const tokens = parsed.filter((t): t is string => typeof t === "string")
		extractFromTokens(tokens, patterns)
	} catch (error) {
		console.warn("Failed to parse command:", error)
		// Fallback: just extract the first word
		const firstWord = command.trim().split(/\s+/)[0]
		if (firstWord) patterns.add(firstWord)
	}
}

function extractFromTokens(tokens: string[], patterns: Set<string>): void {
	if (tokens.length === 0 || typeof tokens[0] !== "string") return

	const mainCmd = tokens[0]

	// Skip numeric commands like "0" from "0 total"
	if (/^\d+$/.test(mainCmd)) return

	patterns.add(mainCmd)

	// Breaking expressions that indicate we should stop looking for subcommands
	const breakingExps = [/^-/, /[\\/:.~ ]/]

	// Extract up to 3 levels maximum
	const maxLevels = Math.min(tokens.length, 3)

	for (let i = 1; i < maxLevels; i++) {
		const arg = tokens[i]

		if (typeof arg !== "string" || breakingExps.some((re) => re.test(arg))) break

		const pattern = tokens.slice(0, i + 1).join(" ")
		patterns.add(pattern.trim())
	}
}
