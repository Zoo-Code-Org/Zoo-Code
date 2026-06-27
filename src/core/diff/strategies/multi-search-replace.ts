import { distance } from "fastest-levenshtein"

import { ToolProgressStatus, DEFAULT_DIFF_FUZZY_THRESHOLD } from "@roo-code/types"

import { addLineNumbers, everyLineHasLineNumbers, stripLineNumbers } from "../../../integrations/misc/extract-text"
import { ToolUse, DiffStrategy, DiffResult } from "../../../shared/tools"
import { normalizeString } from "../../../utils/text-normalization"

const BUFFER_LINES = 40 // Number of extra context lines to show before and after matches

function getSimilarity(original: string, search: string): number {
	// Empty searches are no longer supported
	if (search === "") {
		return 0
	}

	// Use the normalizeString utility to handle smart quotes and other special characters
	const normalizedOriginal = normalizeString(original)
	const normalizedSearch = normalizeString(search)

	if (normalizedOriginal === normalizedSearch) {
		return 1
	}

	// Calculate Levenshtein distance using fastest-levenshtein's distance function
	const dist = distance(normalizedOriginal, normalizedSearch)

	// Calculate similarity ratio (0 to 1, where 1 is an exact match)
	const maxLength = Math.max(normalizedOriginal.length, normalizedSearch.length)
	return 1 - dist / maxLength
}

/**
 * Performs a "middle-out" search of `lines` (between [startIndex, endIndex]) to find
 * the slice that is most similar to `searchChunk`. Returns the best score, index, and matched text.
 */
function fuzzySearch(lines: string[], searchChunk: string, startIndex: number, endIndex: number) {
	let bestScore = 0
	let bestMatchIndex = -1
	let bestMatchContent = ""
	const searchLen = searchChunk.split(/\r?\n/).length

	// Middle-out from the midpoint
	const midPoint = Math.floor((startIndex + endIndex) / 2)
	let leftIndex = midPoint
	let rightIndex = midPoint + 1

	while (leftIndex >= startIndex || rightIndex <= endIndex - searchLen) {
		if (leftIndex >= startIndex) {
			const originalChunk = lines.slice(leftIndex, leftIndex + searchLen).join("\n")
			const similarity = getSimilarity(originalChunk, searchChunk)
			if (similarity > bestScore) {
				bestScore = similarity
				bestMatchIndex = leftIndex
				bestMatchContent = originalChunk
			}
			leftIndex--
		}

		if (rightIndex <= endIndex - searchLen) {
			const originalChunk = lines.slice(rightIndex, rightIndex + searchLen).join("\n")
			const similarity = getSimilarity(originalChunk, searchChunk)
			if (similarity > bestScore) {
				bestScore = similarity
				bestMatchIndex = rightIndex
				bestMatchContent = originalChunk
			}
			rightIndex++
		}
	}

	return { bestScore, bestMatchIndex, bestMatchContent }
}

export class MultiSearchReplaceDiffStrategy implements DiffStrategy {
	private fuzzyThreshold: number
	private bufferLines: number

	getName(): string {
		return "MultiSearchReplace"
	}

	constructor(fuzzyThreshold?: number, bufferLines?: number) {
		// Use provided threshold or default to exact matching (1.0)
		// A value of 0.9 means 90% similarity is required for a match,
		// but the default remains 1.0 (exact match). Users can opt in
		// to relaxed matching via diffFuzzyThreshold in settings.
		// Clamp the threshold to [0.5, 1.0] as a defence-in-depth guard.
		const thresholdVal = fuzzyThreshold ?? DEFAULT_DIFF_FUZZY_THRESHOLD
		this.fuzzyThreshold = Math.max(0.5, Math.min(1.0, thresholdVal))
		this.bufferLines = bufferLines ?? BUFFER_LINES
	}

	private unescapeMarkers(content: string): string {
		return content
			.replace(/^\\<<<<<<</gm, "<<<<<<<")
			.replace(/^\\=======/gm, "=======")
			.replace(/^\\>>>>>>>/gm, ">>>>>>>")
			.replace(/^\\-------/gm, "-------")
			.replace(/^\\:end_line:/gm, ":end_line:")
			.replace(/^\\:start_line:/gm, ":start_line:")
	}

