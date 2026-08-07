import * as vscode from "vscode"

/** Windowing caps: keep reads cheap even on huge files (see plan risk #6). */
export const PREFIX_MAX_LINES = 200
/**
 * The after-cursor window is what makes fill-in-the-middle different from plain
 * continuation: editing mid-file, the closing brace and the following definitions
 * are the signal that bounds the completion. A 50-line cap starved exactly that
 * case, so a mid-file edit saw little more than a raw continuation would.
 */
export const SUFFIX_MAX_LINES = 150

export interface WindowedDocument {
	readonly prefix: string
	readonly suffix: string
}

/**
 * Normalises the document's line endings to `\n` so rendered prompts and cached
 * keys are stable across Windows (\r\n) and Unix (\n). Also normalises a lone
 * trailing `\r` (classic Mac) defensively.
 */
export function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

/**
 * Walks backwards from the cursor, collecting up to {@link maxLines} lines or
 * {@link maxChars} characters (whichever binds first), then trims from the head so
 * the tail — the text immediately before the cursor — survives.
 *
 * Surrogate pairs at the trim boundary are kept intact: if the first retained
 * char is a high surrogate, drop it so we don't emit an orphaned lead byte.
 */
export function windowPrefix(
	document: vscode.TextDocument,
	position: vscode.Position,
	maxChars: number,
	maxLines = PREFIX_MAX_LINES,
): string {
	const startLine = Math.max(0, position.line - (maxLines - 1))
	const range = new vscode.Range(new vscode.Position(startLine, 0), position)
	const raw = normalizeLineEndings(document.getText(range))

	if (raw.length <= maxChars) {
		return raw
	}

	let trimmed = raw.slice(raw.length - maxChars)

	// Keep surrogate pairs intact: a high surrogate at the head means its pair was sliced off.
	const firstCode = trimmed.charCodeAt(0)
	if (firstCode >= 0xd800 && firstCode <= 0xdbff) {
		trimmed = trimmed.slice(1)
	}

	// Don't start mid-token after a slice: drop a leading fragment that isn't preceded by whitespace.
	const firstNewline = trimmed.indexOf("\n")
	if (firstNewline > 0 && firstNewline < 80) {
		trimmed = trimmed.slice(firstNewline + 1)
	}

	return trimmed
}

/**
 * Walks forwards from the cursor, mirroring {@link windowPrefix}.
 */
export function windowSuffix(
	document: vscode.TextDocument,
	position: vscode.Position,
	maxChars: number,
	maxLines = SUFFIX_MAX_LINES,
): string {
	const lastLine = document.lineCount - 1
	const endLine = Math.min(lastLine, position.line + maxLines)
	const endCharacter = endLine === lastLine ? document.lineAt(lastLine).text.length : Number.MAX_SAFE_INTEGER
	const range = new vscode.Range(position, new vscode.Position(endLine, endCharacter))
	const raw = normalizeLineEndings(document.getText(range))

	if (raw.length <= maxChars) {
		return raw
	}

	let trimmed = raw.slice(0, maxChars)

	// Keep surrogate pairs intact: a low surrogate at the tail means its pair was sliced off.
	const lastCode = trimmed.charCodeAt(trimmed.length - 1)
	if (lastCode >= 0xdc00 && lastCode <= 0xdfff) {
		trimmed = trimmed.slice(0, -1)
	}

	// Don't end mid-token: drop a trailing fragment that isn't followed by whitespace.
	const lastNewline = trimmed.lastIndexOf("\n")
	if (lastNewline >= 0 && trimmed.length - lastNewline < 80) {
		trimmed = trimmed.slice(0, lastNewline + 1)
	}

	return trimmed
}

/**
 * Convenience: windows both sides in one call.
 */
export function windowDocument(
	document: vscode.TextDocument,
	position: vscode.Position,
	maxPrefixChars: number,
	maxSuffixChars: number,
): WindowedDocument {
	return {
		prefix: windowPrefix(document, position, maxPrefixChars),
		suffix: windowSuffix(document, position, maxSuffixChars),
	}
}
