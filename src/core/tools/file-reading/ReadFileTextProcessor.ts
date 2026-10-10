/** Text slicing, structural reading, and continuation formatting for file-reading tools. */
import type { ReadFileParams } from "@roo-code/types"
import { readWithIndentation, readWithSlice } from "../../../integrations/misc/indentation-reader"
import { DEFAULT_LINE_LIMIT, MAX_LINE_LENGTH } from "./readFileConstants"

export class ReadFileTextProcessor {
	process(content: string, params: ReadFileParams): string {
		const limit = params.limit ?? DEFAULT_LINE_LIMIT
		if (params.mode === "indentation") {
			const options = params.indentation
			const result = readWithIndentation(content, {
				anchorLine: options?.anchor_line ?? params.offset ?? 1,
				maxLevels: options?.max_levels,
				includeSiblings: options?.include_siblings,
				includeHeader: options?.include_header,
				limit,
				maxLines: options?.max_lines,
			})
			if (!result.includedRanges.length) return result.content
			if (result.wasTruncated) {
				const [start, end] = result.includedRanges[0]
				return this.formatTruncatedText(result.content, start, end, result.totalLines, limit)
			}
			const ranges = result.includedRanges.map(([start, end]) => `${start}-${end}`).join(", ")
			return `${result.content}\n\nIncluded ranges: ${ranges} (total: ${result.totalLines} lines)`
		}

		const offset = params.offset ?? 1
		const result = readWithSlice(content, Math.max(0, offset - 1), limit)
		if (result.content.startsWith("Error:")) return result.content
		if (result.wasTruncated) {
			return this.formatTruncatedText(
				result.content,
				offset,
				offset + result.returnedLines - 1,
				result.totalLines,
				limit,
			)
		}
		return result.returnedLines === 0 ? "Note: File is empty" : result.content
	}

	hasClippedLines(source: string, output: string): boolean {
		const lines = source.split("\n")
		return [...output.matchAll(/^\s*(\d+)\s*\|/gm)].some(
			(match) => (lines[Number(match[1]) - 1]?.length ?? 0) > MAX_LINE_LENGTH,
		)
	}

	private formatTruncatedText(content: string, start: number, end: number, total: number, limit: number): string {
		return `IMPORTANT: File content truncated.
	Status: Showing lines ${start}-${end} of ${total} total lines.
	To read more: Use the read_file tool with offset=${end + 1} and limit=${limit}.
\t
	${content}`
	}
}
