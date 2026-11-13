import type { IDirectoryScanner, IVectorStore } from "./interfaces"
import type { CodeIndexStateManager } from "./state-manager"

/** Executes scans; cancellation cleanup, watcher startup and completion remain with the orchestrator. */
export class CodeIndexScanExecutor {
	/** True when the last scan finished with file-level failures; those files stay in the failure registry. */
	public partial = false

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
		return this.scanWorkspace(signal, "incremental")
	}

	/** Returns false on returned cancellation; scanner rejections propagate unchanged. */
	async runFullScan(signal: AbortSignal): Promise<boolean> {
		this.stateManager.setSystemState("Indexing", "Services ready. Starting workspace scan...")
		return this.scanWorkspace(signal, "full")
	}

	// File-level failures complete the scan with a partial index instead of failing the whole attempt.
	private async scanWorkspace(signal: AbortSignal, kind: "full" | "incremental"): Promise<boolean> {
		this.partial = false
		await this.vectorStore.markIndexingIncomplete()
		let indexed = 0
		let found = 0
		let failureCount = 0
		const result = await this.scanner.scanDirectory(
			this.workspacePath,
			(fileError: Error) => {
				console.error(
					`[CodeIndexOrchestrator] Error during ${kind === "full" ? "initial" : "incremental"} scan: ${fileError.message}`,
					fileError,
				)
				failureCount++
			},
			(count: number) => {
				if (signal.aborted) return
				indexed += count
				this.stateManager.reportBlockIndexingProgress(indexed, found)
			},
			(count: number) => {
				if (signal.aborted) return
				found += count
				this.stateManager.reportBlockIndexingProgress(indexed, found)
			},
			signal,
		)

		// Cancellation precedes missing-result checks, just as in the orchestrator.
		if (signal.aborted) return false
		if (!result) {
			throw new Error(
				kind === "full"
					? "Scan failed, is scanner initialized?"
					: "Incremental scan failed, is scanner initialized?",
			)
		}
		this.partial = failureCount > 0 || indexed < found
		console.log(`[CodeIndexOrchestrator] ${kind} scan completed: ${indexed} of ${found} blocks indexed`)
		return true
	}
}
