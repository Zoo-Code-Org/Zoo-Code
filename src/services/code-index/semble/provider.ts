import * as path from "path"
import * as vscode from "vscode"

import { IndexingState } from "../interfaces/manager"
import { VectorStoreSearchResult } from "../interfaces/vector-store"
import { CodeIndexStateManager } from "../state-manager"
import { SembleCLI } from "./semble-cli"
import { downloadSemble, isSembleSupportedPlatform } from "./semble-downloader"
import { ISembleProvider, SembleConfig, SembleContentType, SembleSearchResult, SEMBLE_DEFAULTS } from "./types"
import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName } from "@roo-code/types"

/**
 * Orchestrates code search via the semble CLI.
 *
 * Semble indexes on-the-fly with each search call — there is no separate
 * "indexing" step. The provider automatically downloads the semble binary
 * on first use, then delegates search queries to `semble search`.
 *
 * When `embedderProvider === "semble"`, the CodeIndexManager delegates
 * to this provider instead of the ServiceFactory → orchestrator pipeline.
 */
export class SembleProvider implements ISembleProvider {
	private cli!: SembleCLI
	private readonly workspacePath: string
	private readonly config: SembleConfig
	private readonly stateManager: CodeIndexStateManager
	private readonly context: vscode.ExtensionContext

	private _state: IndexingState = "Standby"
	private _isInitialized = false

	constructor(
		workspacePath: string,
		context: vscode.ExtensionContext,
		stateManager: CodeIndexStateManager,
		options?: { topK?: number; content?: SembleContentType },
	) {
		this.workspacePath = workspacePath
		this.context = context
		this.stateManager = stateManager

		this.config = {
			topK: options?.topK ?? SEMBLE_DEFAULTS.DEFAULT_TOP_K,
			content: options?.content ?? SEMBLE_DEFAULTS.DEFAULT_CONTENT,
		}
	}

	get state(): IndexingState {
		return this._state
	}

	/**
	 * Initializes the provider: downloads semble, then validates it works.
	 */
	async initialize(): Promise<void> {
		if (this._isInitialized) {
			return
		}

		// Check platform support
		if (!isSembleSupportedPlatform()) {
			this._state = "Error"
			this.stateManager.setSystemState(
				"Error",
				`Semble is not supported on this platform (${process.platform}-${process.arch}).`,
			)
			console.error(`[SembleProvider] Unsupported platform: ${process.platform}-${process.arch}`)
			return
		}

		// Download semble binary
		try {
			this.stateManager.setSystemState("Indexing", "Downloading semble binary...")
			const storageDir = this.context.globalStorageUri.fsPath
			const binaryPath = await downloadSemble(storageDir)
			if (!binaryPath) {
				throw new Error("Download returned no path")
			}
			this.cli = new SembleCLI(binaryPath)
		} catch (error: any) {
			this._state = "Error"
			this.stateManager.setSystemState("Error", `Failed to download semble: ${error?.message || error}`)
			console.error("[SembleProvider] Download failed:", error?.message || error)
			return
		}

		// Verify the binary works
		const checkResult = await this.cli.checkInstalled()

		if (!checkResult.installed) {
			const errorMsg = checkResult.error || "Semble binary is not functional"
			this._state = "Error"
			this.stateManager.setSystemState("Error", `Semble check failed: ${errorMsg}`)
			console.error("[SembleProvider] Semble check failed:", errorMsg)
			return
		}

		console.log("[SembleProvider] Semble found and ready.")

		// Semble indexes on-the-fly, so we mark as "Indexed" (ready for search)
		this._state = "Indexed"
		this.stateManager.setSystemState("Indexed", "Semble is ready. Searches index on-the-fly.")

		this._isInitialized = true
	}

	/**
	 * Starts indexing. Since semble indexes on-the-fly with each search,
	 * this just validates the installation and marks as ready.
	 */
	async startIndexing(): Promise<void> {
		if (!this._isInitialized) {
			await this.initialize()
		}

		if (this._state === "Error") {
			return
		}

		// Semble indexes on-the-fly — no separate indexing step needed.
		// Mark as indexed/ready.
		this._state = "Indexed"
		this.stateManager.setSystemState("Indexed", "Semble is ready. Searches index on-the-fly.")
	}

