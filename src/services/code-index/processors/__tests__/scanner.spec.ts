import * as path from "path"
import * as vscode from "vscode"
import { Stats } from "fs"
import { stat } from "fs/promises"
import { createHash } from "crypto"
import ignore from "ignore"
import { DirectoryScanner } from "../scanner"
import type { CacheManager } from "../../cache-manager"
import type { CodeBlock, ICodeParser, IEmbedder, IVectorStore, PointStruct } from "../../interfaces"
import { FileFailureRegistry } from "../../file-failure-registry"
import { GenerationAllocator } from "../../generation-allocator"
import { IndexWriteGate, LATE_WRITE_GRACE_MS } from "../../index-write-gate"
import { ParserFatalError } from "../../parser-errors"
import { codeIndexLog } from "../../code-index-log"
import { listFiles } from "../../../glob/list-files"
import { generateRelativeFilePath } from "../../shared/get-relative-path"
import { PARSING_CONCURRENCY, BATCH_PROCESSING_CONCURRENCY, MAX_FILE_SIZE_BYTES } from "../../constants"

import { clearAllMocks, restoreGlobals } from "../../../../test-utils/reset"

vi.mock("fs/promises", () => ({ stat: vi.fn() }))

// Stats has a private constructor in @types/node; the scanner reads only `size`.
const statsOfSize = (size: number): Stats => Object.assign(Object.create(Stats.prototype) as Stats, { size })
vi.mock("vscode", () => ({
	workspace: { fs: { readFile: vi.fn() } },
	Uri: { file: (filePath: string) => ({ fsPath: filePath }) },
}))
vi.mock("../../../../utils/path", () => ({ getWorkspacePathForContext: (directory: string) => directory }))
vi.mock("../../../../core/ignore/RooIgnoreController", () => ({
	RooIgnoreController: class {
		async initialize() {}
		filterPaths(paths: string[]) {
			return paths
		}
	},
}))
vi.mock("../../../glob/list-files", () => ({ listFiles: vi.fn() }))
vi.mock("../../code-index-log", () => ({
	codeIndexLog: {
		redact: (message: string) => message,
		createFailureBatch: vi.fn(() => ({ record: vi.fn(), flush: vi.fn() })),
		info: vi.fn(),
	},
}))

const workspacePath = path.resolve("scanner-workspace")
const fileA = path.join(workspacePath, "a.ts")
const fileB = path.join(workspacePath, "b.ts")
const hash = (content: string) => createHash("sha256").update(content).digest("hex")

