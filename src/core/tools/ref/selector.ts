/**
 * Content Reference Tool — Selector Engine
 *
 * Core matching engine that locates content fragments within a source string
 * using anchors (startAnchor/endAnchor), selectors, or line ranges.
 *
 * Matching cascade (resolveSelector):
 *   Stage 1: exact     → source.indexOf(quote)
 *   Stage 2: normalized → whitespace + punctuation normalization, then indexOf
 *   Stage 3: fuzzy     → LCS (Longest Common Substring) with tolerance
 *   Stage 4: word-boundary expansion → expand result to complete words
 */

import type { ContentRef } from "../../../shared/tools"

// ─── Public Types ───────────────────────────────────────────────────────────

export interface SelectorResult {
	sourceId: string
	content: string
	startOffset: number
	endOffset: number
	line?: number
	/** Confidence level: 1.0 (exact) down to 0.5 (fuzzy/expanded) */
	confidence: number
	method: "exact" | "normalized" | "fuzzy" | "anchor"
}

export interface SelectorOptions {
	/**
	 * Allowed character mismatch ratio for fuzzy matching.
	 * Range: 0.05–0.15, default: 0.1 (10%).
	 */
	tolerance?: number
	/** Collapse whitespace sequences before matching (default: true) */
	normalizeWhitespace?: boolean
	/** Normalize punctuation (smart quotes→straight, dashes→hyphen) (default: true) */
	normalizePunctuation?: boolean
	/** Case-sensitive matching (default: false) */
	caseSensitive?: boolean
	/** Expand matched range to word boundaries (default: true) */
	expandToWords?: boolean
}

// ─── Default Options ────────────────────────────────────────────────────────

const DEFAULT_OPTIONS: Required<SelectorOptions> = {
	tolerance: 0.1,
	normalizeWhitespace: true,
	normalizePunctuation: true,
	caseSensitive: false,
	expandToWords: true,
}

function resolveOptions(options?: SelectorOptions): Required<SelectorOptions> {
	return {
		tolerance: options?.tolerance ?? DEFAULT_OPTIONS.tolerance,
		normalizeWhitespace: options?.normalizeWhitespace ?? DEFAULT_OPTIONS.normalizeWhitespace,
		normalizePunctuation: options?.normalizePunctuation ?? DEFAULT_OPTIONS.normalizePunctuation,
		caseSensitive: options?.caseSensitive ?? DEFAULT_OPTIONS.caseSensitive,
		expandToWords: options?.expandToWords ?? DEFAULT_OPTIONS.expandToWords,
	}
}

// ─── Stage 1: Exact Match ───────────────────────────────────────────────────

/**
 * Returns the index of the first exact occurrence of `quote` in `source`,
 * or -1 if not found.
 */
function exactMatch(source: string, quote: string): number {
	return source.indexOf(quote)
}

// ─── Stage 2: Normalized Match ──────────────────────────────────────────────

/**
 * Internal result of text normalization, including a position map
 * to translate normalized positions back to original source positions.
 */
interface NormalizedResult {
	text: string
	/** Maps each character index in `text` to its index in the original string */
	map: number[]
}

/**
 * Normalize punctuation characters:
 * - Smart/curly quotes → straight quotes
 * - Em/en dashes → hyphen
 */
function normalizePunctuationChar(ch: string): string {
	if (/[\u2018\u2019\u201A\u201B]/.test(ch)) return "'"
	if (/[\u201C\u201D\u201E\u201F]/.test(ch)) return '"'
	if (/[\u2013\u2014]/.test(ch)) return "-"
	return ch
}

/**
 * Build a normalized version of the input text along with a position map.
 *
 * Normalization steps:
 * 1. Case folding (unless caseSensitive)
 * 2. Punctuation normalization (smart quotes, dashes)
 * 3. Whitespace collapsing (\s+ → " ")
 *
 * The position map allows translating match positions in normalized text
 * back to original source positions — critical since whitespace collapsing
 * changes character offsets.
 */