	/**
	 * Stops indexing (no-op — semble has no background indexing process).
	 */
	stopIndexing(): void {
		// No-op: semble indexes on-the-fly per search call
	}

	/**
	 * Searches the codebase using `semble search`.
	 *
	 * Always searches the full workspace root to avoid creating separate
	 * Semble cache directories for each subdirectory. When directoryPrefix
	 * is provided, results are filtered post-search to only include files
	 * within that directory.
	 */
	async searchIndex(query: string, directoryPrefix?: string): Promise<VectorStoreSearchResult[]> {
		if (!this._isInitialized) {
			console.warn("[SembleProvider] searchIndex called before initialization")
			return []
		}

		if (this._state === "Error") {
			return []
		}

		try {
			// Always search the full workspace to maintain a single Semble cache.
			// Semble creates a separate cache directory per path (SHA-256 of the
			// resolved absolute path), so passing subdirectories would create
			// redundant indexes and waste disk space.
			console.log(`[SembleProvider] Searching for "${query}" in ${this.workspacePath}`)
			const results = await this.cli.search(query, this.workspacePath, {
				topK: this.config.topK,
				content: this.config.content,
			})

			// Semble returns file paths relative to the search path (workspace root).
			// We join against workspacePath to produce correct absolute paths.
			let converted = this._convertResults(results, this.workspacePath)

			// Filter results to the requested directory prefix, if any.
			if (directoryPrefix) {
				const normalizedPrefix = path.join(this.workspacePath, directoryPrefix).replace(/\\/g, "/")
				converted = converted.filter((r) => {
					const filePath = (r.payload?.filePath ?? "").replace(/\\/g, "/")
					return filePath.startsWith(normalizedPrefix + "/") || filePath === normalizedPrefix
				})
				console.log(
					`[SembleProvider] Filtered to "${directoryPrefix}": ${converted.length} of ${results.length} results`,
				)
			}

			console.log(
				`[SembleProvider] Search returned ${converted.length} results (raw: ${results.length}). Sample path: ${converted[0]?.payload?.filePath ?? "none"}`,
			)
			return converted
		} catch (error: any) {
			const errorMessage = error?.message || String(error)
			console.error("[SembleProvider] Search failed:", errorMessage)

			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: errorMessage,
				stack: error instanceof Error ? error.stack : undefined,
				location: "SembleProvider.searchIndex",
			})

			return []
		}
	}

	/**
	 * Clears index data. Semble manages its own cache at ~/Library/Caches/semble/
	 * (or equivalent per-platform). This resets the provider state but does not
	 * delete semble's on-disk cache — use `semble clear-cache` for that.
	 */
	async clearIndexData(): Promise<void> {
		this._state = "Standby"
		this.stateManager.setSystemState("Standby", "Semble provider reset. On-disk cache remains until next rebuild.")
	}

	/**
	 * Disposes resources.
	 */
	dispose(): void {
		this._isInitialized = false
	}

	// --- Private Helpers ---

	/**
	 * Converts Semble CLI results to Zoo's VectorStoreSearchResult format.
	 *
	 * Semble v0.3.0+ returns results in the format:
	 *   { chunk: { content, file_path, start_line, end_line, language, location }, score }
	 *
	 * Note: semble returns file paths relative to the path it was invoked with.
	 * We join against `basePath` (the actual path passed to semble) to produce
	 * correct absolute paths for the rest of the pipeline.
	 * Results with missing file paths are excluded.
	 */
	private _convertResults(results: SembleSearchResult[], basePath: string): VectorStoreSearchResult[] {
		return results
			.filter((r) => r.chunk?.file_path) // Exclude results with no file path
			.map((r, index) => ({
				id: `semble-${index}`,
				score: r.score,
				payload: {
					filePath: path.join(basePath, r.chunk.file_path).replace(/\\/g, "/"),
					codeChunk: r.chunk?.content ?? "",
					startLine: r.chunk?.start_line ?? 0,
					endLine: r.chunk?.end_line ?? 0,
				},
			}))
	}
}
