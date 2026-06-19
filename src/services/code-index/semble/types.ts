import { IndexingState } from "../interfaces/manager"
import { VectorStoreSearchResult } from "../interfaces/vector-store"

/**
 * Content types supported by semble for indexing.
 * Maps to the `--content` CLI flag.
 */
export type SembleContentType = "code" | "docs" | "config" | "all"

/**
 * A single chunk returned by semble search results.
 * Matches the `chunk` field in semble's JSON output format.
 */
export interface SembleChunk {
	content: string
	file_path: string
	start_line: number
	end_line: number
	language: string | null
	location: string
}

/**
 * Result from a semble CLI search invocation.
 * Matches the JSON output format: `{ query, results: [{ chunk, score }] }`.
 */
export interface SembleSearchResult {
	chunk: SembleChunk
	score: number
}

/**
 * Result from checking if semble is functional.
 */
export interface SembleCheckResult {
	installed: boolean
	error?: string
}

/**
 * Configuration for the Semble provider.
 */
export interface SembleConfig {
	/** Maximum search results to return. Default: 10. */
	topK: number
	/** Content types to index. Default: "code". */
	content: SembleContentType
}

/**
 * Interface for the SembleProvider that wraps the semble CLI.
 *
 * Note: `findRelated` is available on SembleCLI but not yet exposed through
 * this provider or CodeIndexManager. It's reserved for future use — e.g., a
 * "find similar code" tool or context menu action.
 */
export interface ISembleProvider {
	/** Initializes the provider — checks semble is installed. */
	initialize(): Promise<void>

	/** Marks the provider as ready (semble indexes on-the-fly). */
	startIndexing(): Promise<void>

	/** Stops indexing (no-op — semble has no background process). */
	stopIndexing(): void

	/** Searches the codebase for relevant code. */
	searchIndex(query: string, directoryPrefix?: string): Promise<VectorStoreSearchResult[]>

	/** Clears index data (no-op in current version). */
	clearIndexData(): Promise<void>

	/** Disposes resources. */
	dispose(): void

	/** Current state. */
	readonly state: IndexingState
}

/**
 * Default configuration values for Semble.
 */
export const SEMBLE_DEFAULTS = {
	DEFAULT_TOP_K: 10,
	DEFAULT_CONTENT: "code" as SembleContentType,
}
