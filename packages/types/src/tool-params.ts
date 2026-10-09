/**
 * Tool parameter type definitions for native protocol
 */
import type { LegacyReadFileParams } from "./read-files/read-files.js"

// Compatibility exports for existing imports; multiple-file reading lives in read-files.
export { MAX_READ_FILES, readFilesParamsSchema, isLegacyReadFileParams } from "./read-files/read-files.js"
export type { ReadFilesParams, LineRange, FileEntry, LegacyReadFileParams } from "./read-files/read-files.js"

/**
 * Read mode for the read_file tool.
 * - "slice": Simple offset/limit reading (default)
 * - "indentation": Semantic block extraction based on code structure
 */
export type ReadFileMode = "slice" | "indentation"

/**
 * Indentation-mode configuration for the read_file tool.
 */
export interface IndentationParams {
	/** 1-based line number to anchor indentation extraction (defaults to offset) */
	anchor_line?: number
	/** Maximum indentation levels to include above anchor (0 = unlimited) */
	max_levels?: number
	/** Include sibling blocks at the same indentation level */
	include_siblings?: boolean
	/** Include file header (imports, comments at top) */
	include_header?: boolean
	/** Hard cap on lines returned for indentation mode */
	max_lines?: number
}

/**
 * Parameters for the read_file tool (new format).
 *
 * NOTE: This is the canonical, single-file-per-call shape.
 */
export interface ReadFileParams {
	/** Path to the file, relative to workspace */
	path: string
	/** Reading mode: "slice" (default) or "indentation" */
	mode?: ReadFileMode
	/** 1-based line number to start reading from (slice mode, default: 1) */
	offset?: number
	/** Maximum number of lines to read (default: 2000) */
	limit?: number
	/** Indentation-mode configuration (only used when mode === "indentation") */
	indentation?: IndentationParams
}

/**
 * Union type for read_file tool parameters.
 * Supports both new single-file format and legacy multi-file format.
 */
export type ReadFileToolParams = ReadFileParams | LegacyReadFileParams

export interface Coordinate {
	x: number
	y: number
}

export interface Size {
	width: number
	height: number
}

export interface GenerateImageParams {
	prompt: string
	path: string
	image?: string
}