	private validateMarkerSequencing(diffContent: string): { success: boolean; error?: string } {
		enum State {
			START,
			AFTER_SEARCH,
			AFTER_SEPARATOR,
		}
		const state = { current: State.START, line: 0 }

		// Pattern allows optional '>' after SEARCH to handle AI-generated diffs
		// (e.g., Sonnet 4 sometimes adds an extra '>')
		const SEARCH_PATTERN = /^<<<<<<< SEARCH>?$/
		const SEARCH = SEARCH_PATTERN.source.replace(/[\^$]/g, "") // Remove regex anchors for display
		const SEP = "======="
		const REPLACE = ">>>>>>> REPLACE"
		const SEARCH_PREFIX = "<<<<<<<"
		const REPLACE_PREFIX = ">>>>>>>"

		const reportMergeConflictError = (found: string, _expected: string) => ({
			success: false,
			error:
				`ERROR: Special marker '${found}' found in your diff content at line ${state.line}:\n` +
				"\n" +
				`When removing merge conflict markers like '${found}' from files, you MUST escape them\n` +
				"in your SEARCH section by prepending a backslash (\\) at the beginning of the line:\n" +
				"\n" +
				"CORRECT FORMAT:\n\n" +
				"<<<<<<< SEARCH\n" +
				"content before\n" +
				`\\${found}    <-- Note the backslash here in this example\n` +
				"content after\n" +
				"=======\n" +
				"replacement content\n" +
				">>>>>>> REPLACE\n" +
				"\n" +
				"Without escaping, the system confuses your content with diff syntax markers.\n" +
				"You may use multiple diff blocks in a single diff request, but ANY of ONLY the following separators that occur within SEARCH or REPLACE content must be escaped, as follows:\n" +
				`\\${SEARCH}\n` +
				`\\${SEP}\n` +
				`\\${REPLACE}\n`,
		})

		const reportInvalidDiffError = (found: string, expected: string) => ({
			success: false,
			error:
				`ERROR: Diff block is malformed: marker '${found}' found in your diff content at line ${state.line}. Expected: ${expected}\n` +
				"\n" +
				"CORRECT FORMAT:\n\n" +
				"<<<<<<< SEARCH\n" +
				":start_line: (required) The line number of original content where the search block starts.\n" +
				"-------\n" +
				"[exact content to find including whitespace]\n" +
				"=======\n" +
				"[new content to replace with]\n" +
				">>>>>>> REPLACE\n",
		})

		const reportLineMarkerInReplaceError = (marker: string) => ({
			success: false,
			error:
				`ERROR: Invalid line marker '${marker}' found in REPLACE section at line ${state.line}\n` +
				"\n" +
				"Line markers (:start_line: and :end_line:) are only allowed in SEARCH sections.\n" +
				"\n" +
				"CORRECT FORMAT:\n" +
				"<<<<<<< SEARCH\n" +
				":start_line:5\n" +
				"content to find\n" +
				"=======\n" +
				"replacement content\n" +
				">>>>>>> REPLACE\n" +
				"\n" +
				"INCORRECT FORMAT:\n" +
				"<<<<<<< SEARCH\n" +
				"content to find\n" +
				"=======\n" +
				":start_line:5    <-- Invalid location\n" +
				"replacement content\n" +
				">>>>>>> REPLACE\n",
		})

		const lines = diffContent.split("\n")
		const searchCount = lines.filter((l) => SEARCH_PATTERN.test(l.trim())).length
		const sepCount = lines.filter((l) => l.trim() === SEP).length
		const replaceCount = lines.filter((l) => l.trim() === REPLACE).length

		const likelyBadStructure = searchCount !== replaceCount || sepCount < searchCount

		for (const line of diffContent.split("\n")) {
			state.line++
			const marker = line.trim()

			// Check for line markers in REPLACE sections (but allow escaped ones)
			if (state.current === State.AFTER_SEPARATOR) {
				if (marker.startsWith(":start_line:") && !line.trim().startsWith("\\:start_line:")) {
					return reportLineMarkerInReplaceError(":start_line:")
				}
				if (marker.startsWith(":end_line:") && !line.trim().startsWith("\\:end_line:")) {
					return reportLineMarkerInReplaceError(":end_line:")
				}
			}

			switch (state.current) {
				case State.START:
					if (marker === SEP)
						return likelyBadStructure
							? reportInvalidDiffError(SEP, SEARCH)
							: reportMergeConflictError(SEP, SEARCH)
					if (marker === REPLACE) return reportInvalidDiffError(REPLACE, SEARCH)
					if (marker.startsWith(REPLACE_PREFIX)) return reportMergeConflictError(marker, SEARCH)
					if (SEARCH_PATTERN.test(marker)) state.current = State.AFTER_SEARCH
					else if (marker.startsWith(SEARCH_PREFIX)) return reportMergeConflictError(marker, SEARCH)
					break

				case State.AFTER_SEARCH:
					if (SEARCH_PATTERN.test(marker)) return reportInvalidDiffError(SEARCH_PATTERN.source, SEP)
					if (marker.startsWith(SEARCH_PREFIX)) return reportMergeConflictError(marker, SEARCH)
					if (marker === REPLACE) return reportInvalidDiffError(REPLACE, SEP)
					if (marker.startsWith(REPLACE_PREFIX)) return reportMergeConflictError(marker, SEARCH)
					if (marker === SEP) state.current = State.AFTER_SEPARATOR
					break

				case State.AFTER_SEPARATOR:
					if (SEARCH_PATTERN.test(marker)) return reportInvalidDiffError(SEARCH_PATTERN.source, REPLACE)
					if (marker.startsWith(SEARCH_PREFIX)) return reportMergeConflictError(marker, REPLACE)
					if (marker === SEP)
						return likelyBadStructure
							? reportInvalidDiffError(SEP, REPLACE)
							: reportMergeConflictError(SEP, REPLACE)
					if (marker === REPLACE) state.current = State.START
					else if (marker.startsWith(REPLACE_PREFIX)) return reportMergeConflictError(marker, REPLACE)
					break
			}
		}

		return state.current === State.START
			? { success: true }
			: {
					success: false,
					error: `ERROR: Unexpected end of sequence: Expected '${
						state.current === State.AFTER_SEARCH ? "=======" : ">>>>>>> REPLACE"
					}' was not found.`,
				}
	}

