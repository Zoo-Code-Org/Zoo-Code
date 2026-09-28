import type { IDirectoryScanner, IVectorStore } from "./interfaces"
import type { CodeIndexStateManager } from "./state-manager"
import { t } from "../../i18n"

/** Executes workspace scans; lifecycle, cleanup and watcher ownership stay with the orchestrator. */
export class CodeIndexScanExecutor {
	constructor(
		private readonly workspacePath: string,
		private readonly scanner: IDirectoryScanner,
		private readonly vectorStore: Pick<IVectorStore, "markIndexingIncomplete">,
		private readonly stateManager: Pick<CodeIndexStateManager, "setSystemState" | "reportBlockIndexingProgress">,
	) {}

	public async runIncrementalScan(signal: AbortSignal): Promise<void> {
		// Collection exists with data - run incremental scan to catch any new/changed files
		// This handles files added while workspace was closed or Qdrant was inactive
		console.log(
			"[CodeIndexOrchestrator] Collection already has indexed data. Running incremental scan for new/changed files...",
		)
		this.stateManager.setSystemState("Indexing", "Checking for new or modified files...")

		const summary = await this._scanWorkspace(signal, "incremental")
		const { indexed, found, batchErrors } = summary

		if (batchErrors.length > 0) {
			throw new Error(`Incremental indexing failed: ${batchErrors[0].message}`)
		}

		// If new files were found and indexed, log the results
		if (found > 0) {
			console.log(
				`[CodeIndexOrchestrator] Incremental scan completed: ${indexed} blocks indexed from new/changed files`,
			)
		} else {
			console.log("[CodeIndexOrchestrator] No new or changed files found")
		}
	}

	public async runFullScan(signal: AbortSignal): Promise<void> {
		// No existing data or collection was just created - do a full scan
		this.stateManager.setSystemState("Indexing", "Services ready. Starting workspace scan...")

		const summary = await this._scanWorkspace(signal, "full")

		this._validateFullScan(summary.indexed, summary.found, summary.batchErrors)
	}

	private async _scanWorkspace(
		signal: AbortSignal,
		kind: "full" | "incremental",
	): Promise<{ indexed: number; found: number; batchErrors: Error[] }> {
		// The scanner uses the cache to skip unchanged files in either scan mode.
		await this.vectorStore.markIndexingIncomplete()

		let indexed = 0
		let found = 0
		const batchErrors: Error[] = []

		const handleFileParsed = (fileBlockCount: number) => {
			found += fileBlockCount
			this.stateManager.reportBlockIndexingProgress(indexed, found)
		}

		const handleBlocksIndexed = (indexedCount: number) => {
			indexed += indexedCount
			this.stateManager.reportBlockIndexingProgress(indexed, found)
		}

		const result = await this.scanner.scanDirectory(
			this.workspacePath,
			(batchError: Error) => {
				console.error(
					`[CodeIndexOrchestrator] Error during ${kind === "full" ? "initial" : "incremental"} scan batch: ${batchError.message}`,
					batchError,
				)
				batchErrors.push(batchError)
			},
			handleBlocksIndexed,
			handleFileParsed,
			signal,
		)

		signal.throwIfAborted()

		if (!result) {
			throw new Error(
				kind === "full"
					? "Scan failed, is scanner initialized?"
					: "Incremental scan failed, is scanner initialized?",
			)
		}

		return { indexed, found, batchErrors }
	}

	private _validateFullScan(indexed: number, found: number, batchErrors: Error[]): void {
		const firstError = batchErrors[0]

		if (indexed === 0 && found > 0) {
			throw new Error(
				firstError
					? `Indexing failed: ${firstError.message}`
					: t("embeddings:orchestrator.indexingFailedNoBlocks"),
			)
		}

		if (firstError && indexed === 0) {
			throw new Error(`Indexing failed completely: ${firstError.message}`)
		}

		// Preserve the full-scan policy: batch errors are fatal above 10% failed blocks.
		if (firstError && found > 0 && (found - indexed) / found > 0.1) {
			throw new Error(
				`Indexing partially failed: Only ${indexed} of ${found} blocks were indexed. ${firstError.message}`,
			)
		}
	}
}