function normalizeText(text: string, options: Required<SelectorOptions>): NormalizedResult {
	const map: number[] = []
	let result = ""
	let prevWhitespace = false

	for (let i = 0; i < text.length; i++) {
		let ch = text[i]

		// Step 1: Case folding
		if (!options.caseSensitive) {
			ch = ch.toLowerCase()
		}

		// Step 2: Punctuation normalization
		if (options.normalizePunctuation) {
			ch = normalizePunctuationChar(ch)
		}

		// Step 3: Whitespace collapsing
		if (options.normalizeWhitespace && /\s/.test(ch)) {
			if (!prevWhitespace) {
				result += " "
				map.push(i)
				prevWhitespace = true
			}
			// Skip additional consecutive whitespace characters
		} else {
			result += ch
			map.push(i)
			prevWhitespace = false
		}
	}

	return { text: result, map }
}

/**
 * Find `quote` in `source` after normalizing both strings.
 *
 * Returns the position in the **original** `source` where the match begins,
 * or -1 if not found.
 */
function normalizedMatch(source: string, quote: string, options: Required<SelectorOptions>): number {
	const normSource = normalizeText(source, options)
	const normQuote = normalizeText(quote, options)

	const idx = normSource.text.indexOf(normQuote.text)
	if (idx === -1) {
		return -1
	}

	// Map the normalized index back to the original source position
	return normSource.map[idx]
}

// ─── Stage 3: LCS Fuzzy Match ───────────────────────────────────────────────

/**
 * Find the longest common **substring** (contiguous) between `source` and
 * `quote` using a 1D DP array for memory efficiency.
 *
 * If the longest common substring covers at least `(1 - tolerance)` of the
 * quote length, it is considered a match.
 *
 * Returns the source position where the match begins, or -1 if not found.
 */
function lcsFuzzyMatch(source: string, quote: string, tolerance: number): number {
	const n = source.length
	const m = quote.length
	const minMatchLen = Math.ceil(m * (1 - tolerance))

	// Trivial reject: not enough characters to meet tolerance
	if (minMatchLen <= 0) return 0
	if (minMatchLen > n) return -1

	// 1D DP array — only one row needed for LCS (substring)
	const dp = new Array(m + 1).fill(0)
	let maxLen = 0
	let endPos = 0 // position in source where the longest match ends

	for (let i = 1; i <= n; i++) {
		let prev = 0
		for (let j = 1; j <= m; j++) {
			const temp = dp[j]
			if (source[i - 1] === quote[j - 1]) {
				dp[j] = prev + 1
			} else {
				dp[j] = 0
			}
			if (dp[j] > maxLen) {
				maxLen = dp[j]
				endPos = i - 1 // 0-based end position in source
			}
			prev = temp
		}
	}

	if (maxLen >= minMatchLen) {
		return endPos - maxLen + 1
	}

	return -1
}

/**
 * Find the longest common substring between `source` and `quote` after normalizing both,
 * then map the match position back to the original source.
 */
function normalizedFuzzyMatch(source: string, quote: string, options: Required<SelectorOptions>): number {
	const normSource = normalizeText(source, options)
	const normQuote = normalizeText(quote, options)

	const idx = lcsFuzzyMatch(normSource.text, normQuote.text, options.tolerance)
	if (idx === -1) {
		return -1
	}

	return normSource.map[idx]
}

// ─── Stage 4: Word-Boundary Expansion ───────────────────────────────────────

/**
 * Expand the matched range [start, end) to complete word boundaries.
 *
 * If the first character of the match is mid-word (the preceding character
 * is also a word character), expand left to the start of that word.
 * Similarly, if the last character is mid-word, expand right to the word end.
 */