	/**
	 * Repairs truncated diffs (common with Grok) by adding missing ======= and >>>>>>> REPLACE markers.
	 * When the model's output gets cut off mid-stream, the diff may end after SEARCH content
	 * without the separator or closing marker. This method detects that pattern and appends
	 * the missing markers so the diff can still be parsed and applied.
	 */
	private repairTruncatedDiff(diffContent: string): string {
		// Only repair if the diff has at least one SEARCH marker
		if (!/(?<!\\)<<<<<<< SEARCH/.test(diffContent)) {
			return diffContent
		}

		// Split into blocks based on SEARCH markers
		const blocks = diffContent.split(/(?=(?<!\\)<<<<<<< SEARCH)/)

		let repaired = ""

		for (let i = 0; i < blocks.length; i++) {
			const block = blocks[i]

			if (block.trim() === "") {
				continue
			}

			// Skip prefix blocks that don't contain a SEARCH marker
			// (e.g., the filename line before the first <<<<<<< SEARCH)
			if (!/(?<!\\)<<<<<<< SEARCH/.test(block)) {
				repaired += block
				continue
			}

			// Check if this block is complete (has both ======= and >>>>>>> REPLACE)
			const hasSeparator = /(?<=\n)(?<!\\)=======\s*\n/.test(block)
			const hasCloser = /(?<=\n)(?<!\\)>>>>>>> REPLACE(?=\n|$)/.test(block)

			if (hasSeparator && hasCloser) {
				// Block is complete — emit verbatim (keeps its own trailing separator)
				repaired += block
				continue
			}

			// Block needs repair. Build a clean block ending at >>>>>>> REPLACE, then
			// re-add an inter-block separator if more (non-empty) blocks follow, so the
			// appended closer never gets glued to the next "<<<<<<< SEARCH".
			const isLast = blocks.slice(i + 1).every((b) => b.trim() === "")
			const separator = isLast ? "" : "\n\n"

			if (hasSeparator && !hasCloser) {
				// Has ======= but missing >>>>>>> REPLACE — append closing marker
				const body = block.replace(/\s+$/, "")
				repaired += body + "\n>>>>>>> REPLACE" + separator
			} else if (hasCloser && !hasSeparator) {
				// Has >>>>>>> REPLACE but missing the ======= separator. Don't synthesize a
				// second closer; splice the separator in right before the existing closer so
				// everything above it becomes the SEARCH section.
				const body = block.replace(/\s+$/, "")
				repaired += body.replace(/(\n)(>>>>>>> REPLACE)(?=\n|$)/, "$1=======\n$2") + separator
			} else {
				// Missing both ======= and >>>>>>> REPLACE.
				const searchMatch = block.match(/^<<<<<<< SEARCH\n?([\s\S]*)$/)
				let content = (searchMatch?.[1] ?? "").replace(/\s+$/, "")

				// Peel off any leading Grok header directives (:start_line:, :end_line:, -------)
				// so the "first line is SEARCH" heuristic sees real content, not metadata. The
				// directives are preserved as a header on the SEARCH section.
				let header = ""
				const directiveLine = /^(?::start_line:\s*\d+|:end_line:\s*\d+|-------)\s*$/
				let nlIdx: number
				while ((nlIdx = content.indexOf("\n")) !== -1 && directiveLine.test(content.slice(0, nlIdx))) {
					header += content.slice(0, nlIdx + 1)
					content = content.slice(nlIdx + 1)
				}

				const firstNewlineIdx = content.indexOf("\n")
				if (firstNewlineIdx !== -1) {
					// First line is SEARCH content, rest is REPLACE content
					const searchContent = content.substring(0, firstNewlineIdx)
					const replaceContent = content.substring(firstNewlineIdx + 1)
					repaired +=
						"<<<<<<< SEARCH\n" +
						header +
						searchContent +
						"\n=======\n" +
						replaceContent +
						"\n>>>>>>> REPLACE" +
						separator
				} else if (header) {
					// Only a directive header plus a single content line: that line is the SEARCH
					// target (the user pinned it with start_line); the REPLACE section is empty.
					repaired += "<<<<<<< SEARCH\n" + header + content + "\n=======\n\n>>>>>>> REPLACE" + separator
				} else {
					// Single line — treat as empty SEARCH with content as REPLACE
					repaired += "<<<<<<< SEARCH\n=======\n" + content + "\n>>>>>>> REPLACE" + separator
				}
			}
		}

		return repaired || diffContent
	}

