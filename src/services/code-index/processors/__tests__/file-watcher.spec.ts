import * as path from "path"
import * as vscode from "vscode"
import { createHash } from "crypto"
import ignore from "ignore"
import { FileWatcher } from "../file-watcher"
import type { CacheManager } from "../../cache-manager"
import type {
	BatchProcessingSummary,
	CodeBlock,
	ICodeParser,
	IEmbedder,
	IVectorStore,
	PointStruct,
} from "../../interfaces"
import { FileFailureRegistry } from "../../file-failure-registry"
import { GenerationAllocator } from "../../generation-allocator"
import { IndexWriteGate, LATE_WRITE_GRACE_MS } from "../../index-write-gate"
import { ParserFatalError } from "../../parser-errors"
import { codeIndexLog } from "../../code-index-log"
import { generateRelativeFilePath } from "../../shared/get-relative-path"
import { MAX_FILE_SIZE_BYTES } from "../../constants"
import { RooIgnoreController } from "../../../../core/ignore/RooIgnoreController"
import { makeExtensionContext, makeUri } from "../../../../test-utils/vscode"
import { clearAllMocks, restoreGlobals } from "../../../../test-utils/reset"

vi.mock("vscode", async () => {
	const { makeEventEmitter, makeUri } = await import("../../../../test-utils/vscode")
	return {
		workspace: { fs: { readFile: vi.fn(), stat: vi.fn() }, createFileSystemWatcher: vi.fn() },
		Uri: { file: makeUri },
		RelativePattern: class {
			constructor(
				public base: string,
				public pattern: string,
			) {}
		},
		EventEmitter: class {
			constructor() {
				return makeEventEmitter()
			}
		},
	}
})
vi.mock("../../../../core/ignore/RooIgnoreController", () => ({
	RooIgnoreController: class {
		validateAccess = vi.fn(() => true)
	},
}))
vi.mock("../../code-index-log", () => ({
	codeIndexLog: {
		redact: (message: string) => message,
		createFailureBatch: vi.fn(() => ({ record: vi.fn(), flush: vi.fn() })),
	},
}))

const workspacePath = path.resolve("watcher-workspace")
const fileA = path.join(workspacePath, "a.ts")
const fileB = path.join(workspacePath, "b.ts")
const hash = (content: string) => createHash("sha256").update(content).digest("hex")
const watchers: FileWatcher[] = []
let handlers: Record<"create" | "change" | "delete", (uri: vscode.Uri) => unknown>
const nativeDispose = vi.fn()

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
		isTracked: vi.fn((filePath: string) => hashes.has(filePath) || openFiles.has(filePath)),
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
		rateLimitScope: "qdrant:watcher-test",
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
		rateLimitScope: "openai:watcher-test",
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
	// The double supplies only the cache lookup, generation reservation, and completion methods used by watcher/writer.
	const cacheManager = cache as unknown as CacheManager
	const generations = new GenerationAllocator(cacheManager)
	const ignored = ignore()
	const access = new RooIgnoreController(workspacePath)
	let currentAttempt = true
	const createWatcher = () => {
		const created = new FileWatcher(
			workspacePath,
			makeExtensionContext(),
			cacheManager,
			embedder,
			store,
			ignored,
			access,
			1,
			parser,
			gate,
			generations,
			failures,
			() => currentAttempt,
		)
		watchers.push(created)
		return created
	}
	return {
		access,
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
		createWatcher,
		watcher: createWatcher(),
		supersede: () => {
			currentAttempt = false
		},
	}
}

