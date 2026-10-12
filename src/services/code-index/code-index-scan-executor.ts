import type { IDirectoryScanner, IVectorStore } from "./interfaces"
import type { CodeIndexStateManager } from "./state-manager"
import { t } from "../../i18n"

/** Executes scans; cancellation cleanup, watcher startup and completion remain with the orchestrator. */
export class CodeIndexScanExecutor {
	constructor(
		private readonly workspacePath: string,
		private readonly scanner: IDirectoryScanner,
		private readonly vectorStore: Pick<IVectorStore, "markIndexingIncomplete">,
		private readonly stateManager: Pick<CodeIndexStateManager, "setSystemState" | "reportBlockIndexingProgress">,
	) {}

	/** Returns false when the scanner returns after cancellation, preserving the owner's normal-return path. */
	async runIncrementalScan(signal: AbortSignal): Promise<boolean> {
		console.log(
			"[CodeIndexOrchestrator] Collection already has indexed data. Running incremental scan for new/changed files...",
		)
		this.stateManager.setSystemState("Indexing", "Checking for new or modified files...")
		const summary = await this.scanWorkspace(signal, "incremental")
		if (!summary) return false

		// Do not mark an existing index complete when some updates failed.
		if (summary.batchErrors.length > 0) {
			const messages = [...new Set(summary.batchErrors.map((error) => error.message))]
			throw new AggregateError(
				summary.batchErrors,
				`Incremental scan failed with ${summary.batchErrors.length} errors:\n${messages.join("\n")}`,
			)
		}

		if (summary.found > 0) {
			console.log(
				`[CodeIndexOrchestrator] Incremental scan completed: ${summary.indexed} blocks indexed from new/changed files`,
			)
		} else {
			console.log("[CodeIndexOrchestrator] No new or changed files found")
		}
		return true
	}

	/** Returns false on returned cancellation; scanner rejections propagate unchanged. */
	async runFullScan(signal: AbortSignal): Promise<boolean> {
		this.stateManager.setSystemState("Indexing", "Services ready. Starting workspace scan...")
		const summary = await this.scanWorkspace(signal, "full")
		if (!summary) return false
		this.validateFullScan(summary.indexed, summary.found, summary.batchErrors)
		return true
	}

	private async scanWorkspace(
		signal: AbortSignal,
		kind: "full" | "incremental",
	): Promise<{ indexed: number; found: number; batchErrors: Error[] } | undefined> {
		await this.vectorStore.markIndexingIncomplete()
		let indexed = 0
		let found = 0
		const batchErrors: Error[] = []
		const result = await this.scanner.scanDirectory(
			this.workspacePath,
			(batchError: Error) => {
				console.error(
					`[CodeIndexOrchestrator] Error during ${kind === "full" ? "initial" : "incremental"} scan batch: ${batchError.message}`,
					batchError,
				)
				batchErrors.push(batchError)
			},
			(count: number) => {
				indexed += count
				this.stateManager.reportBlockIndexingProgress(indexed, found)
			},
			(count: number) => {
				found += count
				this.stateManager.reportBlockIndexingProgress(indexed, found)
			},
			signal,
		)

		// Cancellation precedes missing-result checks and validation, just as in the orchestrator.
		if (signal.aborted) return undefined
		if (!result) {
			throw new Error(
				kind === "full"
					? "Scan failed, is scanner initialized?"
					: "Incremental scan failed, is scanner initialized?",
			)
		}
		return { indexed, found, batchErrors }
	}

	private validateFullScan(indexed: number, found: number, batchErrors: Error[]): void {
		const firstError = batchErrors[0]
		if (indexed === 0 && found > 0) {
			throw new Error(
				firstError
					? `Indexing failed: ${firstError.message}`
					: t("embeddings:orchestrator.indexingFailedNoBlocks"),
			)
		}
		if (firstError && (found - indexed) / found > 0.1) {
			throw new Error(
				`Indexing partially failed: Only ${indexed} of ${found} blocks were indexed. ${firstError.message}`,
			)
		}
		if (firstError && indexed === 0) {
			throw new Error(`Indexing failed completely: ${firstError.message}`)
		}
	}
}
