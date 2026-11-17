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
 * Regex matching critical error markers in terminal logs to ensure middle stack traces
 * are pinned during sliding-window truncation.
 */
const DIAGNOSTIC_PATTERN = /(?:error(?:\[E\d+\])?|fail(?:ed|ure)?|exception|traceback|syntaxerror|panicked at|fatal)/i

/**
 * Truncates terminal output to a maximum number of lines, preserving head and tail lines
 * to conserve LLM context window while retaining critical error diagnostics.
 * If error/panic diagnostics occur in the omitted middle slice, pins that diagnostic block.
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

	// Solution 3: Diagnostic-Aware Scan - check if middle omitted slice holds critical compiler/test errors
	const middleLines = lines.slice(headCount, lines.length - tailCount)
	const relErrorIdx = middleLines.findIndex((line) => DIAGNOSTIC_PATTERN.test(line))

	if (relErrorIdx !== -1 && maxLines >= 30) {
		const errorIdx = headCount + relErrorIdx
		const headBudget = Math.max(10, Math.floor(maxLines * 0.25))
		const tailBudget = Math.max(10, Math.floor(maxLines * 0.25))
		const errorBudget = maxLines - headBudget - tailBudget

		const halfErrorBudget = Math.floor(errorBudget / 2)
		let errorStart = Math.max(headBudget, errorIdx - halfErrorBudget)
		let errorEnd = Math.min(lines.length - tailBudget, errorStart + errorBudget)
		if (errorEnd - errorStart < errorBudget) {
			errorStart = Math.max(headBudget, errorEnd - errorBudget)
		}

		const head = lines.slice(0, headBudget).join("\n")
		const errorBlock = lines.slice(errorStart, errorEnd).join("\n")
		const tail = lines.slice(-tailBudget).join("\n")

		const gap1 = errorStart - headBudget
		const gap2 = lines.length - tailBudget - errorEnd

		return `${head}\n\n[...${gap1} lines omitted...]\n[=== DIAGNOSTIC / ERROR CAPTURE: around line ${errorStart + 1} ===]\n${errorBlock}\n\n[...${gap2} lines omitted...]\n${tail}`
	}

	const head = lines.slice(0, headCount).join("\n")
	const tail = lines.slice(-tailCount).join("\n")

	return `${head}\n\n[...${omitted} intermediate lines omitted for context conservation...]\n\n${tail}`
}

/** Threshold below which files are returned in full without multi-turn pagination penalties (Solution 1) */
export const ADAPTIVE_FULL_READ_THRESHOLD = 300

/** Default maximum lines returned for file reads when sliding window truncation engages */
export const SLIDING_WINDOW_PREVIEW_LIMIT = 200

/** Default alias for backward compatibility */
export const MAX_FILE_READ_LINES = SLIDING_WINDOW_PREVIEW_LIMIT

export interface FileTruncationResult {
	content: string
	wasTruncated: boolean
	returnedLines: number
	omittedLines: number
}

/**
 * Polyglot pattern matching structural declarations (functions, classes, interfaces, methods, etc.)
 */
const DECLARATION_PATTERN =
	/^\s*(?:\d+\s*\|\s*)?(?:(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|struct|impl|trait|fn|def|func|pub\s+(?:fn|struct|enum))\b|(?:(?:public|private|protected|static|readonly|async|override)\s+)+[a-zA-Z0-9_$]+\s*\([^)]*\)|(?:export\s+)?const\s+[a-zA-Z0-9_$]+\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>)/

export interface SkeletonSymbol {
	lineNumber: number
	signature: string
}

/**
 * Solution 2: Semantic Skeleton Folding.
 * Extracts a lightweight structural symbol skeleton from lines of code.
 * Enables the LLM to understand what functions/classes exist in an omitted middle block
 * without paying the token cost of their full implementation bodies.
 */
export function extractSemanticSkeleton(
	lines: string[],
	startLineNumber: number = 1,
	maxSymbols: number = 15,
): { symbols: SkeletonSymbol[]; formattedSkeleton: string | null } {
	const symbols: SkeletonSymbol[] = []

	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i]
		if (!rawLine || rawLine.trim() === "") continue

		if (DECLARATION_PATTERN.test(rawLine)) {
			// Extract line number (from prefix "123 | ..." or computed startLineNumber + i)
			const linePrefixMatch = rawLine.match(/^\s*(\d+)\s*\|\s*(.*)$/)
			const lineNum = linePrefixMatch ? parseInt(linePrefixMatch[1], 10) : startLineNumber + i
			const codePart = linePrefixMatch ? linePrefixMatch[2] : rawLine

			// Clean signature: trim leading whitespace, trailing block openers/colons/braces
			const cleaned = codePart
				.trim()
				.replace(/[\s{;:]+$/, "")
				.trim()

			if (cleaned.length > 0) {
				symbols.push({ lineNumber: lineNum, signature: cleaned })
			}
		}
	}

	if (symbols.length === 0) {
		return { symbols: [], formattedSkeleton: null }
	}

	const displaySymbols = symbols.slice(0, maxSymbols)
	const items = displaySymbols.map((s) => `  • Line ${s.lineNumber}: ${s.signature}`).join("\n")

	let overflowNote = ""
	if (symbols.length > maxSymbols) {
		overflowNote = `\n  ... and ${symbols.length - maxSymbols} more declarations in omitted block ...`
	}

	const formattedSkeleton = `[...SKIPPED ${lines.length} LINES: Middle Symbol Skeleton...]\n${items}${overflowNote}\n[To inspect any implementation, call read_file with offset=<line> and limit=40]`

	return { symbols, formattedSkeleton }
}

/**
 * Truncates file content to a maximum number of lines using a sliding window (head + tail),
 * preventing token blowup while giving the LLM immediate visibility into both the start
 * (imports, types, headers) and end (exports, bottom definitions) of a file.
 * Integrates Solution 2 (Semantic Skeleton Folding) to eliminate middle-blindness.
 */
export function truncateFileOutput(
	content: string,
	maxLines: number = SLIDING_WINDOW_PREVIEW_LIMIT,
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

	// Solution 2: Semantic Skeleton Folding for middle omitted block
	const middleLines = lines.slice(headCount, lines.length - tailCount)
	const { formattedSkeleton } = extractSemanticSkeleton(middleLines, headCount + 1)

	const omittedBlock =
		formattedSkeleton ??
		`[...TRUNCATED ${omitted} LINES: Showing first ${headCount} and last ${tailCount} lines of ${total} total lines. To view intermediate code, call read_file with offset and limit...]`

	const truncatedContent = `${head}\n\n${omittedBlock}\n\n${tail}`

	return {
		content: truncatedContent,
		wasTruncated: true,
		returnedLines: maxLines,
		omittedLines: omitted,
	}
}