	async applyDiff(
		originalContent: string,
		diffContent: string,
		_paramStartLine?: number,
		_paramEndLine?: number,
	): Promise<DiffResult> {
		// Repair truncated diffs before validation (common with Grok and other models
		// whose output gets cut off mid-stream, leaving missing ======= and >>>>>>> REPLACE markers)
		const repairedDiff = this.repairTruncatedDiff(diffContent)

		const validseq = this.validateMarkerSequencing(repairedDiff)
		if (!validseq.success) {
			return {
				success: false,
				error: validseq.error!,
			}
		}

		/*
			Regex parts:
			
			1. (?:^|\n)  
			  Ensures the first marker starts at the beginning of the file or right after a newline.

			2. (?<!\\)<<<<<<< SEARCH\s*\n  
			  Matches the line "<<<<<<< SEARCH" (ignoring any trailing spaces) – the negative lookbehind makes sure it isn't escaped.

			3. ((?:\:start_line:\s*(\d+)\s*\n))?  
			  Optionally matches a ":start_line:" line. The outer capturing group is group 1 and the inner (\d+) is group 2.

			4. ((?:\:end_line:\s*(\d+)\s*\n))?  
			  Optionally matches a ":end_line:" line. Group 3 is the whole match and group 4 is the digits.

			5. ((?<!\\)-------\s*\n)?  
			  Optionally matches the "-------" marker line (group 5).

			6. ([\s\S]*?)(?:\n)?  
			  Non‐greedy match for the "search content" (group 6) up to the next marker.

			7. (?:(?<=\n)(?<!\\)=======\s*\n)  
			  Matches the "=======" marker on its own line.

			8. ([\s\S]*?)(?:\n)?  
			  Non‐greedy match for the "replace content" (group 7).

			9. (?:(?<=\n)(?<!\\)>>>>>>> REPLACE)(?=\n|$)  
			  Matches the final ">>>>>>> REPLACE" marker on its own line (and requires a following newline or the end of file).
		*/

		const matches = [
			...repairedDiff.matchAll(
				/(?:^|\n)(?<!\\)<<<<<<< SEARCH>?\s*\n((?:\:start_line:\s*(\d+)\s*\n))?((?:\:end_line:\s*(\d+)\s*\n))?((?<!\\)-------\s*\n)?([\s\S]*?)(?:\n)?(?:(?<=\n)(?<!\\)=======\s*\n)([\s\S]*?)(?:\n)?(?:(?<=\n)(?<!\\)>>>>>>> REPLACE)(?=\n|$)/g,
			),
		]

		if (matches.length === 0) {
			return {
				success: false,
				error: `Invalid diff format - missing required sections\n\nDebug Info:\n- Expected Format: <<<<<<< SEARCH\\n:start_line: start line\\n-------\\n[search content]\\n=======\\n[replace content]\\n>>>>>>> REPLACE\n- Tip: Make sure to include start_line/SEARCH/=======/REPLACE sections with correct markers on new lines`,
			}
		}
		// Detect line ending from original content
		const lineEnding = originalContent.includes("\r\n") ? "\r\n" : "\n"
		let resultLines = originalContent.split(/\r?\n/)
		let delta = 0
		const diffResults: DiffResult[] = []
		let appliedCount = 0
		const replacements = matches
			.map((match) => ({
				startLine: Number(match[2] ?? 0),
				searchContent: match[6],
				replaceContent: match[7],
			}))
			.sort((a, b) => a.startLine - b.startLine)

		for (const replacement of replacements) {
			let { searchContent, replaceContent } = replacement
			let startLine = replacement.startLine + (replacement.startLine === 0 ? 0 : delta)

			// First unescape any escaped markers in the content
			searchContent = this.unescapeMarkers(searchContent)
			replaceContent = this.unescapeMarkers(replaceContent)

			// Strip line numbers from search and replace content if every line starts with a line number
			const hasAllLineNumbers =
				(everyLineHasLineNumbers(searchContent) && everyLineHasLineNumbers(replaceContent)) ||
				(everyLineHasLineNumbers(searchContent) && replaceContent.trim() === "")

			if (hasAllLineNumbers && startLine === 0) {
				startLine = parseInt(searchContent.split("\n")[0].split("|")[0])
			}

			if (hasAllLineNumbers) {
				searchContent = stripLineNumbers(searchContent)
				replaceContent = stripLineNumbers(replaceContent)
			}

			// Validate that search and replace content are not identical
			if (searchContent === replaceContent) {
				diffResults.push({
					success: false,
					error:
						`Search and replace content are identical - no changes would be made\n\n` +
						`Debug Info:\n` +
						`- Search and replace must be different to make changes\n` +
						`- Use read_file to verify the content you want to change`,
				})
				continue
			}

			// Split content into lines, handling both \n and \r\n
			let searchLines = searchContent === "" ? [] : searchContent.split(/\r?\n/)
			let replaceLines = replaceContent === "" ? [] : replaceContent.split(/\r?\n/)

			// Validate that search content is not empty
			if (searchLines.length === 0) {
				diffResults.push({
					success: false,
					error: `Empty search content is not allowed\n\nDebug Info:\n- Search content cannot be empty\n- For insertions, provide a specific line using :start_line: and include content to search for\n- For example, match a single line to insert before/after it`,
				})
				continue
			}

			const endLine = replacement.startLine + searchLines.length - 1

			// Initialize search variables
			let matchIndex = -1
			let bestMatchScore = 0
			let bestMatchContent = ""
			const searchChunk = searchLines.join("\n")

			// Determine search bounds
			let searchStartIndex = 0
			let searchEndIndex = resultLines.length

			// Validate and handle line range if provided
			if (startLine) {
				// Convert to 0-based index
				const exactStartIndex = startLine - 1
				const searchLen = searchLines.length
				const exactEndIndex = exactStartIndex + searchLen - 1

				// Try exact match first
				const originalChunk = resultLines.slice(exactStartIndex, exactEndIndex + 1).join("\n")
				const similarity = getSimilarity(originalChunk, searchChunk)
				if (similarity >= this.fuzzyThreshold) {
					matchIndex = exactStartIndex
					bestMatchScore = similarity
					bestMatchContent = originalChunk
				} else {
					// Set bounds for buffered search
					searchStartIndex = Math.max(0, startLine - (this.bufferLines + 1))
					searchEndIndex = Math.min(resultLines.length, startLine + searchLines.length + this.bufferLines)
				}
			}

			// If no match found yet, try middle-out search within bounds
			if (matchIndex === -1) {
				const {
					bestScore,
					bestMatchIndex,
					bestMatchContent: midContent,
				} = fuzzySearch(resultLines, searchChunk, searchStartIndex, searchEndIndex)
				matchIndex = bestMatchIndex
				bestMatchScore = bestScore
				bestMatchContent = midContent
			}

			// Try aggressive line number stripping as a fallback if regular matching fails
			if (matchIndex === -1 || bestMatchScore < this.fuzzyThreshold) {
				// Strip both search and replace content once (simultaneously)
				const aggressiveSearchContent = stripLineNumbers(searchContent, true)
				const aggressiveReplaceContent = stripLineNumbers(replaceContent, true)

				const aggressiveSearchLines = aggressiveSearchContent ? aggressiveSearchContent.split(/\r?\n/) : []
				const aggressiveSearchChunk = aggressiveSearchLines.join("\n")

				// Try middle-out search again with aggressive stripped content (respecting the same search bounds)
				const {
					bestScore,
					bestMatchIndex,
					bestMatchContent: aggContent,
				} = fuzzySearch(resultLines, aggressiveSearchChunk, searchStartIndex, searchEndIndex)
				if (bestMatchIndex !== -1 && bestScore >= this.fuzzyThreshold) {
					matchIndex = bestMatchIndex
					bestMatchScore = bestScore
					bestMatchContent = aggContent
					// Replace the original search/replace with their stripped versions
					searchContent = aggressiveSearchContent
					replaceContent = aggressiveReplaceContent
					searchLines = aggressiveSearchLines
					replaceLines = replaceContent ? replaceContent.split(/\r?\n/) : []
				} else {
					// No match found with either method
					const originalContentSection =
						startLine && endLine
							? `\n\nOriginal Content:\n${addLineNumbers(
									resultLines
										.slice(
											Math.max(0, startLine - 1 - this.bufferLines),
											Math.min(resultLines.length, endLine + this.bufferLines),
										)
										.join("\n"),
									Math.max(1, startLine - this.bufferLines),
								)}`
							: `\n\nOriginal Content:\n${addLineNumbers(
									resultLines
										.slice(
											Math.max(0, (matchIndex >= 0 ? matchIndex : 0) - this.bufferLines),
											Math.min(
												resultLines.length,
												(matchIndex >= 0 ? matchIndex : 0) +
													searchLines.length +
													this.bufferLines,
											),
										)
										.join("\n"),
									Math.max(1, (matchIndex >= 0 ? matchIndex : 0) - this.bufferLines + 1),
								)}`

					const bestMatchSection = bestMatchContent
						? `\n\nBest Match Found:\n${addLineNumbers(bestMatchContent, matchIndex + 1)}`
						: `\n\nBest Match Found:\n(no match)`

					const lineRange = startLine ? ` at line: ${startLine}` : ""

					const levenDist = bestMatchContent
						? distance(normalizeString(searchChunk), normalizeString(bestMatchContent))
						: -1

					diffResults.push({
						success: false,
						error: `No sufficiently similar match found${lineRange} (${Math.floor(bestMatchScore * 100)}% similar, needs ${Math.floor(this.fuzzyThreshold * 100)}%)\n\nDebug Info:\n- Similarity Score: ${Math.floor(bestMatchScore * 100)}%\n- Required Threshold: ${Math.floor(this.fuzzyThreshold * 100)}%\n- Search Range: ${startLine ? `starting at line ${startLine}` : "start to end"}\n- Levenshtein Distance: ${levenDist >= 0 ? `${levenDist} characters` : "N/A"}\n- Search Length: ${searchChunk.length} characters\n- Best Match Length: ${bestMatchContent ? bestMatchContent.length : 0} characters\n- Tried both standard and aggressive line number stripping\n- Tip: Use the read_file tool to get the latest content of the file before attempting to use the apply_diff tool again, as the file content may have changed\n\nSearch Content:\n${searchChunk}${bestMatchSection}${originalContentSection}`,
					})
					continue
				}
			}

			// Get the matched lines from the original content
			const matchedLines = resultLines.slice(matchIndex, matchIndex + searchLines.length)

			// Get the exact indentation (preserving tabs/spaces) of each line
			const originalIndents = matchedLines.map((line) => {
				const match = line.match(/^[\t ]*/)
				return match ? match[0] : ""
			})

			// Get the exact indentation of each line in the search block
			const searchIndents = searchLines.map((line) => {
				const match = line.match(/^[\t ]*/)
				return match ? match[0] : ""
			})

			// Apply the replacement while preserving exact indentation
			const indentedReplaceLines = replaceLines.map((line) => {
				// Get the matched line's exact indentation
				const matchedIndent = originalIndents[0] || ""

				// Get the current line's indentation relative to the search content
				const currentIndentMatch = line.match(/^[\t ]*/)
				const currentIndent = currentIndentMatch ? currentIndentMatch[0] : ""
				const searchBaseIndent = searchIndents[0] || ""

				// Calculate the relative indentation level
				const searchBaseLevel = searchBaseIndent.length
				const currentLevel = currentIndent.length
				const relativeLevel = currentLevel - searchBaseLevel

				// If relative level is negative, remove indentation from matched indent
				// If positive, add to matched indent
				const finalIndent =
					relativeLevel < 0
						? matchedIndent.slice(0, Math.max(0, matchedIndent.length + relativeLevel))
						: matchedIndent + currentIndent.slice(searchBaseLevel)

				return finalIndent + line.trim()
			})

			// Construct the final content
			const beforeMatch = resultLines.slice(0, matchIndex)
			const afterMatch = resultLines.slice(matchIndex + searchLines.length)
			resultLines = [...beforeMatch, ...indentedReplaceLines, ...afterMatch]
			delta = delta - matchedLines.length + replaceLines.length
			appliedCount++
		}
		const finalContent = resultLines.join(lineEnding)
		if (appliedCount === 0) {
			return {
				success: false,
				failParts: diffResults,
			}
		}
		return {
			success: true,
			content: finalContent,
			failParts: diffResults,
		}
	}

	getProgressStatus(toolUse: ToolUse, result?: DiffResult): ToolProgressStatus {
		const diffContent = toolUse.params.diff
		if (diffContent) {
			const icon = "diff-multiple"
			if (toolUse.partial) {
				if (Math.floor(diffContent.length / 10) % 10 === 0) {
					const searchBlockCount = (diffContent.match(/SEARCH/g) || []).length
					return { icon, text: `${searchBlockCount}` }
				}
			} else if (result) {
				const searchBlockCount = (diffContent.match(/SEARCH/g) || []).length
				if (result.failParts?.length) {
					return {
						icon,
						text: `${searchBlockCount - result.failParts.length}/${searchBlockCount}`,
					}
				} else {
					return { icon, text: `${searchBlockCount}` }
				}
			}
		}
		return {}
	}
}