beforeEach(() => {
	clearAllMocks()
	vi.useFakeTimers()
	handlers = { create: () => {}, change: () => {}, delete: () => {} }
	vi.mocked(vscode.workspace.fs.readFile).mockReset().mockResolvedValue(Buffer.from("current content"))
	vi.mocked(vscode.workspace.fs.stat).mockReset().mockResolvedValue({ size: 100, type: 1, ctime: 0, mtime: 0 })
	vi.mocked(vscode.workspace.createFileSystemWatcher).mockImplementation(() => ({
		ignoreCreateEvents: false,
		ignoreChangeEvents: false,
		ignoreDeleteEvents: false,
		onDidCreate: (handler) => {
			handlers.create = handler
			return { dispose() {} }
		},
		onDidChange: (handler) => {
			handlers.change = handler
			return { dispose() {} }
		},
		onDidDelete: (handler) => {
			handlers.delete = handler
			return { dispose() {} }
		},
		dispose: nativeDispose,
	}))
})
afterEach(() => {
	for (const watcher of watchers.splice(0)) watcher.dispose()
	restoreGlobals()
	vi.useRealTimers()
})
async function queue(paths = [fileA], type: "create" | "change" | "delete" = "change") {
	for (const filePath of paths) handlers[type](makeUri(filePath))
	await vi.advanceTimersByTimeAsync(500)
}
async function drain() {
	for (let turn = 0; turn < 150; turn++) await Promise.resolve()
}

