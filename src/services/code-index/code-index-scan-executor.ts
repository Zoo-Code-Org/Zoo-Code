import type { IDirectoryScanner } from "./interfaces"
import type { CodeIndexStateManager } from "./state-manager"
import { ParserFatalError } from "./parser-errors"
import { EmbeddingError, IndexingRetryError, getIndexingErrorStatusCode } from "./shared/indexing-errors"
import { codeIndexLog } from "./code-index-log"

function isEmbeddingConfigurationError(error: Error): boolean {
	let current: unknown = error
	let embedding = false
	const visited = new Set<unknown>()
	while (current instanceof Error && !visited.has(current)) {
		visited.add(current)
		if (
			current instanceof EmbeddingError ||
			(current instanceof IndexingRetryError && current.activity === "embed")
		) {
			embedding = true
		}
		current = current.cause
	}
	const status = getIndexingErrorStatusCode(error)
	return embedding && status !== undefined && [400, 401, 403, 404, 422].includes(status)
}

export class CodeIndexScanExecutor {
	public partial = false

	constructor(
		private readonly workspacePath: string,
		private readonly scanner: IDirectoryScanner,
		private readonly stateManager: Pick<CodeIndexStateManager, "setSystemState" | "reportBlockIndexingProgress">,
		private readonly isCurrentAttempt: () => boolean = () => true,
	) {}

	runIncrementalScan(signal: AbortSignal): Promise<boolean> {
		return this.scanWorkspace(signal, "incremental")
	}

	runFullScan(signal: AbortSignal): Promise<boolean> {
		return this.scanWorkspace(signal, "full")
	}

	private async scanWorkspace(signal: AbortSignal, kind: "full" | "incremental"): Promise<boolean> {
		const isLive = () => !signal.aborted && this.isCurrentAttempt()
		if (!isLive()) return false
		this.partial = false
		this.stateManager.setSystemState(
			"Indexing",
			kind === "full" ? "Services ready. Starting workspace scan..." : "Checking for new or modified files...",
			"scan",
		)
		let indexed = 0
		let found = 0
		const batchErrors: Error[] = []
		const result = await this.scanner.scanDirectory(
			this.workspacePath,
			(error) => {
				if (isLive()) batchErrors.push(error)
			},
			(count) => {
				if (!isLive()) return
				indexed += count
				this.stateManager.reportBlockIndexingProgress(indexed, found, "scan")
			},
			(count) => {
				if (!isLive()) return
				found += count
				this.stateManager.reportBlockIndexingProgress(indexed, found, "scan")
			},
			signal,
		)
		if (!isLive()) return false
		if (!result) {
			throw new Error(
				kind === "full"
					? "Scan failed, is scanner initialized?"
					: "Incremental scan failed, is scanner initialized?",
			)
		}
		const fatal = batchErrors.find((error) => error instanceof ParserFatalError)
		if (fatal) throw fatal
		if (
			kind === "full" &&
			indexed === 0 &&
			found > 0 &&
			batchErrors.length > 0 &&
			batchErrors.every(isEmbeddingConfigurationError)
		) {
			throw batchErrors[0]
		}
		this.partial = batchErrors.length > 0 || (result.incompleteFiles?.length ?? 0) > 0 || indexed < found
		codeIndexLog.info("Scan summary", {
			blocksIndexed: indexed,
			blocksFound: found,
			failureCount: batchErrors.length,
			incompleteFiles: result.incompleteFiles,
		})
		return true
	}
}
