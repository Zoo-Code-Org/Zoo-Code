/**
 * Pure budget ledger for folder-mention content inlining.
 *
 * A folder mention ("@/pkg/") must never add unbounded text to the context:
 * unbounded inlining inflates the token count into the millions and starts a
 * context condensation loop (issue #1539). This module decides, for a list of
 * extracted files, how many lines each one may contribute, and which files are
 * skipped. It never touches the filesystem and never parses file formats; the
 * caller hands it already-extracted text.
 *
 * Budget accounting is done on the lines that actually land in the context
 * block, so the block size - and therefore the token count - stays bounded and
 * predictable regardless of folder size or file format.
 */

/** One candidate file with its already-extracted text (or null when unreadable). */
export interface FolderInlineFileInput {
	/** Path as the model sees it, relative to the mention (posix separators). */
	relPath: string
	/** Extracted text, or null when the file could not be read. */
	extracted: {
		content: string
		totalLines: number
		returnedLines: number
	} | null
}

/** Line budgets for one folder-mention block. */
export interface FolderInlineBudgetConfig {
	/** Maximum extracted lines a single file may contribute. */
	perFileLines: number
	/** Maximum extracted lines all files together may contribute. */
	totalLines: number
}

/**
 * Default folder-mention budget. Chosen so a folder mention stays a compact
 * overview: small folders inline fully, large folders inline a bounded sample
 * and name the rest for read_file.
 */
export const DEFAULT_FOLDER_INLINE_BUDGET: FolderInlineBudgetConfig = {
	perFileLines: 250,
	totalLines: 1000,
}

/** Why a file's content is not in the block. */
export type FolderInlineSkipReason = "budget" | "unreadable"

/** A file whose content made it (in whole or in part) into the block. */
export interface FolderInlineFileSlice {
	relPath: string
	content: string
	/** Lines of this file present in `content`. */
	shownLines: number
	/** Total lines the extraction reported for this file. */
	totalLines: number
	/** True when `content` does not cover the whole extraction. */
	wasTruncated: boolean
}

/** The ledger's verdict for one folder mention. */
export interface FolderInlineLedgerResult {
	included: FolderInlineFileSlice[]
	skipped: { relPath: string; reason: FolderInlineSkipReason }[]
	/** Sum of shown lines; never above the total budget. */
	totalShownLines: number
}

/**
 * Counts the rendered lines of a content string. A trailing newline does not
 * start a new line, matching how readers count file lines.
 */
function countRenderedLines(content: string): number {
	if (content === "") {
		return 0
	}
	const lines = content.split("\n")
	if (lines[lines.length - 1] === "") {
		lines.pop()
	}
	return lines.length
}

/**
 * Keeps the first `take` rendered lines of `content`. The result is always
 * newline-terminated when non-empty, so slices of different files join cleanly.
 */
function sliceRenderedLines(content: string, take: number): string {
	if (take <= 0) {
		return ""
	}
	const lines = content.split("\n")
	if (lines[lines.length - 1] === "") {
		lines.pop()
	}
	if (lines.length <= take) {
		return content
	}
	return `${lines.slice(0, take).join("\n")}\n`
}

/**
 * Applies the budget to an ordered list of candidate files.
 *
 * Files are processed in the given order; each file takes at most
 * `min(returnedLines, perFileLines, remaining)` lines, so the sum of shown
 * lines never exceeds `totalLines`. A file with no extraction is skipped as
 * `unreadable`; a file whose budget share is zero is skipped as `budget`.
 *
 * The same input always yields the same result: order is preserved and no
 * randomness or wall-clock data takes part.
 */
export function assembleFolderInline(
	files: FolderInlineFileInput[],
	budget: FolderInlineBudgetConfig = DEFAULT_FOLDER_INLINE_BUDGET,
): FolderInlineLedgerResult {
	const included: FolderInlineFileSlice[] = []
	const skipped: { relPath: string; reason: FolderInlineSkipReason }[] = []
	let remaining = budget.totalLines

	for (const file of files) {
		if (!file.extracted) {
			skipped.push({ relPath: file.relPath, reason: "unreadable" })
			continue
		}

		// Both readings of "how many lines can this extraction give" agree on
		// the safe side: what the extractor returned, and what the content we
		// hold actually renders as. Extractable binary formats (.ipynb, .pdf,
		// .docx, .xlsx) return every extracted line with no cap of their own,
		// so the ledger's caps are what bounds them.
		const available = Math.min(file.extracted.returnedLines, countRenderedLines(file.extracted.content))
		const take = Math.min(available, budget.perFileLines, remaining)

		if (available <= 0) {
			// Nothing to show (empty extraction); no budget is consumed and
			// nothing is lost, so the file stays in `included` as an empty
			// slice.
			included.push({
				relPath: file.relPath,
				content: "",
				shownLines: 0,
				totalLines: file.extracted.totalLines,
				wasTruncated: false,
			})
			continue
		}

		if (take <= 0) {
			skipped.push({ relPath: file.relPath, reason: "budget" })
			continue
		}

		included.push({
			relPath: file.relPath,
			content: sliceRenderedLines(file.extracted.content, take),
			shownLines: take,
			totalLines: file.extracted.totalLines,
			wasTruncated: take < file.extracted.totalLines,
		})
		remaining -= take
	}

	const totalShownLines = included.reduce((sum, slice) => sum + slice.shownLines, 0)
	return { included, skipped, totalShownLines }
}