describe("FileWatcher reliability", () => {
	it("completes public processFile only after every batch, cleanup and exact verification", async () => {
		const { watcher, parser, embedder, cache, store, hashes } = setup()
		const held = deferred<Awaited<ReturnType<IEmbedder["createEmbeddings"]>>>()
		parser.parseFile.mockResolvedValue(blocks(fileA, 3))
		embedder.createEmbeddings.mockImplementationOnce(() => held.promise)
		const pending = watcher.processFile(fileA)
		await drain()
		expect(watcher.isProcessing).toBe(true)
		expect(cache.invalidateFile).toHaveBeenCalledOnce()
		expect(hashes.has(fileA)).toBe(false)
		expect(store.deletePointsByFilePath).not.toHaveBeenCalled()
		held.resolve({ embeddings: [[1]] })
		expect((await pending).status).toBe("success")
		expect(store.upsertPoints).toHaveBeenCalledTimes(3)
		expect(store.countPointsForFile).toHaveBeenCalledOnce()
		expect(hashes.get(fileA)).toBe(hash("current content"))
		expect(watcher.isProcessing).toBe(false)
	})

	it("sets processing before start listeners and stops dispatch when a listener disposes", async () => {
		const { watcher, parser } = setup()
		await watcher.initialize()
		watcher.onDidStartBatchProcessing(() => {
			expect(watcher.isProcessing).toBe(true)
			watcher.dispose()
		})
		await queue()
		expect(parser.parseFile).not.toHaveBeenCalled()
		expect(nativeDispose).toHaveBeenCalledOnce()
	})

	it("initializes once and rejects pre-aborted, disposed and stale work before shared mutations", async () => {
		const { watcher, failures, supersede } = setup()
		await watcher.initialize()
		await watcher.initialize()
		expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledOnce()
		supersede()
		await expect(watcher.processFile(fileA)).rejects.toMatchObject({ name: "AbortError" })
		expect(failures.getRevision("a.ts")).toBeUndefined()
		const other = setup().watcher
		await expect(other.initialize(AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" })
		other.dispose()
		await expect(other.initialize()).rejects.toMatchObject({ name: "AbortError" })
		expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledOnce()
	})

	it.each(["read", "parse"] as const)(
		"records %s once without automatic retry and continues unrelated files",
		async (activity) => {
			const { watcher, parser, failures, hashes } = setup()
			if (activity === "read")
				vi.mocked(vscode.workspace.fs.readFile).mockRejectedValueOnce(new Error("read failed"))
			else parser.parseFile.mockRejectedValueOnce(new Error("parse failed"))
			const finished = vi.fn()
			watcher.onDidFinishBatchProcessing(finished)
			await watcher.initialize()
			await queue([fileA, fileB])
			await vi.advanceTimersByTimeAsync(60_000)
			expect(failures.list()).toEqual([
				expect.objectContaining({ path: "a.ts", activity, attempt: 1, state: "exhausted" }),
			])
			expect(hashes.has(fileB)).toBe(true)
			expect(finished).toHaveBeenCalledOnce()
			expect(vscode.workspace.fs.readFile).toHaveBeenCalledTimes(2)
			const batch = vi.mocked(codeIndexLog.createFailureBatch).mock.results.at(-1)!.value
			expect(batch.record).toHaveBeenCalledOnce()
			expect(batch.flush).toHaveBeenCalledOnce()
		},
	)

	it("does not reparse an exhausted revision until content changes or explicit retry resets it", async () => {
		const { watcher, parser, failures } = setup()
		parser.parseFile.mockRejectedValue(new Error("bad parse"))
		await watcher.processFile(fileA)
		await watcher.processFile(fileA)
		expect(parser.parseFile).toHaveBeenCalledOnce()
		vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from("changed"))
		await watcher.processFile(fileA)
		expect(parser.parseFile).toHaveBeenCalledTimes(2)
		failures.resetAllBudgets()
		parser.parseFile.mockResolvedValue(blocks(fileA))
		expect((await watcher.processFile(fileA)).status).toBe("success")
		expect(failures.list()).toEqual([])
	})

	it.each(["embed", "upsert"] as const)(
		"shares the %s retry allowance across batches and watcher recreation",
		async (activity) => {
			const { watcher, createWatcher, parser, embedder, store, failures } = setup()
			parser.parseFile.mockResolvedValue(blocks(fileA, 2))
			const failure = Object.assign(new Error("temporary"), { status: 503 })
			const target = activity === "embed" ? embedder.createEmbeddings : store.upsertPoints
			target.mockRejectedValueOnce(failure).mockRejectedValueOnce(failure)
			if (activity === "embed")
				embedder.createEmbeddings.mockResolvedValueOnce({ embeddings: [[1]] }).mockRejectedValue(failure)
			else store.upsertPoints.mockResolvedValueOnce(undefined).mockRejectedValue(failure)
			const pending = watcher.processFile(fileA)
			await vi.advanceTimersByTimeAsync(1500)
			expect((await pending).status).toBe("local_error")
			expect(target).toHaveBeenCalledTimes(4)
			expect(failures.getRetryBudget("a.ts", hash("current content"), activity).retriesUsed).toBe(2)
			await createWatcher().processFile(fileA)
			expect(target).toHaveBeenCalledTimes(4)
		},
	)

	it.each([401, 400, 408, 409])("never retries permanent HTTP %s", async (status) => {
		const { watcher, embedder, failures } = setup()
		embedder.createEmbeddings.mockRejectedValue(Object.assign(new Error("permanent"), { status }))
		expect((await watcher.processFile(fileA)).status).toBe("local_error")
		expect(embedder.createEmbeddings).toHaveBeenCalledOnce()
		expect(failures.get("a.ts")).toMatchObject({
			activity: "embed",
			state: "exhausted",
			classification: "permanent",
		})
	})

	it("retries a store request without reembedding and logs every grouped failure", async () => {
		const { watcher, store, embedder, hashes, failures } = setup()
		store.upsertPoints.mockRejectedValueOnce(Object.assign(new Error("temporary"), { status: 503 }))
		await watcher.initialize()
		await queue()
		await vi.advanceTimersByTimeAsync(500 + LATE_WRITE_GRACE_MS)
		expect(store.upsertPoints).toHaveBeenCalledTimes(2)
		expect(embedder.createEmbeddings).toHaveBeenCalledOnce()
		expect(hashes.has(fileA)).toBe(true)
		expect(failures.list()).toEqual([])
		const batch = vi.mocked(codeIndexLog.createFailureBatch).mock.results.at(-1)!.value
		expect(batch.record).toHaveBeenCalledOnce()
		expect(batch.flush).toHaveBeenCalledOnce()
	})

	it.each(["create", "change", "delete"] as const)(
		"filters untracked hidden paths on %s and processes eligible paths",
		async (type) => {
			const { watcher, parser, store, hashes } = setup()
			await watcher.initialize()
			await queue([path.join(workspacePath, ".hidden/file.ts")], type)
			expect(parser.parseFile).not.toHaveBeenCalled()
			expect(store.deletePointsByFilePath).not.toHaveBeenCalled()
			if (type !== "delete") {
				await queue([fileA], type)
				expect(hashes.has(fileA)).toBe(true)
			}
		},
	)

	it.each(["delete", "ignore", "rooignore", "size", "extension"] as const)(
		"removes tracked paths with a fenced generation on %s",
		async (kind) => {
			const { watcher, cache, hashes, store, ignored, access, parser } = setup()
			const filePath = kind === "extension" ? path.join(workspacePath, "a.unsupported") : fileA
			hashes.set(filePath, "previous")
			if (kind === "ignore") ignored.add("a.ts")
			if (kind === "rooignore") vi.mocked(access.validateAccess).mockReturnValue(false)
			if (kind === "size")
				vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({
					size: MAX_FILE_SIZE_BYTES + 1,
					type: 1,
					mtime: 0,
					ctime: 0,
				})
			await watcher.initialize()
			await queue([filePath], kind === "delete" ? "delete" : "change")
			expect(cache.invalidateFile).toHaveBeenCalledWith(filePath)
			expect(store.deletePointsByFilePath).toHaveBeenCalledExactlyOnceWith(filePath, expect.any(Number))
			expect(cache.completeRemoval).toHaveBeenCalledWith(filePath)
			expect(parser.parseFile).not.toHaveBeenCalled()
			expect(hashes.has(filePath)).toBe(false)
		},
	)

	it("removes a registry-only deleted source and retains failed removal until explicit retry", async () => {
		const { watcher, failures, store } = setup()
		failures.renew("a.ts", "unread")
		failures.record("a.ts", "unread", "read", "read failed", 1, "exhausted")
		store.deletePointsByFilePath.mockRejectedValueOnce(new Error("delete failed"))
		await watcher.initialize()
		await queue([fileA], "delete")
		await queue([fileA], "delete")
		expect(store.deletePointsByFilePath).toHaveBeenCalledOnce()
		failures.resetAllBudgets()
		await queue([fileA], "delete")
		expect(store.deletePointsByFilePath).toHaveBeenCalledTimes(2)
		expect(failures.list()).toEqual([])
	})

	it.each(["success", "failure", "fatal"] as const)(
		"suppresses stale parse %s continuations and events",
		async (outcome) => {
			const { watcher, parser, supersede, cache, failures } = setup()
			const held = deferred<CodeBlock[]>()
			parser.parseFile.mockImplementationOnce(() => held.promise)
			const fatal = vi.fn()
			const finished = vi.fn()
			watcher.onParserFatal(fatal)
			watcher.onDidFinishBatchProcessing(finished)
			await watcher.initialize()
			const pending = watcher.processFile(fileA)
			const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
			await drain()
			supersede()
			if (outcome === "success") held.resolve(blocks(fileA))
			else held.reject(outcome === "fatal" ? new ParserFatalError("parser-abort", fileA) : new Error("late"))
			await rejected
			await queue([fileB])
			expect(parser.parseFile).toHaveBeenCalledOnce()
			expect(cache.invalidateFile).not.toHaveBeenCalled()
			expect(failures.list()).toEqual([])
			expect(fatal).not.toHaveBeenCalled()
			expect(finished).not.toHaveBeenCalled()
		},
	)

	it("propagates fatal identity immediately, stops queued dispatch and preserves prior data", async () => {
		const { watcher, parser, hashes, store, failures } = setup()
		const failure = new ParserFatalError("parse-timeout", fileA)
		hashes.set(fileB, "completed")
		parser.parseFile.mockRejectedValueOnce(failure)
		const fatal = vi.fn()
		watcher.onParserFatal(fatal)
		await expect(watcher.processFile(fileA)).rejects.toBe(failure)
		expect(fatal).toHaveBeenCalledExactlyOnceWith(failure)
		expect(failures.get("a.ts")).toMatchObject({ activity: "parse", attempt: 1, state: "exhausted" })
		expect(hashes.get(fileB)).toBe("completed")
		expect(store.clearCollection).not.toHaveBeenCalled()
		await expect(watcher.processFile(fileB)).rejects.toMatchObject({ name: "AbortError" })
	})

	it.each(["dispose", "abort"] as const)(
		"cancels the actual provider signal on %s and drops late results",
		async (action) => {
			const { watcher, embedder, store, failures, cache } = setup()
			const held = deferred<Awaited<ReturnType<IEmbedder["createEmbeddings"]>>>()
			embedder.createEmbeddings.mockImplementationOnce(() => held.promise)
			const owner = new AbortController()
			await watcher.initialize(owner.signal)
			const pending = watcher.processFile(fileA)
			const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
			await drain()
			const signal = embedder.createEmbeddings.mock.calls[0][2]
			if (action === "dispose") watcher.dispose()
			else owner.abort()
			expect(signal?.aborted).toBe(true)
			held.resolve({ embeddings: [[1]] })
			await rejected
			expect(store.upsertPoints).not.toHaveBeenCalled()
			expect(cache.completeFile).not.toHaveBeenCalled()
			expect(failures.list()).toEqual([])
		},
	)

	it("tracks a late store result under the session owner and never completes an aborted file", async () => {
		const { watcher, store, gate, cache, failures } = setup()
		const held = deferred<void>()
		store.upsertPoints.mockImplementationOnce(() => held.promise)
		const owner = new AbortController()
		await watcher.initialize(owner.signal)
		const pending = watcher.processFile(fileA)
		const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
		await drain()
		expect(store.upsertPoints).toHaveBeenCalledOnce()
		expect(gate.hasPending(owner.signal)).toBe(true)
		owner.abort()
		held.resolve(undefined)
		await rejected
		await gate.settled(owner.signal)
		expect(gate.hasPending(owner.signal)).toBe(false)
		expect(cache.completeFile).not.toHaveBeenCalled()
		expect(store.countPointsForFile).not.toHaveBeenCalled()
		expect(failures.list()).toEqual([])
	})

	it.each([
		{ kind: "empty", parsed: [] },
		{ kind: "whitespace", parsed: [{ ...blocks(fileA)[0], content: " \n\t " }] },
	])("completes $kind revisions without embedding", async ({ parsed }) => {
		const { watcher, parser, embedder, store, hashes } = setup()
		parser.parseFile.mockResolvedValue(parsed)
		expect((await watcher.processFile(fileA)).status).toBe("success")
		expect(embedder.createEmbeddings).not.toHaveBeenCalled()
		expect(store.deletePointsByFilePath).toHaveBeenCalledOnce()
		expect(store.countPointsForFile).toHaveBeenCalledOnce()
		expect(hashes.get(fileA)).toBe(hash("current content"))
	})

	it.each(["abort", "dispose", "stale"] as const)(
		"does not classify a session %s during delete as per-file supersession",
		async (action) => {
			const { watcher, hashes, store, failures, cache, supersede } = setup()
			const held = deferred<void>()
			hashes.set(fileA, "previous")
			store.deletePointsByFilePath.mockImplementationOnce(() => held.promise)
			const owner = new AbortController()
			await watcher.initialize(owner.signal)
			const pending = watcher["removeFile"](fileA)
			const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
			await drain()
			if (action === "dispose") watcher.dispose()
			else {
				owner.abort()
				if (action === "stale") supersede()
			}
			held.resolve(undefined)
			await rejected
			expect(cache.completeRemoval).not.toHaveBeenCalled()
			expect(failures.list()).toEqual([])
		},
	)

	it.each(["read", "parse", "embed", "delete", "excluded"] as const)(
		"reports superseded %s work as skipped without a false batch error or completion",
		async (stage) => {
			const { watcher, parser, embedder, store, cache, hashes, openFiles, failures, ignored } = setup()
			const held = deferred<void>()
			hashes.set(fileA, "previous")
			if (stage === "read")
				vi.mocked(vscode.workspace.fs.readFile).mockImplementationOnce(async () => {
					await held.promise
					return Buffer.from("current content")
				})
			else if (stage === "parse")
				parser.parseFile.mockImplementationOnce(async () => {
					await held.promise
					return blocks(fileA)
				})
			else if (stage === "embed")
				embedder.createEmbeddings.mockImplementationOnce(async () => {
					await held.promise
					return { embeddings: [[1]] }
				})
			else {
				if (stage === "excluded") ignored.add("a.ts")
				store.deletePointsByFilePath.mockImplementationOnce(() => held.promise)
			}
			const finished = vi.fn<(summary: BatchProcessingSummary) => void>()
			watcher.onDidFinishBatchProcessing(finished)
			await watcher.initialize()
			await queue([fileA], stage === "delete" ? "delete" : "change")
			expect(finished).not.toHaveBeenCalled()
			handlers.change(makeUri(fileA))
			held.resolve(undefined)
			await drain()
			expect(finished).toHaveBeenCalledExactlyOnceWith({
				processedFiles: [{ path: fileA, status: "skipped", reason: "File change was superseded" }],
				batchError: undefined,
			})
			expect(cache.completeFile).not.toHaveBeenCalled()
			expect(cache.completeRemoval).not.toHaveBeenCalled()
			if (stage === "embed" || stage === "delete" || stage === "excluded") {
				expect(openFiles.has(fileA)).toBe(true)
				expect(hashes.has(fileA)).toBe(false)
			}
			expect(failures.list()).toEqual([])
			await vi.advanceTimersByTimeAsync(500 + LATE_WRITE_GRACE_MS)
			expect(finished).toHaveBeenCalledTimes(2)
			expect(finished.mock.calls[1][0].batchError).toBeUndefined()
			expect(finished.mock.calls[1][0].processedFiles).toEqual([{ path: fileA, status: "success" }])
		},
	)

	it("keeps parser cancellation scoped to the session when a file change is superseded", async () => {
		const { watcher, parser, cache } = setup()
		await watcher.initialize()
		const held = deferred<CodeBlock[]>()
		parser.parseFile.mockReturnValueOnce(held.promise)
		const pending = watcher.processFile(fileA)
		await drain()
		const parseSignal = parser.parseFile.mock.calls[0][1]?.signal
		expect(parseSignal).toBeDefined()
		handlers.change(makeUri(fileA))
		expect(parseSignal?.aborted).toBe(false)
		held.resolve(blocks(fileA))
		await expect(pending).resolves.toMatchObject({ status: "skipped" })
		expect(cache.completeFile).not.toHaveBeenCalled()
		await expect(watcher.processFile(fileA)).resolves.toMatchObject({ status: "success" })
		watcher.dispose()
		expect(parseSignal?.aborted).toBe(true)
	})

	it("preserves a fatal parser failure after the active file change was superseded", async () => {
		const { watcher, parser } = setup()
		await watcher.initialize()
		const reported = vi.fn()
		watcher.onParserFatal(reported)
		const held = deferred<CodeBlock[]>()
		const fatal = new ParserFatalError("parse-timeout", fileA)
		parser.parseFile.mockReturnValueOnce(held.promise)
		const pending = watcher.processFile(fileA).catch((error: unknown) => error)
		await drain()
		handlers.change(makeUri(fileA))
		held.reject(fatal)
		expect(await pending).toBe(fatal)
		expect(reported).toHaveBeenCalledExactlyOnceWith(fatal)
	})

	it("preserves a non-superseded public AbortError instead of treating it as skipped", async () => {
		const { watcher, parser, failures } = setup()
		const failure = new DOMException("parser cancelled", "AbortError")
		parser.parseFile.mockRejectedValueOnce(failure)
		await expect(watcher.processFile(fileA)).rejects.toBe(failure)
		expect(failures.list()).toEqual([])
	})

	it("cancels a long retry wait on revision change without renewing another file", async () => {
		const { watcher, embedder, failures, hashes } = setup()
		embedder.createEmbeddings.mockRejectedValueOnce(
			Object.assign(new Error("limited"), { status: 429, retryAfterMs: 30_000 }),
		)
		await watcher.initialize()
		await queue()
		const oldSignal = embedder.createEmbeddings.mock.calls[0][2]
		failures.renew("b.ts", "other")
		const otherBudget = failures.getRetryBudget("b.ts", "other", "embed")
		otherBudget.retriesUsed = 2
		vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from("new revision"))
		handlers.change(makeUri(fileA))
		expect(oldSignal?.aborted).toBe(true)
		await vi.advanceTimersByTimeAsync(1000)
		// The shared provider pause outlives the cancelled revision.
		expect(hashes.get(fileA)).toBeUndefined()
		await vi.advanceTimersByTimeAsync(28_000)
		expect(hashes.get(fileA)).toBeUndefined()
		expect(embedder.createEmbeddings).toHaveBeenCalledOnce()
		await vi.advanceTimersByTimeAsync(2000)
		expect(hashes.get(fileA)).toBe(hash("new revision"))
		expect(failures.getRetryBudget("b.ts", "other", "embed")).toBe(otherBudget)
		await vi.advanceTimersByTimeAsync(60_000)
		expect(embedder.createEmbeddings).toHaveBeenCalledTimes(2)
	})

	it("cancels an active revision on delete before generation-scoped removal", async () => {
		const { watcher, embedder, hashes, store, failures } = setup()
		embedder.createEmbeddings.mockRejectedValueOnce(Object.assign(new Error("temporary"), { status: 503 }))
		await watcher.initialize()
		await queue()
		const oldSignal = embedder.createEmbeddings.mock.calls[0][2]
		handlers.delete(makeUri(fileA))
		expect(oldSignal?.aborted).toBe(true)
		await vi.advanceTimersByTimeAsync(1000)
		expect(store.deletePointsByFilePath).toHaveBeenCalledOnce()
		expect(hashes.has(fileA)).toBe(false)
		expect(failures.list()).toEqual([])
		await vi.advanceTimersByTimeAsync(60_000)
		expect(embedder.createEmbeddings).toHaveBeenCalledOnce()
	})

	it("keeps verification mismatch and uncertain unchanged content incomplete", async () => {
		const { watcher, hashes, gate, store, parser, cache } = setup()
		hashes.set(fileA, hash("current content"))
		expect((await watcher.processFile(fileA)).status).toBe("skipped")
		gate.recover([fileA])
		store.countPointsForFile.mockResolvedValue({ current: 0, other: 1 })
		expect((await watcher.processFile(fileA)).status).toBe("local_error")
		expect(parser.parseFile).toHaveBeenCalledOnce()
		expect(cache.completeFile).not.toHaveBeenCalled()
		expect(hashes.has(fileA)).toBe(false)
	})

	it("bounds dispatch while allowing an unrelated file to finish independently", async () => {
		const { watcher, parser, hashes } = setup()
		const held = deferred<CodeBlock[]>()
		parser.parseFile.mockImplementation(async (filePath) => (filePath === fileA ? blocks(fileA) : held.promise))
		await watcher.initialize()
		const paths = [
			fileA,
			...Array.from({ length: 11 }, (_, fileNumber) => path.join(workspacePath, `${fileNumber}.ts`)),
		]
		await queue(paths)
		expect(hashes.has(fileA)).toBe(true)
		expect(parser.parseFile).toHaveBeenCalledTimes(11)
		watcher.dispose()
		held.resolve([])
		await drain()
		expect(parser.parseFile).toHaveBeenCalledTimes(11)
	})
})
