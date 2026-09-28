import { CodeIndexScanExecutor } from "../code-index-scan-executor"
import type { IDirectoryScanner } from "../interfaces"

vi.mock("../../../i18n", () => ({ t: (key: string) => key }))

describe("CodeIndexScanExecutor", () => {
	function setup() {
		const scanner = { scanDirectory: vi.fn<IDirectoryScanner["scanDirectory"]>() }
		const vectorStore = { markIndexingIncomplete: vi.fn().mockResolvedValue(undefined) }
		const stateManager = { setSystemState: vi.fn(), reportBlockIndexingProgress: vi.fn() }
		const executor = new CodeIndexScanExecutor("/workspace", scanner, vectorStore, stateManager)
		return { scanner, vectorStore, stateManager, executor }
	}

	it.each(["runFullScan", "runIncrementalScan"] as const)("%s rejects a missing scanner result", async (method) => {
		const { executor } = setup()
		// An unconfigured mock returns undefined, simulating a broken scanner contract.
		await expect(executor[method](new AbortController().signal)).rejects.toThrow(
			method === "runFullScan"
				? "Scan failed, is scanner initialized?"
				: "Incremental scan failed, is scanner initialized?",
		)
	})

	it.each(["runFullScan", "runIncrementalScan"] as const)(
		"%s reports progress without completing the operation",
		async (method) => {
			const { scanner, vectorStore, stateManager, executor } = setup()
			const signal = new AbortController().signal
			scanner.scanDirectory.mockImplementation(async (_path, _onError, onIndexed, onParsed, receivedSignal) => {
				expect(receivedSignal).toBe(signal)
				expect(vectorStore.markIndexingIncomplete).toHaveBeenCalledOnce()
				onParsed?.(3)
				onIndexed?.(1)
				onIndexed?.(2)
				return { stats: { processed: 1, skipped: 0 }, totalBlockCount: 3 }
			})
			await executor[method](signal)
			expect(stateManager.reportBlockIndexingProgress.mock.calls).toEqual([
				[0, 3],
				[1, 3],
				[3, 3],
			])
			expect(stateManager.setSystemState).not.toHaveBeenCalledWith("Indexed", expect.any(String))
		},
	)

	it.each(["runFullScan", "runIncrementalScan"] as const)(
		"%s propagates cancellation to its owner",
		async (method) => {
			const { scanner, executor } = setup()
			const controller = new AbortController()
			scanner.scanDirectory.mockImplementation(async () => {
				controller.abort()
				return { stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 }
			})
			await expect(executor[method](controller.signal)).rejects.toMatchObject({ name: "AbortError" })
		},
	)

	it.each([
		{ method: "runFullScan", rejects: false },
		{ method: "runIncrementalScan", rejects: true },
	] as const)("$method preserves its partial-failure policy", async ({ method, rejects }) => {
		const { scanner, executor } = setup()
		scanner.scanDirectory.mockImplementation(async (_path, onError, onIndexed, onParsed) => {
			onParsed?.(10)
			onIndexed?.(9)
			onError?.(new Error("batch failed"))
			return { stats: { processed: 2, skipped: 0 }, totalBlockCount: 10 }
		})
		const result = executor[method](new AbortController().signal)
		if (rejects) {
			await expect(result).rejects.toThrow("batch failed")
		} else {
			await expect(result).resolves.toBeUndefined()
		}
	})
})