function expandToWordBoundaries(source: string, start: number, end: number): { start: number; end: number } {
	// Expand left if currently mid-word
	if (start > 0 && start < source.length && /\w/.test(source[start - 1]) && /\w/.test(source[start])) {
		while (start > 0 && /\w/.test(source[start - 1])) {
			start--
		}
	}

	// Expand right if currently mid-word
	if (end > 0 && end < source.length && /\w/.test(source[end - 1]) && /\w/.test(source[end])) {
		while (end < source.length && /\w/.test(source[end])) {
			end++
		}
	}

	return { start, end }
}

// ─── Helper: Line Number Calculation ────────────────────────────────────────

/**
 * Count newlines before `offset` to determine the 1-based line number.
 */
function calculateLine(source: string, offset: number): number {
	let line = 1
	const end = Math.min(offset, source.length)
	for (let i = 0; i < end; i++) {
		if (source[i] === "\n") {
			line++
		}
	}
	return line
}

// ─── Helper: Line Range Resolution ──────────────────────────────────────────

/**
 * Extract content by line numbers (1-based).
 * If `endLine` is omitted, extracts only `startLine`.
 */
function resolveLineRange(sourceId: string, source: string, startLine: number, endLine?: number): SelectorResult {
	const lines = source.split("\n")
	const startIdx = Math.max(0, startLine - 1)
	const endIdx = endLine != null ? Math.min(lines.length, endLine) : startIdx + 1

	if (startIdx >= lines.length) {
		throw new Error(`startLine ${startLine} exceeds source line count ${lines.length} in ${sourceId}`)
	}

	const content = lines.slice(startIdx, endIdx).join("\n")

	// Calculate startOffset by summing lengths of lines before startIdx
	let startOffset = 0
	for (let i = 0; i < startIdx; i++) {
		startOffset += lines[i].length + 1 // +1 for the newline character
	}

	const endOffset = startOffset + content.length

	return {
		sourceId,
		content,
		startOffset,
		endOffset,
		line: startLine,
		confidence: 1.0,
		method: "exact",
	}
}

// ─── Public: resolveSelector ────────────────────────────────────────────────

/**
 * Resolve a quote (selector) against a source string using the 4-stage
 * matching cascade:
 *
 *   1. **Exact** — direct indexOf
 *   2. **Normalized** — whitespace + punctuation normalization, then indexOf
 *   3. **Fuzzy** — LCS (Longest Common Substring) with configurable tolerance
 *   4. **Word-Boundary Expansion** — expand result to word boundaries
 *
 * Throws if the quote cannot be found in the source.
 */
export function resolveSelector(
	sourceId: string,
	source: string,
	quote: string,
	options?: SelectorOptions,
): SelectorResult {
	if (!source) {
		throw new Error(`Empty source provided for sourceId: ${sourceId}`)
	}
	if (!quote) {
		throw new Error(`Empty quote provided for sourceId: ${sourceId}`)
	}

	const opts = resolveOptions(options)
	let pos = -1
	let method: SelectorResult["method"] = "exact"

	// Stage 1: Exact match
	pos = exactMatch(source, quote)

	// Stage 2: Normalized match
	if (pos === -1) {
		pos = normalizedMatch(source, quote, opts)
		if (pos !== -1) {
			method = "normalized"
		}
	}

	// Stage 3: LCS Fuzzy match
	if (pos === -1) {
		pos = normalizedFuzzyMatch(source, quote, opts)
		if (pos !== -1) {
			method = "fuzzy"
		}
	}

	if (pos === -1) {
		throw new Error(`Could not find quote in source "${sourceId}" after all matching stages`)
	}

	// Stage 4: Word-boundary expansion
	let endPos = pos + quote.length
	if (opts.expandToWords) {
		const expanded = expandToWordBoundaries(source, pos, endPos)
		pos = expanded.start
		endPos = expanded.end
	}

	const content = source.slice(pos, endPos)
	const line = calculateLine(source, pos)

	// Assign confidence based on method and whether expansion occurred
	let confidence: number
	switch (method) {
		case "exact":
			confidence = opts.expandToWords && pos !== endPos - quote.length ? 0.95 : 1.0
			break
		case "normalized":
			confidence = 0.9
			break
		case "fuzzy":
			confidence = 0.7
			break
		default:
			confidence = 0.85
	}

	return {
		sourceId,
		content,
		startOffset: pos,
		endOffset: endPos,
		line,
		confidence,
		method,
	}
}

