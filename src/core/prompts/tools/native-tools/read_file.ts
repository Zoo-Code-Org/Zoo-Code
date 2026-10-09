import type OpenAI from "openai"
import { READ_FILES_TOOL_NAME } from "@roo-code/types"
import { DEFAULT_LINE_LIMIT, MAX_LINE_LENGTH } from "../../../tools/file-reading/readFileConstants"
import { createReadFileParameters } from "./file-reading/readFileParameters"

// Preserve older imports without making runtime readers depend on this tool definition.
export { DEFAULT_LINE_LIMIT, MAX_LINE_LENGTH, DEFAULT_MAX_LEVELS } from "../../../tools/file-reading/readFileConstants"

// ─── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Generates the file support note, optionally including image format support.
 *
 * @param supportsImages - Whether the model supports image processing
 * @returns Support note string
 */
function getReadFileSupportsNote(supportsImages: boolean): string {
	if (supportsImages) {
		return `Supports text extraction from PDF and DOCX files. Automatically processes and returns image files (PNG, JPG, JPEG, GIF, BMP, SVG, WEBP, ICO, AVIF) for visual analysis. May not handle other binary files properly.`
	}
	return `Supports text extraction from PDF and DOCX files, but may not handle other binary files properly.`
}

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Options for creating the read_file tool definition.
 */
export interface ReadFileToolOptions {
	/** Whether the model supports image processing (default: false) */
	supportsImages?: boolean
}

// ─── Schema Builder ───────────────────────────────────────────────────────────

/**
 * Creates the read_file tool definition with Codex-inspired modes.
 *
 * Two reading modes are supported:
 *
 * 1. **Slice Mode** (default): Simple offset/limit reading
 *    - Reads contiguous lines starting from `offset` (1-based, default: 1)
 *    - Limited to `limit` lines (default: 2000)
 *    - Predictable and efficient for agent planning
 *
 * 2. **Indentation Mode**: Semantic code block extraction
 *    - Anchored on a specific line number (1-based)
 *    - Extracts the block containing that line plus context
 *    - Respects code structure based on indentation hierarchy
 *    - Useful for extracting functions, classes, or logical blocks
 *
 * @param options - Configuration options for the tool
 * @returns Native tool definition for read_file
 */
export function createReadFileTool(options: ReadFileToolOptions = {}): OpenAI.Chat.ChatCompletionTool {
	const { supportsImages = false } = options

	// Build description based on capabilities
	const descriptionIntro =
		"Read a file and return its contents with line numbers for diffing or discussion. This tool reads exactly one file per call. " +
		`Use ${READ_FILES_TOOL_NAME} for already-known independent text/document reads in one bounded call; keep read_file for dependent exploration and images. ` +
		"NOTE: Line-number prefixes (e.g. `137 | `) are for reference only and do NOT exist in the raw file. Do NOT copy them into `old_string`, SEARCH blocks, or other edit inputs."

	const modeDescription =
		` Supports two modes: 'slice' (default) reads lines sequentially with offset/limit; 'indentation' extracts complete semantic code blocks around an anchor line based on indentation hierarchy.` +
		` Slice mode is ideal for initial file exploration, understanding overall structure, reading configuration/data files, or when you need a specific line range. Use it when you don't have a target line number.` +
		` PREFER indentation mode when you have a specific line number from search results, error messages, or definition lookups - it guarantees complete, syntactically valid code blocks without mid-function truncation.` +
		` IMPORTANT: Indentation mode requires anchor_line to be useful. Without it, only header content (imports) is returned.`

	const limitNote = ` By default, returns up to ${DEFAULT_LINE_LIMIT} lines per file. Lines longer than ${MAX_LINE_LENGTH} characters are truncated.`

	const description =
		descriptionIntro +
		modeDescription +
		limitNote +
		" " +
		getReadFileSupportsNote(supportsImages) +
		` Example: { path: 'src/app.ts' }` +
		` Example (indentation mode): { path: 'src/app.ts', mode: 'indentation', indentation: { anchor_line: 42 } }`

	return {
		type: "function",
		function: {
			name: "read_file",
			description,
			strict: true,
			parameters: createReadFileParameters(),
		},
	} satisfies OpenAI.Chat.ChatCompletionTool
}

/**
 * Default read_file tool with all parameters
 */
export const read_file = createReadFileTool()
