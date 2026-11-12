import * as vscode from "vscode"
import { createHash } from "crypto"
import { CacheManager } from "../cache-manager"
import { safeWriteJson } from "../../../utils/safeWriteJson"
import { codeIndexLog } from "../code-index-log"

vi.mock("../../../utils/safeWriteJson", () => ({ safeWriteJson: vi.fn() }))
vi.mock("../code-index-log", () => ({ codeIndexLog: { error: vi.fn() } }))
vi.mock("vscode", () => ({
	Uri: { joinPath: vi.fn() },
	workspace: { fs: { readFile: vi.fn() } },
}))

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

describe("CacheManager", () => {
	const cachePath = { fsPath: "/storage/cache.json" } as vscode.Uri
	// CacheManager uses only globalStorageUri from the extension context.
	const context = { globalStorageUri: { fsPath: "/storage" } } as vscode.ExtensionContext
	let cache: CacheManager
	let persisted: unknown

	function freshCache() {
		return new CacheManager(context, "/workspace")
	}

	beforeEach(() => {
		vi.useFakeTimers()
		vi.resetAllMocks()
		persisted = undefined
		vi.mocked(vscode.Uri.joinPath).mockReturnValue(cachePath)
		vi.mocked(vscode.workspace.fs.readFile).mockImplementation(async () => {
			if (persisted === undefined) throw new Error("Missing cache")
			return Buffer.from(JSON.stringify(persisted))
		})
		vi.mocked(safeWriteJson).mockImplementation(async (_path, data: unknown) => {
			persisted = structuredClone(data)
		})
		cache = freshCache()
	})

	afterEach(() => {
		vi.clearAllTimers()
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("uses Zoo's workspace-specific hashed cache path", () => {
		const workspaceHash = createHash("sha256").update("/workspace").digest("hex")
		expect(vscode.Uri.joinPath).toHaveBeenCalledWith(
			context.globalStorageUri,
			`roo-index-cache-${workspaceHash}.json`,
		)
	})

	it("loads legacy hashes without inventing a generation watermark or changing path keys", async () => {
		persisted = { "/workspace/file.ts": "hash", "relative.ts": "relative-hash" }
		await cache.initialize()
		expect(cache.loadSucceeded).toBe(true)
		expect(cache.getAllHashes()).toEqual(persisted)
		expect(cache.getHash("/workspace/file.ts")).toBe("hash")
		expect(cache.getHash("file.ts")).toBeUndefined()
		expect(cache.generationWatermark).toBeUndefined()
	})

	it("loads open records ahead of stale hashes and returns independent snapshots", async () => {
		persisted = {
			version: 2,
			fileHashes: { "open.ts": "stale", "complete.ts": "hash" },
			openFiles: { "open.ts": true, "deleted.ts": true },
			generationWatermark: 2048,
		}
		vi.setSystemTime(12345)
		await cache.initialize()
		expect(cache.loadedAt).toBe(12345)
		expect(cache.loadSucceeded).toBe(true)
		expect(cache.generationWatermark).toBe(2048)
		expect(cache.getHash("open.ts")).toBeUndefined()
		expect(cache.getTrackedPaths().sort()).toEqual(["complete.ts", "deleted.ts", "open.ts"])
		const openFiles = cache.getOpenFiles()
		delete openFiles["deleted.ts"]
		const hashes = cache.getAllHashes()
		hashes["complete.ts"] = "changed"
		expect(cache.getOpenFiles()).toEqual({ "open.ts": true, "deleted.ts": true })
		expect(cache.getHash("complete.ts")).toBe("hash")
	})

	it.each([
		undefined,
		"invalid JSON",
		null,
		[],
		{ version: 2, fileHashes: { "file.ts": 4 }, openFiles: {} },
		{ version: 2, fileHashes: {}, openFiles: { "file.ts": false } },
		{ version: 2, fileHashes: [], openFiles: {} },
		{ version: 2, fileHashes: {}, openFiles: [] },
		{ version: 2, fileHashes: {} },
		{ "legacy.ts": 42 },
	])("resets unreadable or invalid cache state (%j)", async (data: unknown) => {
		cache.completeFile("previous.ts", "old")
		persisted = data
		if (data === "invalid JSON") {
			vi.mocked(vscode.workspace.fs.readFile).mockResolvedValueOnce(Buffer.from(data))
		}
		vi.setSystemTime(54321)
		await cache.initialize()
		expect(cache.loadedAt).toBe(54321)
		expect(cache.loadSucceeded).toBe(false)
		expect(cache.getAllHashes()).toEqual({})
		expect(cache.getOpenFiles()).toEqual({})
		expect(cache.generationWatermark).toBeUndefined()
	})

	it.each([0, 2048, Number.MAX_SAFE_INTEGER])("loads a valid watermark %s", async (watermark) => {
		persisted = { version: 2, fileHashes: {}, openFiles: {}, generationWatermark: watermark }
		await cache.initialize()
		expect(cache.loadSucceeded).toBe(true)
		expect(cache.generationWatermark).toBe(watermark)
	})

	it.each([-1, 0.5, "2048", Number.MAX_SAFE_INTEGER + 1, null])(
		"does not trust an invalid watermark %j",
		async (watermark) => {
			persisted = { version: 2, fileHashes: {}, openFiles: {}, generationWatermark: watermark }
			await cache.initialize()
			expect(cache.loadSucceeded).toBe(true)
			expect(cache.generationWatermark).toBeUndefined()
		},
	)

	it("awaits durable invalidation and reloads an unfinished file without a hash", async () => {
		cache.completeFile("file.ts", "hash")
		await cache.flush()
		const held = deferred()
		vi.mocked(safeWriteJson).mockImplementationOnce(async (_path, data: unknown) => {
			await held.promise
			persisted = structuredClone(data)
		})
		const saved = vi.fn()
		const invalidation = cache.invalidateFile("file.ts").then(saved)
		await vi.advanceTimersByTimeAsync(0)
		expect(saved).not.toHaveBeenCalled()
		expect(cache.getHash("file.ts")).toBeUndefined()
		held.resolve()
		await invalidation
		const reloaded = freshCache()
		await reloaded.initialize()
		expect(reloaded.getHash("file.ts")).toBeUndefined()
		expect(reloaded.getOpenFiles()).toEqual({ "file.ts": true })
	})

	it("serializes an already-issued older snapshot before durable invalidation", async () => {
		const held = deferred()
		vi.mocked(safeWriteJson).mockImplementationOnce(async (_path, data: unknown) => {
			await held.promise
			persisted = structuredClone(data)
		})
		cache.completeFile("file.ts", "old")
		await vi.advanceTimersByTimeAsync(1500)
		expect(safeWriteJson).toHaveBeenCalledTimes(1)
		const invalidation = cache.invalidateFile("file.ts")
		await vi.advanceTimersByTimeAsync(0)
		expect(safeWriteJson).toHaveBeenCalledTimes(1)
		held.resolve()
		await invalidation
		expect(persisted).toMatchObject({ fileHashes: {}, openFiles: { "file.ts": true } })
		await vi.advanceTimersByTimeAsync(1500)
		expect(safeWriteJson).toHaveBeenCalledTimes(2)
	})

	it("propagates durable-save failure, retains the open record, and allows a later save", async () => {
		cache.completeFile("file.ts", "hash")
		const failure = new Error("Disk full")
		vi.mocked(safeWriteJson).mockRejectedValueOnce(failure)
		await expect(cache.invalidateFile("file.ts")).rejects.toBe(failure)
		expect(cache.getHash("file.ts")).toBeUndefined()
		expect(cache.getOpenFiles()).toEqual({ "file.ts": true })
		await cache.flush()
		expect(persisted).toMatchObject({ fileHashes: {}, openFiles: { "file.ts": true } })
	})

	it("debounces completion and removes the open record in the same snapshot as its hash", async () => {
		await cache.invalidateFile("file.ts")
		vi.mocked(safeWriteJson).mockClear()
		cache.completeFile("file.ts", "current")
		expect(safeWriteJson).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1499)
		expect(safeWriteJson).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		expect(safeWriteJson).toHaveBeenCalledWith(cachePath.fsPath, {
			version: 2,
			fileHashes: { "file.ts": "current" },
			openFiles: {},
			generationWatermark: undefined,
		})
	})

	it("tracks completed and open files until removal without enumerating paths", async () => {
		const enumerate = vi.spyOn(cache, "getTrackedPaths")
		cache.completeFile("file.ts", "hash")
		expect(cache.isTracked("file.ts")).toBe(true)
		expect(cache.isTracked("missing.ts")).toBe(false)
		expect(cache.isTracked("toString")).toBe(false)
		expect(cache.getHash("toString")).toBeUndefined()
		await cache.invalidateFile("file.ts")
		expect(cache.isTracked("file.ts")).toBe(true)
		expect(cache.getHash("file.ts")).toBeUndefined()
		expect(enumerate).not.toHaveBeenCalled()
		expect(cache.getTrackedPaths()).toEqual(["file.ts"])
		cache.completeRemoval("file.ts")
		await cache.flush()
		expect(cache.isTracked("file.ts")).toBe(false)
		expect(cache.getTrackedPaths()).toEqual([])
		expect(persisted).toMatchObject({ fileHashes: {}, openFiles: {} })
	})

	it("persists the reserved watermark through hash and open-record clears", async () => {
		await cache.reserveGenerations(4096)
		cache.completeFile("complete.ts", "hash")
		await cache.invalidateFile("open.ts")
		await cache.clearCacheFile()
		expect(cache.generationWatermark).toBe(4096)
		expect(persisted).toEqual({ version: 2, fileHashes: {}, openFiles: {}, generationWatermark: 4096 })
		const reloaded = freshCache()
		await reloaded.initialize()
		expect(reloaded.generationWatermark).toBe(4096)
	})

	it("does not acknowledge a reservation before it is durable", async () => {
		const held = deferred()
		vi.mocked(safeWriteJson).mockImplementationOnce(async (_path, data: unknown) => {
			await held.promise
			persisted = structuredClone(data)
		})
		const saved = vi.fn()
		const reservation = cache.reserveGenerations(1024).then(saved)
		await vi.advanceTimersByTimeAsync(0)
		expect(saved).not.toHaveBeenCalled()
		held.resolve()
		await reservation
		expect(persisted).toMatchObject({ generationWatermark: 1024 })
	})

	it.each(["clearCacheFile", "flush", "saveNow"] as const)("propagates %s write errors", async (method) => {
		vi.mocked(safeWriteJson).mockRejectedValueOnce(new Error("Write denied"))
		await expect(cache[method]()).rejects.toThrow("Write denied")
	})

	it("propagates generation reservation failure and permits a later reservation", async () => {
		vi.mocked(safeWriteJson).mockRejectedValueOnce(new Error("Write denied"))
		await expect(cache.reserveGenerations(1024)).rejects.toThrow("Write denied")
		await cache.reserveGenerations(2048)
		expect(persisted).toMatchObject({ generationWatermark: 2048 })
	})

	it("keeps legacy hash mutation aliases compatible with Zoo callers", async () => {
		cache.updateHash("file.ts", "hash")
		expect(cache.getHash("file.ts")).toBe("hash")
		await cache.flush()
		cache.deleteHash("file.ts")
		await cache.flush()
		expect(cache.getHash("file.ts")).toBeUndefined()
		expect(cache.isTracked("file.ts")).toBe(false)
	})

	it("logs debounced-save errors without an unhandled rejection", async () => {
		vi.mocked(safeWriteJson).mockRejectedValueOnce(new Error("Write denied"))
		cache.completeFile("file.ts", "hash")
		await vi.advanceTimersByTimeAsync(1500)
		expect(codeIndexLog.error).toHaveBeenCalledWith("Failed to save cache:", expect.any(Error))
	})
})
