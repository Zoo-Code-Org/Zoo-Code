import { CodeIndexScanExecutor } from "../code-index-scan-executor"
import type { IDirectoryScanner } from "../interfaces"
import { ParserFatalError } from "../parser-errors"
import { EmbeddingError, IndexingRetryError } from "../shared/indexing-errors"

vi.mock("../code-index-log", () => ({ codeIndexLog: { info: vi.fn() } }))

function setup() {
	const scanner = { scanDirectory: vi.fn<IDirectoryScanner["scanDirectory"]>() }
	const stateManager = { setSystemState: vi.fn(), reportBlockIndexingProgress: vi.fn() }
	let current = true
	return {
		scanner,
		stateManager,
		supersede: () => {
			current = false
		},
		executor: new CodeIndexScanExecutor("/workspace", scanner, stateManager, () => current),
	}
}

const methods = ["runFullScan", "runIncrementalScan"] as const

describe("CodeIndexScanExecutor", () => {
	it.each(methods)("%s preserves progress and signal wiring", async (method) => {
		const { executor, scanner, stateManager } = setup()
		const signal = new AbortController().signal
		scanner.scanDirectory.mockImplementation(async (directory, _onError, onIndexed, onParsed, receivedSignal) => {
			expect(directory).toBe("/workspace")
			expect(receivedSignal).toBe(signal)
			onParsed?.(2)
			onIndexed?.(1)
			onParsed?.(1)
			onIndexed?.(2)
			return { stats: { processed: 2, skipped: 0 }, totalBlockCount: 3 }
		})
		await expect(executor[method](signal)).resolves.toBe(true)
		expect(stateManager.reportBlockIndexingProgress.mock.calls).toEqual([
			[0, 2, "scan"],
			[1, 2, "scan"],
			[1, 3, "scan"],
			[3, 3, "scan"],
		])
		expect(executor.partial).toBe(false)
	})

	it.each(methods)("%s rejects a missing scanner result", async (method) => {
		const { executor } = setup()
		await expect(executor[method](new AbortController().signal)).rejects.toThrow("is scanner initialized?")
	})

	it.each(methods)("%s propagates genuine scanner failures unchanged", async (method) => {
		const { executor, scanner } = setup()
		const failure = new Error("collection failed")
		scanner.scanDirectory.mockRejectedValue(failure)
		await expect(executor[method](new AbortController().signal)).rejects.toBe(failure)
	})

	it.each(methods)("%s refuses dispatch after cancellation", async (method) => {
		const { executor, scanner, stateManager } = setup()
		const controller = new AbortController()
		controller.abort()
		await expect(executor[method](controller.signal)).resolves.toBe(false)
		expect(scanner.scanDirectory).not.toHaveBeenCalled()
		expect(stateManager.setSystemState).not.toHaveBeenCalled()
	})

	it.each(methods)("%s ignores stopped and superseded callbacks", async (method) => {
		for (const ending of ["stop", "supersede"]) {
			const { executor, scanner, stateManager, supersede } = setup()
			const controller = new AbortController()
			scanner.scanDirectory.mockImplementation(async (_directory, onError, onIndexed, onParsed) => {
				if (ending === "stop") controller.abort()
				else supersede()
				onParsed?.(3)
				onIndexed?.(1)
				onError?.(new ParserFatalError("parser-abort", "bad.ts"))
				return { stats: { processed: 0, skipped: 0 }, totalBlockCount: 3 }
			})
			await expect(executor[method](controller.signal)).resolves.toBe(false)
			expect(stateManager.reportBlockIndexingProgress).not.toHaveBeenCalled()
		}
	})

	it.each(methods)("%s retains file failures as partial regardless of percentage", async (method) => {
		for (const indexed of [0, 8, 9]) {
			const { executor, scanner } = setup()
			scanner.scanDirectory.mockImplementation(async (_directory, onError, onIndexed, onParsed) => {
				onParsed?.(10)
				onIndexed?.(indexed)
				onError?.(new Error("file failed"))
				return { stats: { processed: 1, skipped: 0 }, totalBlockCount: 10, incompleteFiles: ["bad.ts"] }
			})
			await expect(executor[method](new AbortController().signal)).resolves.toBe(true)
			expect(executor.partial).toBe(true)
		}
	})

	it.each(methods)("%s accepts an empty workspace", async (method) => {
		const { executor, scanner } = setup()
		scanner.scanDirectory.mockResolvedValue({ stats: { processed: 0, skipped: 2 }, totalBlockCount: 0 })
		await expect(executor[method](new AbortController().signal)).resolves.toBe(true)
		expect(executor.partial).toBe(false)
	})

	it.each(methods)("%s propagates a typed fatal callback", async (method) => {
		const { executor, scanner } = setup()
		const fatal = new ParserFatalError("parse-timeout", "bad.ts")
		scanner.scanDirectory.mockImplementation(async (_directory, onError) => {
			onError?.(fatal)
			return { stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 }
		})
		await expect(executor[method](new AbortController().signal)).rejects.toBe(fatal)
	})

	it.each([400, 401, 403, 404, 422, 429, 500, undefined])(
		"escalates only all-embedding authentication/configuration HTTP %s failures in a full scan",
		async (status) => {
			const { executor, scanner } = setup()
			const error = new Error("file embedding failed", {
				cause: new IndexingRetryError(
					new EmbeddingError("provider failed", { status }),
					1,
					"permanent",
					"embed",
				),
			})
			scanner.scanDirectory.mockImplementation(async (_directory, onError, _onIndexed, onParsed) => {
				onParsed?.(1)
				onError?.(error)
				return { stats: { processed: 0, skipped: 0 }, totalBlockCount: 1 }
			})
			const result = executor.runFullScan(new AbortController().signal)
			if (status !== undefined && [400, 401, 403, 404, 422].includes(status))
				await expect(result).rejects.toBe(error)
			else {
				await expect(result).resolves.toBe(true)
				expect(executor.partial).toBe(true)
			}
		},
	)

	function embeddingFailure(status: number): Error {
		return new Error("file embedding failed", {
			cause: new IndexingRetryError(new EmbeddingError("provider failed", { status }), 1, "permanent", "embed"),
		})
	}

	it.each([
		{ method: "runIncrementalScan" as const, statuses: [401] },
		{ method: "runFullScan" as const, statuses: [401, 500] },
	])("does not escalate $method with statuses $statuses", async ({ method, statuses }) => {
		const { executor, scanner } = setup()
		scanner.scanDirectory.mockImplementation(async (_directory, onError, _onIndexed, onParsed) => {
			onParsed?.(statuses.length)
			for (const status of statuses) onError?.(embeddingFailure(status))
			return { stats: { processed: 0, skipped: 0 }, totalBlockCount: statuses.length }
		})
		await expect(executor[method](new AbortController().signal)).resolves.toBe(true)
		expect(executor.partial).toBe(true)
	})
})