function deferred<Value>() {
	let resolve!: (value: Value) => void
	let reject!: (error: Error) => void
	const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

function blocks(filePath: string, count = 1): CodeBlock[] {
	return Array.from({ length: count }, (_, blockNumber) => ({
		file_path: filePath,
		content: `function block${blockNumber}() { return ${blockNumber} }`,
		start_line: blockNumber + 1,
		end_line: blockNumber + 1,
		identifier: null,
		type: "function",
		fileHash: hash("current content"),
		segmentHash: `${filePath}:${blockNumber}`,
	}))
}

function setup() {
	const hashes = new Map<string, string>()
	const openFiles = new Set<string>()
	const points = new Map<string, PointStruct>()
	const cache = {
		generationWatermark: 1024,
		reserveGenerations: vi.fn<CacheManager["reserveGenerations"]>().mockResolvedValue(undefined),
		getHash: vi.fn((filePath: string) => hashes.get(filePath)),
		getTrackedPaths: vi.fn(() => [...new Set([...hashes.keys(), ...openFiles])]),
		invalidateFile: vi.fn(async (filePath: string) => {
			hashes.delete(filePath)
			openFiles.add(filePath)
		}),
		completeFile: vi.fn((filePath: string, revision: string) => {
			hashes.set(filePath, revision)
			openFiles.delete(filePath)
		}),
		completeRemoval: vi.fn((filePath: string) => {
			hashes.delete(filePath)
			openFiles.delete(filePath)
		}),
	}
	const store = {
		rateLimitScope: "qdrant:scanner-test",
		initialize: vi.fn<IVectorStore["initialize"]>().mockResolvedValue(false),
		upsertPoints: vi.fn<IVectorStore["upsertPoints"]>().mockImplementation(async (batch) => {
			for (const point of batch) points.set(point.id, point)
		}),
		deletePointsByFilePath: vi
			.fn<IVectorStore["deletePointsByFilePath"]>()
			.mockImplementation(async (filePath, cutoff) => {
				for (const point of points.values()) {
					const payload: Record<string, unknown> = point.payload
					if (
						payload.filePath === generateRelativeFilePath(filePath, workspacePath) &&
						(typeof payload.generation !== "number" || payload.generation < cutoff)
					)
						points.delete(point.id)
				}
			}),
		deletePointsByMultipleFilePaths: vi
			.fn<IVectorStore["deletePointsByMultipleFilePaths"]>()
			.mockResolvedValue(undefined),
		countPointsForFile: vi
			.fn<IVectorStore["countPointsForFile"]>()
			.mockImplementation(async (filePath, generation) => {
				const selected = [...points.values()]
					.map((point): Record<string, unknown> => point.payload)
					.filter((payload) => payload.filePath === generateRelativeFilePath(filePath, workspacePath))
				return {
					current: selected.filter((payload) => payload.generation === generation).length,
					other: selected.filter((payload) => payload.generation !== generation).length,
				}
			}),
		search: vi.fn<IVectorStore["search"]>().mockResolvedValue([]),
		clearCollection: vi.fn<IVectorStore["clearCollection"]>().mockResolvedValue(undefined),
		deleteCollection: vi.fn<IVectorStore["deleteCollection"]>().mockResolvedValue(undefined),
		collectionExists: vi.fn<IVectorStore["collectionExists"]>().mockResolvedValue(true),
		hasIndexedData: vi.fn<IVectorStore["hasIndexedData"]>().mockResolvedValue(true),
		markIndexingComplete: vi.fn<IVectorStore["markIndexingComplete"]>().mockResolvedValue(undefined),
		markIndexingIncomplete: vi.fn<IVectorStore["markIndexingIncomplete"]>().mockResolvedValue(undefined),
	} satisfies IVectorStore
	const embedder = {
		rateLimitScope: "openai:scanner-test",
		createEmbeddings: vi
			.fn<IEmbedder["createEmbeddings"]>()
			.mockImplementation(async (texts) => ({ embeddings: texts.map(() => [1]) })),
		validateConfiguration: vi.fn<IEmbedder["validateConfiguration"]>().mockResolvedValue({ valid: true }),
		embedderInfo: { name: "openai" },
	} satisfies IEmbedder
	const parser = {
		parseFile: vi.fn<ICodeParser["parseFile"]>().mockImplementation(async (filePath) => blocks(filePath)),
	}
	const failures = new FileFailureRegistry()
	const gate = new IndexWriteGate()
	// The double supplies only the cache lookup, generation reservation, and completion methods used by scanner/writer.
	const cacheManager = cache as unknown as CacheManager
	const generations = new GenerationAllocator(cacheManager)
	const ignored = ignore()
	let currentAttempt = true
	const createScanner = () =>
		new DirectoryScanner(
			embedder,
			store,
			parser,
			cacheManager,
			ignored,
			1,
			gate,
			generations,
			failures,
			workspacePath,
			() => currentAttempt,
		)
	return {
		cache,
		hashes,
		openFiles,
		points,
		store,
		embedder,
		parser,
		failures,
		gate,
		ignored,
		createScanner,
		scanner: createScanner(),
		supersede: () => {
			currentAttempt = false
		},
	}
}

beforeEach(() => {
	vi.useFakeTimers()
	clearAllMocks()
	vi.mocked(stat).mockReset().mockResolvedValue(statsOfSize(100))
	vi.mocked(listFiles)
		.mockReset()
		.mockResolvedValue([[fileA], false])
	vi.mocked(vscode.workspace.fs.readFile).mockReset().mockResolvedValue(Buffer.from("current content"))
})
afterEach(() => {
	restoreGlobals()
	vi.useRealTimers()
})

describe("DirectoryScanner", () => {
	it("preserves callback positions and completes only after all batches and verification", async () => {
		const { scanner, parser, cache, store, points } = setup()
		parser.parseFile.mockResolvedValue(blocks(fileA, 3))
		const held = deferred<void>()
		store.upsertPoints.mockImplementationOnce(async (batch) => {
			await held.promise
			for (const point of batch) points.set(point.id, point)
		})
		const onError = vi.fn()
		const onIndexed = vi.fn()
		const onParsed = vi.fn()
		const pending = scanner.scanDirectory(workspacePath, onError, onIndexed, onParsed)
		await vi.advanceTimersByTimeAsync(0)
		expect(onParsed).toHaveBeenCalledExactlyOnceWith(3)
		expect(cache.completeFile).not.toHaveBeenCalled()
		expect(onIndexed).not.toHaveBeenCalled()
		expect(store.deletePointsByFilePath).not.toHaveBeenCalled()
		held.resolve(undefined)
		expect(await pending).toEqual({ stats: { processed: 1, skipped: 0 }, totalBlockCount: 3, incompleteFiles: [] })
		expect(onIndexed).toHaveBeenCalledExactlyOnceWith(3)
		expect(onError).not.toHaveBeenCalled()
		expect(store.upsertPoints).toHaveBeenCalledTimes(3)
		expect(new Set([...points.keys()]).size).toBe(3)
		expect(cache.completeFile).toHaveBeenCalledExactlyOnceWith(fileA, hash("current content"))
		expect(cache.invalidateFile.mock.invocationCallOrder[0]).toBeLessThan(
			store.upsertPoints.mock.invocationCallOrder[0],
		)
		expect(store.countPointsForFile.mock.invocationCallOrder[0]).toBeLessThan(
			cache.completeFile.mock.invocationCallOrder[0],
		)
		expect(scanner.hasIncompleteFiles).toBe(false)
	})

	it.each(["read", "parse"] as const)(
		"records a single %s failure while unrelated files finish",
		async (activity) => {
			const { scanner, parser, failures, cache } = setup()
			vi.mocked(listFiles).mockResolvedValue([[fileA, fileB], false])
			if (activity === "read") vi.mocked(stat).mockRejectedValueOnce(new Error("read failed"))
			else parser.parseFile.mockRejectedValueOnce(new Error("parse failed"))
			const onError = vi.fn()
			const result = await scanner.scanDirectory(workspacePath, onError)
			expect(result.incompleteFiles).toEqual([fileA])
			expect(onError).toHaveBeenCalledOnce()
			expect(failures.list()).toEqual([
				expect.objectContaining({ path: "a.ts", activity, attempt: 1, state: "exhausted" }),
			])
			expect(cache.completeFile).toHaveBeenCalledExactlyOnceWith(fileB, hash("current content"))
			expect(parser.parseFile).toHaveBeenCalledTimes(activity === "read" ? 1 : 2)
		},
	)

	it("keeps unchanged parse failures exhausted across scanner recreation and renews changed content", async () => {
		const { scanner, parser, failures, createScanner } = setup()
		const recorded = vi.fn<Parameters<FileFailureRegistry["onDidRecord"]>[0]>()
		failures.onDidRecord(recorded)
		const onError = vi.fn<(error: Error) => void>()
		parser.parseFile.mockRejectedValueOnce(new Error("parse failed"))
		await scanner.scanDirectory(workspacePath, onError)
		const repeated = createScanner()
		const result = await repeated.scanDirectory(workspacePath, onError)
		expect(result.incompleteFiles).toEqual([fileA])
		expect(repeated.hasIncompleteFiles).toBe(true)
		expect(recorded).toHaveBeenCalledOnce()
		expect(onError).toHaveBeenCalledTimes(2)
		expect(parser.parseFile).toHaveBeenCalledOnce()
		vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from("changed content"))
		await createScanner().scanDirectory(workspacePath)
		expect(parser.parseFile).toHaveBeenCalledTimes(2)
		expect(failures.list()).toEqual([])
	})

	it.each(["embed", "upsert"] as const)(
		"shares the %s retry allowance across batches and service recreation",
		async (activity) => {
			const { scanner, parser, embedder, store, failures, createScanner, cache } = setup()
			parser.parseFile.mockResolvedValue(blocks(fileA, 2))
			const failure = Object.assign(new Error("unavailable"), { status: 503 })
			if (activity === "embed")
				embedder.createEmbeddings
					.mockRejectedValueOnce(failure)
					.mockResolvedValueOnce({ embeddings: [[1]] })
					.mockRejectedValue(failure)
			else
				store.upsertPoints
					.mockRejectedValueOnce(failure)
					.mockResolvedValueOnce(undefined)
					.mockRejectedValue(failure)
			const pending = scanner.scanDirectory(workspacePath)
			await vi.advanceTimersByTimeAsync(1500)
			expect((await pending).incompleteFiles).toEqual([fileA])
			const request = activity === "embed" ? embedder.createEmbeddings : store.upsertPoints
			expect(request).toHaveBeenCalledTimes(4)
			expect(failures.getRetryBudget("a.ts", hash("current content"), activity).retriesUsed).toBe(2)
			expect(failures.get("a.ts")).toMatchObject({ activity, attempt: 3, state: "exhausted" })
			await createScanner().scanDirectory(workspacePath)
			expect(request).toHaveBeenCalledTimes(4)
			expect(cache.completeFile).not.toHaveBeenCalled()
		},
	)

	it.each([400, 401, 403, 408, 409])("does not retry permanent HTTP %s failures", async (status) => {
		const { scanner, embedder, failures } = setup()
		embedder.createEmbeddings.mockRejectedValue(Object.assign(new Error("permanent"), { status }))
		await scanner.scanDirectory(workspacePath)
		expect(embedder.createEmbeddings).toHaveBeenCalledOnce()
		expect(failures.get("a.ts")).toMatchObject({ activity: "embed", attempt: 1, state: "exhausted" })
	})

	it("keeps parser cancellation scoped to the session when a revision is superseded", async () => {
		const { scanner, parser, failures, cache } = setup()
		const controller = new AbortController()
		const held = deferred<CodeBlock[]>()
		parser.parseFile.mockReturnValueOnce(held.promise)
		const pending = scanner.scanDirectory(workspacePath, undefined, undefined, undefined, controller.signal)
		await vi.advanceTimersByTimeAsync(0)
		const parseSignal = parser.parseFile.mock.calls[0][1]?.signal
		expect(parseSignal).toBe(controller.signal)
		failures.renew("a.ts", "newer revision")
		expect(parseSignal?.aborted).toBe(false)
		held.resolve(blocks(fileA))
		await pending
		expect(cache.completeFile).not.toHaveBeenCalled()
		controller.abort()
		expect(parseSignal?.aborted).toBe(true)
	})

	it("preserves a fatal parser failure after the active revision was superseded", async () => {
		const { scanner, parser, failures } = setup()
		const held = deferred<CodeBlock[]>()
		const fatal = new ParserFatalError("parse-timeout", fileA)
		parser.parseFile.mockReturnValueOnce(held.promise)
		const pending = scanner.scanDirectory(workspacePath).catch((error: unknown) => error)
		await vi.advanceTimersByTimeAsync(0)
		failures.renew("a.ts", "newer revision")
		held.reject(fatal)
		expect(await pending).toBe(fatal)
	})

	it.each([60_000, 61_000])("paces repeated %s ms Retry-After without consuming retries", async (retryAfterMs) => {
		const { scanner, embedder, failures, cache } = setup()
		const limited = Object.assign(new Error("limited"), { status: 429, retryAfterMs })
		embedder.createEmbeddings.mockRejectedValueOnce(limited).mockRejectedValueOnce(limited)
		const pending = scanner.scanDirectory(workspacePath)
		await vi.advanceTimersByTimeAsync(0)
		expect(embedder.createEmbeddings).toHaveBeenCalledOnce()
		expect(failures.list()).toEqual([])
		await vi.advanceTimersByTimeAsync(retryAfterMs - 1)
		expect(embedder.createEmbeddings).toHaveBeenCalledOnce()
		await vi.advanceTimersByTimeAsync(1)
		expect(embedder.createEmbeddings).toHaveBeenCalledTimes(2)
		expect(failures.list()).toEqual([])
		await vi.advanceTimersByTimeAsync(retryAfterMs - 1)
		expect(embedder.createEmbeddings).toHaveBeenCalledTimes(2)
		await vi.advanceTimersByTimeAsync(1)
		expect((await pending).incompleteFiles).toEqual([])
		expect(embedder.createEmbeddings).toHaveBeenCalledTimes(3)
		expect(failures.getRetryBudget("a.ts", hash("current content"), "embed").retriesUsed).toBe(0)
		expect(cache.completeFile).toHaveBeenCalledOnce()
	})

	it("retries saving without reembedding and reports grouped diagnostics", async () => {
		const { scanner, embedder, store, failures } = setup()
		store.upsertPoints.mockRejectedValueOnce(Object.assign(new Error("unavailable"), { status: 503 }))
		const pending = scanner.scanDirectory(workspacePath)
		await vi.advanceTimersByTimeAsync(500 + LATE_WRITE_GRACE_MS)
		expect((await pending).incompleteFiles).toEqual([])
		expect(embedder.createEmbeddings).toHaveBeenCalledOnce()
		expect(store.upsertPoints).toHaveBeenCalledTimes(2)
		expect(failures.list()).toEqual([])
		const batch = vi.mocked(codeIndexLog.createFailureBatch).mock.results.at(-1)?.value
		expect(batch?.record).toHaveBeenCalledOnce()
		expect(batch?.flush).toHaveBeenCalledOnce()
		expect(codeIndexLog.info).toHaveBeenCalledWith(
			"Scan summary",
			expect.objectContaining({ failed: 0, blocksIndexed: 1 }),
		)
	})

	it.each(["parse", "embed", "retry"] as const)(
		"cancels during %s without recording cancellation or late completion",
		async (phase) => {
			const { scanner, parser, embedder, store, cache, failures } = setup()
			const controller = new AbortController()
			const heldParse = deferred<CodeBlock[]>()
			const heldEmbed = deferred<{ embeddings: number[][] }>()
			if (phase === "parse") parser.parseFile.mockReturnValue(heldParse.promise)
			else if (phase === "embed") embedder.createEmbeddings.mockReturnValue(heldEmbed.promise)
			else
				embedder.createEmbeddings.mockRejectedValue(
					Object.assign(new Error("limited"), { status: 429, retryAfterMs: 30_000 }),
				)
			const onError = vi.fn()
			const pending = scanner
				.scanDirectory(workspacePath, onError, undefined, undefined, controller.signal)
				.catch((error: unknown) => error)
			await vi.advanceTimersByTimeAsync(0)
			controller.abort()
			heldParse.resolve(blocks(fileA))
			heldEmbed.resolve({ embeddings: [[1]] })
			expect(await pending).toMatchObject({ name: "AbortError" })
			await vi.advanceTimersByTimeAsync(60_000)
			expect(store.upsertPoints).not.toHaveBeenCalled()
			expect(cache.completeFile).not.toHaveBeenCalled()
			expect(onError).not.toHaveBeenCalled()
			expect(failures.list()).toEqual([])
			expect(embedder.createEmbeddings).toHaveBeenCalledTimes(phase === "parse" ? 0 : 1)
		},
	)

	it("rejects already cancelled scans before discovery or removal", async () => {
		const { scanner, store } = setup()
		const controller = new AbortController()
		controller.abort()
		await expect(
			scanner.scanDirectory(workspacePath, undefined, undefined, undefined, controller.signal),
		).rejects.toMatchObject({ name: "AbortError" })
		expect(listFiles).not.toHaveBeenCalled()
		expect(store.deletePointsByFilePath).not.toHaveBeenCalled()
	})

	it("propagates fatal parser identity immediately and stops queued dispatch", async () => {
		const { scanner, parser, store } = setup()
		const concurrency = Math.min(PARSING_CONCURRENCY, BATCH_PROCESSING_CONCURRENCY)
		const paths = Array.from({ length: concurrency + 2 }, (_, fileNumber) =>
			path.join(workspacePath, `${fileNumber}.ts`),
		)
		vi.mocked(listFiles).mockResolvedValue([paths, false])
		const fatal = new ParserFatalError("parse-timeout", paths[0])
		const held = deferred<CodeBlock[]>()
		parser.parseFile.mockImplementation(async (filePath) => {
			if (filePath === paths[0]) throw fatal
			return held.promise
		})
		const onError = vi.fn()
		await expect(scanner.scanDirectory(workspacePath, onError)).rejects.toBe(fatal)
		held.resolve([])
		await vi.advanceTimersByTimeAsync(0)
		expect(parser.parseFile.mock.calls.length).toBeLessThanOrEqual(concurrency)
		expect(onError).not.toHaveBeenCalled()
		expect(store.upsertPoints).not.toHaveBeenCalled()
	})

	it.each(["success", "failure", "fatal"] as const)(
		"fences late %s parsing from a superseded attempt",
		async (outcome) => {
			const { scanner, parser, supersede, cache, failures } = setup()
			const held = deferred<CodeBlock[]>()
			parser.parseFile.mockReturnValue(held.promise)
			const onError = vi.fn()
			const onParsed = vi.fn()
			const pending = scanner
				.scanDirectory(workspacePath, onError, undefined, onParsed)
				.catch((error: unknown) => error)
			await vi.advanceTimersByTimeAsync(0)
			supersede()
			if (outcome === "success") held.resolve(blocks(fileA))
			else
				held.reject(
					outcome === "fatal" ? new ParserFatalError("parser-abort", fileA) : new Error("late failure"),
				)
			expect(await pending).toMatchObject({ name: "AbortError" })
			expect(failures.list()).toEqual([])
			expect(onError).not.toHaveBeenCalled()
			expect(onParsed).not.toHaveBeenCalled()
			expect(cache.completeFile).not.toHaveBeenCalled()
		},
	)

	it.each(["deleted", "excluded", "oversized"] as const)("fences removal of tracked %s files", async (selection) => {
		const { scanner, hashes, cache, store, ignored } = setup()
		hashes.set(fileA, "old hash")
		if (selection === "deleted") vi.mocked(listFiles).mockResolvedValue([[], false])
		if (selection === "excluded") ignored.add("a.ts")
		if (selection === "oversized") {
			vi.mocked(stat).mockResolvedValue(statsOfSize(MAX_FILE_SIZE_BYTES + 1))
		}
		expect((await scanner.scanDirectory(workspacePath)).incompleteFiles).toEqual([])
		expect(store.deletePointsByFilePath).toHaveBeenCalledExactlyOnceWith(fileA, expect.any(Number))
		expect(cache.invalidateFile).toHaveBeenCalledWith(fileA)
		expect(cache.completeRemoval).toHaveBeenCalledWith(fileA)
	})

	it("cleans registry-only deleted paths and requires explicit retry after failed removal", async () => {
		const { scanner, failures, store } = setup()
		failures.renew("a.ts", "unread")
		failures.record("a.ts", "unread", "read", "read failed", 1, "exhausted")
		vi.mocked(listFiles).mockResolvedValue([[], false])
		store.deletePointsByFilePath.mockRejectedValueOnce(new Error("delete failed"))
		await scanner.scanDirectory(workspacePath)
		await scanner.scanDirectory(workspacePath)
		expect(store.deletePointsByFilePath).toHaveBeenCalledOnce()
		failures.resetAllBudgets()
		const pending = scanner.scanDirectory(workspacePath)
		await vi.advanceTimersByTimeAsync(LATE_WRITE_GRACE_MS)
		await pending
		expect(failures.list()).toEqual([])
	})

	it.each(["empty", "whitespace"] as const)(
		"completes %s files only after cleanup and verification",
		async (kind) => {
			const { scanner, parser, hashes, store, cache, embedder } = setup()
			hashes.set(fileA, "old hash")
			parser.parseFile.mockResolvedValue(kind === "empty" ? [] : [{ ...blocks(fileA)[0], content: " \n\t" }])
			const onIndexed = vi.fn()
			expect((await scanner.scanDirectory(workspacePath, undefined, onIndexed)).incompleteFiles).toEqual([])
			expect(embedder.createEmbeddings).not.toHaveBeenCalled()
			expect(store.deletePointsByFilePath).toHaveBeenCalledExactlyOnceWith(fileA, expect.any(Number))
			expect(store.countPointsForFile).toHaveBeenCalledOnce()
			expect(cache.completeFile).toHaveBeenCalledExactlyOnceWith(fileA, hash("current content"))
			expect(onIndexed).toHaveBeenCalledExactlyOnceWith(0)
		},
	)

	it("checks cancellation after the parsed callback before invalidating or embedding", async () => {
		const { scanner, store, cache, embedder } = setup()
		const controller = new AbortController()
		await expect(
			scanner.scanDirectory(workspacePath, undefined, undefined, () => controller.abort(), controller.signal),
		).rejects.toMatchObject({ name: "AbortError" })
		expect(cache.invalidateFile).not.toHaveBeenCalled()
		expect(embedder.createEmbeddings).not.toHaveBeenCalled()
		expect(store.upsertPoints).not.toHaveBeenCalled()
	})

	it("does not mark verification mismatches complete", async () => {
		const { scanner, store, cache, failures } = setup()
		store.countPointsForFile.mockResolvedValue({ current: 0, other: 1 })
		expect((await scanner.scanDirectory(workspacePath)).incompleteFiles).toEqual([fileA])
		expect(cache.completeFile).not.toHaveBeenCalled()
		expect(failures.get("a.ts")).toMatchObject({ activity: "verify", state: "exhausted" })
	})

	it("skips verified unchanged content but rechecks uncertain content", async () => {
		const { scanner, hashes, parser, gate } = setup()
		hashes.set(fileA, hash("current content"))
		expect((await scanner.scanDirectory(workspacePath)).stats.skipped).toBe(1)
		expect(parser.parseFile).not.toHaveBeenCalled()
		gate.recover([fileA])
		const pending = scanner.scanDirectory(workspacePath)
		await vi.advanceTimersByTimeAsync(LATE_WRITE_GRACE_MS)
		expect((await pending).incompleteFiles).toEqual([])
		expect(parser.parseFile).toHaveBeenCalledOnce()
	})

	it("retains Zoo extension and hidden-directory filtering", async () => {
		const { scanner, parser } = setup()
		const selected = ["README.md", "guide.markdown", "app.js"].map((name) => path.join(workspacePath, name))
		vi.mocked(listFiles).mockResolvedValue([
			[
				...selected,
				path.join(workspacePath, ".hidden", "a.ts"),
				path.join(workspacePath, "image.png"),
				`${workspacePath}/directory/`,
			],
			false,
		])
		await scanner.scanDirectory(workspacePath)
		expect(parser.parseFile.mock.calls.map(([filePath]) => filePath)).toEqual(selected)
	})
})
