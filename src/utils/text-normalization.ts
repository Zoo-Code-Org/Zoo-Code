/**
 * Common character mappings for normalization
 */
export const NORMALIZATION_MAPS = {
	// Smart quotes to regular quotes
	SMART_QUOTES: {
		"\u201C": '"', // Left double quote (U+201C)
		"\u201D": '"', // Right double quote (U+201D)
		"\u2018": "'", // Left single quote (U+2018)
		"\u2019": "'", // Right single quote (U+2019)
	},
	// Other typographic characters
	TYPOGRAPHIC: {
		"\u2026": "...", // Ellipsis
		"\u2014": "-", // Em dash
		"\u2013": "-", // En dash
		"\u00A0": " ", // Non-breaking space
	},
}

/**
 * Options for string normalization
 */
export interface NormalizeOptions {
	smartQuotes?: boolean // Replace smart quotes with straight quotes
	typographicChars?: boolean // Replace typographic characters
	extraWhitespace?: boolean // Collapse multiple whitespace to single space
	trim?: boolean // Trim whitespace from start and end
}

/**
 * Default options for normalization
 */
const DEFAULT_OPTIONS: NormalizeOptions = {
	smartQuotes: true,
	typographicChars: true,
	extraWhitespace: true,
	trim: true,
}

/**
 * Normalizes a string based on the specified options
 *
 * @param str The string to normalize
 * @param options Normalization options
 * @returns The normalized string
 */
export function normalizeString(str: string, options: NormalizeOptions = DEFAULT_OPTIONS): string {
	const opts = { ...DEFAULT_OPTIONS, ...options }
	let normalized = str

	// Replace smart quotes
	if (opts.smartQuotes) {
		for (const [smart, regular] of Object.entries(NORMALIZATION_MAPS.SMART_QUOTES)) {
			normalized = normalized.replace(new RegExp(smart, "g"), regular)
		}
	}

	// Replace typographic characters
	if (opts.typographicChars) {
		for (const [typographic, regular] of Object.entries(NORMALIZATION_MAPS.TYPOGRAPHIC)) {
			normalized = normalized.replace(new RegExp(typographic, "g"), regular)
		}
	}

	// Normalize whitespace
	if (opts.extraWhitespace) {
		normalized = normalized.replace(/\s+/g, " ")
	}

	// Trim whitespace
	if (opts.trim) {
		normalized = normalized.trim()
	}

	return normalized
}

/**
 * Unescapes common HTML entities in a string
 *
 * @param text The string containing HTML entities to unescape
 * @returns The unescaped string with HTML entities converted to their literal characters
 */
export function unescapeHtmlEntities(text?: string | null): string {
	if (text === undefined) return undefined as unknown as string
	if (!text) return ""

	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&#91;/g, "[")
		.replace(/&#93;/g, "]")
		.replace(/&lsqb;/g, "[")
		.replace(/&rsqb;/g, "]")
		.replace(/&amp;/g, "&")
}

/**
 * Strips ANSI escape codes from terminal output to eliminate useless tokens.
 */
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g

export function stripAnsi(text: string): string {
	if (!text) return text
	return text.replace(ANSI_PATTERN, "")
}

/**
 * Truncates terminal output to a maximum number of lines, preserving head and tail lines
 * to conserve LLM context window while retaining critical error diagnostics.
 * Robust against Windows CRLF (\r\n) line endings.
 */
export function truncateTerminalOutput(text: string, maxLines: number = 100): string {
	if (!text) return text

	const clean = stripAnsi(text)
	const lines = clean.split(/\r?\n/)
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop()
	}

	if (lines.length <= maxLines || maxLines <= 0) {
		return clean
	}

	const headCount = Math.floor(maxLines / 2)
	const tailCount = maxLines - headCount
	const omitted = lines.length - maxLines

	const head = lines.slice(0, headCount).join("\n")
	const tail = lines.slice(-tailCount).join("\n")

	return `${head}\n\n[...${omitted} intermediate lines omitted for context conservation...]\n\n${tail}`
}

/** Default maximum lines returned for file reads before sliding window truncation engages */
export const MAX_FILE_READ_LINES = 100

export interface FileTruncationResult {
	content: string
	wasTruncated: boolean
	returnedLines: number
	omittedLines: number
}

/**
 * Truncates file content to a maximum number of lines using a sliding window (head + tail),
 * preventing token blowup while giving the LLM immediate visibility into both the start
 * (imports, types, headers) and end (exports, bottom definitions) of a file.
 */
export function truncateFileOutput(
	content: string,
	maxLines: number = MAX_FILE_READ_LINES,
	totalLines?: number,
): FileTruncationResult {
	if (!content) return { content, wasTruncated: false, returnedLines: 0, omittedLines: 0 }

	const lines = content.split(/\r?\n/)
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop()
	}

	const count = lines.length

	if (count <= maxLines || maxLines <= 0) {
		return { content, wasTruncated: false, returnedLines: count, omittedLines: 0 }
	}

	const headCount = Math.floor(maxLines / 2)
	const tailCount = maxLines - headCount
	const omitted = count - maxLines

	const head = lines.slice(0, headCount).join("\n")
	const tail = lines.slice(-tailCount).join("\n")
	const total = totalLines ?? count

	const truncatedContent = `${head}\n\n[...TRUNCATED ${omitted} LINES: Showing first ${headCount} and last ${tailCount} lines of ${total} total lines. To view intermediate code, call read_file with offset and limit...]\n\n${tail}`

	return {
		content: truncatedContent,
		wasTruncated: true,
		returnedLines: maxLines,
		omittedLines: omitted,
	}
}