// ─── Public: resolveAnchorPair ──────────────────────────────────────────────

/**
 * Resolve content using an anchor pair (startAnchor + optional endAnchor).
 *
 * - Finds `startAnchor` in the source
 * - If `endAnchor` is provided, searches for it **after** the start anchor match
 * - If `endAnchor` is omitted, expands to the end of the current line
 *
 * Returns a SelectorResult containing the matched content between anchors.
 */
export function resolveAnchorPair(
	sourceId: string,
	source: string,
	startAnchor: string,
	endAnchor?: string,
	options?: SelectorOptions,
): SelectorResult {
	const opts = resolveOptions(options)

	// Find startAnchor using full cascade
	const startResult = resolveSelector(sourceId, source, startAnchor, opts)
	const anchorEnd = startResult.startOffset + startAnchor.length

	if (endAnchor) {
		// Search for endAnchor after startAnchor's end position
		const afterSource = source.slice(anchorEnd)
		// Use a temporary sourceId for the slice context
		const endResult = resolveSelector(`${sourceId}:after-start`, afterSource, endAnchor, opts)

		const endPos = anchorEnd + endResult.endOffset
		const content = source.slice(startResult.startOffset, endPos)

		return {
			sourceId,
			content,
			startOffset: startResult.startOffset,
			endOffset: endPos,
			line: startResult.line,
			confidence: Math.min(startResult.confidence, endResult.confidence),
			method: "anchor",
		}
	}

	// No endAnchor: expand to the end of the current line
	const remainingAfter = source.slice(anchorEnd)
	const lineEndIdx = remainingAfter.indexOf("\n")
	const endPos = lineEndIdx === -1 ? source.length : anchorEnd + lineEndIdx + 1 // include newline

	const content = source.slice(startResult.startOffset, endPos)

	return {
		sourceId,
		content,
		startOffset: startResult.startOffset,
		endOffset: endPos,
		line: startResult.line,
		confidence: startResult.confidence,
		method: "anchor",
	}
}

// ─── Public: resolveContentRef (main entry point) ───────────────────────────

/**
 * Main entry point for content reference resolution.
 *
 * Resolves a `ContentRef` against a source string using the following
 * priority chain:
 *
 *   1. **Line numbers** — if `source === "file"` and `startLine` is set
 *   2. **Anchor pair** — if `startAnchor` is set
 *   3. **Selector** — if `selector` is set
 *   4. **Error** — if none of the above are specified
 *
 * @param sourceId - Human-readable identifier for the source (e.g. file path)
 * @param source   - The full source text to search within
 * @param ref      - ContentRef specifying what to find
 * @param options  - Optional matching configuration
 * @returns SelectorResult with the extracted content fragment
 * @throws If no match strategy is specified or matching fails
 */
export function resolveContentRef(
	sourceId: string,
	source: string,
	ref: ContentRef,
	options?: SelectorOptions,
): SelectorResult {
	// Priority 1: Line numbers (file source only)
	if (ref.source === "file" && ref.startLine != null) {
		return resolveLineRange(sourceId, source, ref.startLine, ref.endLine)
	}

	// Priority 2: Anchor pair
	if (ref.startAnchor) {
		return resolveAnchorPair(sourceId, source, ref.startAnchor, ref.endAnchor, options)
	}

	// Priority 3: Full selector
	if (ref.selector) {
		return resolveSelector(sourceId, source, ref.selector, options)
	}

	// Priority 4: Focus keyword (falls back to selector matching)
	if (ref.focus) {
		return resolveSelector(sourceId, source, ref.focus, options)
	}

	// No matching strategy specified
	throw new Error(
		`ContentRef for "${sourceId}" must specify at least one of: startAnchor, selector, focus, or startLine`,
	)
}
