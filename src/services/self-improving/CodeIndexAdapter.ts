import type { CodeIndexInfo, Logger } from "./types"
import type { CodeIndexManager } from "../code-index/manager"
import type { VectorStoreSearchResult } from "../code-index/interfaces/vector-store"

export interface CodeSearchResult {
	filePath: string
	score: number
	snippet?: string
	line?: number
}

/**
 * CodeIndexAdapter - real adapter bridging CodeIndexManager into the self-improving system.
 *
 * Provides semantic search, file indexing, and availability checks
 * backed by the full CodeIndexManager (Qdrant + embedders).
 * Gracefully degrades when the manager is not initialized.
 */
export class CodeIndexAdapter {
	private codeIndexManager: CodeIndexManager | undefined

	constructor(
		private readonly logger?: Logger,
		codeIndexManager?: CodeIndexManager,
	) {
		this.codeIndexManager = codeIndexManager
	}

	setCodeIndexManager(manager: CodeIndexManager): void {
		this.codeIndexManager = manager
	}

	getInfo(): CodeIndexInfo {
		if (!this.codeIndexManager) {
			return { available: false, hits: 0 }
		}

		try {
			const status = this.codeIndexManager.getCurrentStatus()
			const isIndexed =
				status.systemStatus === "Indexed" || status.systemStatus === "Indexing"
			return {
				available: isIndexed,
				hits: isIndexed ? 1 : 0,
			}
		} catch (error) {
			this.logger?.appendLine(
				`[CodeIndexAdapter] Error getting code index info: ${error instanceof Error ? error.message : String(error)}`,
			)
			return { available: false, hits: 0 }
		}
	}

	isAvailable(): boolean {
		return this.getInfo().available
	}

	async search(query: string, limit: number = 10): Promise<CodeSearchResult[]> {
		if (!this.codeIndexManager) {
			return []
		}

		try {
			const results = await this.codeIndexManager.searchIndex(query)
			return results.slice(0, limit).map((r) => ({
				filePath: r.payload?.filePath ?? String(r.id),
				score: r.score,
				snippet: r.payload?.codeChunk,
				line: r.payload?.startLine,
			}))
		} catch (error) {
			this.logger?.appendLine(
				`[CodeIndexAdapter] Search error: ${error instanceof Error ? error.message : String(error)}`,
			)
			return []
		}
	}

	/**
	 * Searches the vector store directly, returning raw VectorStoreSearchResult[].
	 * Supports optional directory prefix filtering.
	 * Gracefully degrades when manager is not initialized or search fails.
	 * Non-blocking — returns empty array on any error.
	 */
	async searchVectorStore(
		query: string,
		directoryPrefix?: string,
	): Promise<VectorStoreSearchResult[]> {
		if (!this.codeIndexManager) {
			return []
		}

		try {
			return await this.codeIndexManager.searchIndex(query, directoryPrefix)
		} catch (error) {
			this.logger?.appendLine(
				`[CodeIndexAdapter] Vector store search error: ${error instanceof Error ? error.message : String(error)}`,
			)
			return []
		}
	}

	async startIndexing(): Promise<void> {
		if (!this.codeIndexManager) {
			return
		}

		try {
			await this.codeIndexManager.startIndexing()
		} catch (error) {
			this.logger?.appendLine(
				`[CodeIndexAdapter] Start indexing error: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}
}
