import { CodeIndexScanExecutor } from "../code-index-scan-executor"
import type { IDirectoryScanner } from "../interfaces"

vi.mock("../../../i18n", () => ({ t: (key: string) => key }))

function setup() {
	const scanner = { scanDirectory: vi.fn<IDirectoryScanner["scanDirectory"]>() }
	const vectorStore = { markIndexingIncomplete: vi.fn().mockResolvedValue(undefined) }
	const stateManager = { setSystemState: vi.fn(), reportBlockIndexingProgress: vi.fn() }
	return {
		scanner,
		vectorStore,
		stateManager,
		executor: new CodeIndexScanExecutor("/workspace", scanner, vectorStore, stateManager),
	}
}

describe("CodeIndexScanExecutor", () => {
	it.each(["runFullScan", "runIncrementalScan"] as const)(
		"%s skips failure validation when cancellation occurs during the scan",
		async (method) => {
			const { executor, scanner } = setup()
			const controller = new AbortController()
			scanner.scanDirectory.mockImplementation(async (_path, onError, _onIndexed, onParsed) => {
				onParsed?.(3)
				onError?.(new Error("batch failure"))
				controller.abort()
				return { stats: { processed: 0, skipped: 0 }, totalBlockCount: 3 }
			})
			await expect(executor[method](controller.signal)).resolves.toBe(false)
		},
	)

	it("completes an incremental scan with no changed files", async () => {
		const { executor, scanner } = setup()
		scanner.scanDirectory.mockResolvedValue({ stats: { processed: 0, skipped: 2 }, totalBlockCount: 0 })
		await expect(executor.runIncrementalScan(new AbortController().signal)).resolves.toBe(true)
	})

	it.each(["runFullScan", "runIncrementalScan"] as const)(
		"%s preserves progress and signal wiring",
		async (method) => {
			const { executor, scanner, vectorStore, stateManager } = setup()
			const signal = new AbortController().signal
			scanner.scanDirectory.mockImplementation(async (path, _onError, onIndexed, onParsed, receivedSignal) => {
				expect(path).toBe("/workspace")
				expect(receivedSignal).toBe(signal)
				expect(vectorStore.markIndexingIncomplete).toHaveBeenCalledOnce()
				onParsed?.(2)
				onIndexed?.(1)
				onParsed?.(1)
				onIndexed?.(2)
				return { stats: { processed: 2, skipped: 0 }, totalBlockCount: 3 }
			})
			await expect(executor[method](signal)).resolves.toBe(true)
			expect(stateManager.reportBlockIndexingProgress.mock.calls).toEqual([
				[0, 2],
				[1, 2],
				[1, 3],
				[3, 3],
			])
			expect(stateManager.setSystemState).toHaveBeenCalledExactlyOnceWith(
				"Indexing",
				method === "runFullScan"
					? "Services ready. Starting workspace scan..."
					: "Checking for new or modified files...",
			)
		},
	)

	it.each(["runFullScan", "runIncrementalScan"] as const)("%s rejects missing results", async (method) => {
		const { executor } = setup()
		// An unconfigured mock simulates a scanner violating its return contract.
		await expect(executor[method](new AbortController().signal)).rejects.toThrow(
			method === "runFullScan"
				? "Scan failed, is scanner initialized?"
				: "Incremental scan failed, is scanner initialized?",
		)
	})

	it.each(["runFullScan", "runIncrementalScan"] as const)(
		"%s returns cancellation before validating results",
		async (method) => {
			const { executor, scanner } = setup()
			const controller = new AbortController()
			// Abort before the unconfigured scanner returns a missing result.
			controller.abort()
			await expect(executor[method](controller.signal)).resolves.toBe(false)
			expect(scanner.scanDirectory).toHaveBeenCalledOnce()
		},
	)

	it.each(["runFullScan", "runIncrementalScan"] as const)(
		"%s propagates scanner and marker failures unchanged",
		async (method) => {
			const { executor, scanner, vectorStore } = setup()
			const signal = new AbortController().signal
			const failure = new Error("scan failed")
			scanner.scanDirectory.mockRejectedValueOnce(failure)
			await expect(executor[method](signal)).rejects.toBe(failure)
			const abort = new DOMException("stopped", "AbortError")
			scanner.scanDirectory.mockRejectedValueOnce(abort)
			await expect(executor[method](signal)).rejects.toBe(abort)
			vectorStore.markIndexingIncomplete.mockRejectedValueOnce(failure)
			await expect(executor[method](signal)).rejects.toBe(failure)
			expect(scanner.scanDirectory).toHaveBeenCalledTimes(2)
		},
	)

	const scanCases = (["runFullScan", "runIncrementalScan"] as const).flatMap((method) =>
		[
			{ found: 0, indexed: 0, errors: 0, partial: false },
			{ found: 0, indexed: 0, errors: 1, partial: true },
			{ found: 3, indexed: 3, errors: 0, partial: false },
			{ found: 3, indexed: 0, errors: 3, partial: true },
			{ found: 10, indexed: 1, errors: 9, partial: true },
			{ found: 10, indexed: 8, errors: 0, partial: true },
		].map((scanCase) => ({ method, ...scanCase })),
	)

	it.each(scanCases)(
		"$method completes with a partial index for $indexed/$found blocks and $errors file failures",
		async ({ method, found, indexed, errors, partial }) => {
			const { executor, scanner } = setup()
			scanner.scanDirectory.mockImplementation(async (_path, onError, onIndexed, onParsed) => {
				onParsed?.(found)
				onIndexed?.(indexed)
				for (let iter = 0; iter < errors; iter++) onError?.(new Error("file failure"))
				return { stats: { processed: 1, skipped: 0 }, totalBlockCount: found }
			})
			await expect(executor[method](new AbortController().signal)).resolves.toBe(true)
			expect(executor.partial).toBe(partial)
		},
	)
})
