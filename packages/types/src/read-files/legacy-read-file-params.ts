/** Legacy read_file parameters and compatibility guard for conversation resumption. */
import type { ReadFileToolParams } from "../tool-params.js"

/**
 * Line range specification for legacy read_file format.
 * Represents a contiguous range of lines [start, end] (1-based, inclusive).
 */
export interface LineRange {
	start: number
	end: number
}

/**
 * File entry for legacy read_file format.
 * Supports reading multiple disjoint line ranges from a single file.
 */
export interface FileEntry {
	/** Path to the file, relative to workspace */
	path: string
	/** Optional list of line ranges to read (if omitted, reads entire file) */
	lineRanges?: LineRange[]
}

/**
 * Legacy parameters for the read_file tool (pre-refactor format).
 * Supports reading multiple files in a single call with optional line ranges.
 *
 * @deprecated Use ReadFilesParams for batches or ReadFileParams for a single
 * file. This format is maintained for compatibility with existing chat histories.
 */
export interface LegacyReadFileParams {
	/** Array of file entries to read */
	files: FileEntry[]
	/** Discriminant flag for type narrowing */
	_legacyFormat: true
}

/** Type guard for the historical multi-file read_file contract. */
export function isLegacyReadFileParams(params: ReadFileToolParams): params is LegacyReadFileParams {
	// `NativeToolCallParser` always tags freshly parsed legacy calls with `_legacyFormat: true`.
	// The bare-`files` fallback only matters for chat history persisted before that flag was
	// introduced (commit cc86049f1) and re-hydrated on a later run. Note that params matched via
	// that fallback narrow to `LegacyReadFileParams` but leave `_legacyFormat` `undefined`, so
	// callers should branch on the presence of `files`, not on `_legacyFormat === true`.
	const hasLegacyFlag = "_legacyFormat" in params && params._legacyFormat === true
	const hasFilesArray = "files" in params && Array.isArray(params.files)
	return hasLegacyFlag || hasFilesArray
}
