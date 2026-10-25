import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { TaskHistoryStore } from "../TaskHistoryStore"

vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	return { ...actual, readdir: vi.fn(actual.readdir), readFile: vi.fn(actual.readFile) }
})
const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")

describe("TaskHistoryStore initialization retries", () => {
	let root: string
	let store: TaskHistoryStore

	beforeEach(async () => {
		vi.mocked(fs.readdir).mockReset().mockImplementation(actual.readdir)
		vi.mocked(fs.readFile).mockReset().mockImplementation(actual.readFile)
		root = await fs.mkdtemp(path.join(os.tmpdir(), "history-initialization-"))
		store = new TaskHistoryStore(root)
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
	})

	afterEach(async () => {
		store.dispose()
		vi.useRealTimers()
		vi.restoreAllMocks()
		await fs.rm(root, { recursive: true, force: true })
	})

	async function waitForRetry() {
		await vi.waitFor(() => expect(store["initializationRetryTimer"]).not.toBeNull())
	}

	it.each(["ELOCKED", "EBUSY"])(
		"retries %s without publishing readiness or starting observers early",
		async (code) => {
			const reconcile = vi
				.spyOn(store, "reconcile")
				.mockRejectedValueOnce(Object.assign(new Error(code), { code }))
			const settled = vi.fn()
			void store.initialized.then(settled)
			const pending = store.initialize()
			expect(store.initialize()).toBe(pending)
			await waitForRetry()
			expect(store.isHealthy).toBe(false)
			expect(settled).not.toHaveBeenCalled()
			expect(store["fsWatcher"]).toBeNull()
			expect(store["reconcileTimer"]).toBeNull()
			expect(vi.getTimerCount()).toBe(1)

			await vi.advanceTimersByTimeAsync(1_000)
			await pending
			await store.initialized
			expect(store.isHealthy).toBe(true)
			expect(settled).toHaveBeenCalledTimes(1)
			expect(reconcile).toHaveBeenCalledTimes(2)
			await vi.waitFor(() => expect(store["fsWatcher"]).not.toBeNull())
			expect(store["reconcileTimer"]).not.toBeNull()
			await store.initialize()
			expect(reconcile).toHaveBeenCalledTimes(2)
		},
	)

	it.each(["EACCES", "EIO", "EISDIR"])("reports %s as unsuccessful without scheduling retries", async (code) => {
		const reconcile = vi.spyOn(store, "reconcile").mockRejectedValueOnce(Object.assign(new Error(code), { code }))
		await expect(store.initialize()).rejects.toMatchObject({ code })
		await store.initialized
		expect(store.isHealthy).toBe(false)
		expect(reconcile).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)
		expect(store["fsWatcher"]).toBeNull()
	})

	it("does not publish health when listing task directories fails persistently", async () => {
		vi.mocked(fs.readdir).mockRejectedValueOnce(Object.assign(new Error("cannot list history"), { code: "EACCES" }))
		await expect(store.initialize()).rejects.toMatchObject({ code: "EACCES" })
		await store.initialized
		expect(store.isHealthy).toBe(false)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("retries a busy directory listing and then loads history normally", async () => {
		vi.mocked(fs.readdir).mockRejectedValueOnce(Object.assign(new Error("busy history"), { code: "EBUSY" }))
		const pending = store.initialize()
		await waitForRetry()
		expect(store.isHealthy).toBe(false)
		await vi.advanceTimersByTimeAsync(1_000)
		await pending
		expect(store.isHealthy).toBe(true)
		expect(fs.readdir).toHaveBeenCalledTimes(2)
	})

	it.each(["ELOCKED", "EBUSY", "EIO", "EACCES"])("preserves %s from the real repair-intent reader", async (code) => {
		const error = Object.assign(new Error("intent unavailable"), { code })
		vi.mocked(fs.readFile).mockImplementation(async (...args) => {
			if (String(args[0]).endsWith("_delegation_repair_intent.json")) throw error
			return actual.readFile(...args)
		})
		const repair = vi.fn(store["reconcileDelegationState"].bind(store))
		store["reconcileDelegationState"] = repair
		const pending = store.initialize().catch((caught: unknown) => caught)
		if (code === "ELOCKED" || code === "EBUSY") {
			await waitForRetry()
			expect(store.isHealthy).toBe(false)
			vi.mocked(fs.readFile).mockImplementation(actual.readFile)
			await vi.advanceTimersByTimeAsync(1_000)
			expect(await pending).toBeUndefined()
			expect(store.isHealthy).toBe(true)
		} else {
			expect(await pending).toBe(error)
			expect(store.isHealthy).toBe(false)
			expect(repair).not.toHaveBeenCalled()
		}
	})

	it.each(["ELOCKED", "EBUSY", "EIO", "EACCES"])("preserves %s from a delegation repair write", async (code) => {
		const directory = path.join(root, "tasks", "parent")
		await fs.mkdir(directory, { recursive: true })
		await fs.writeFile(
			path.join(directory, "history_item.json"),
			JSON.stringify({
				id: "parent",
				number: 1,
				ts: 1,
				task: "parent",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				status: "delegated",
			}),
		)
		const error = Object.assign(new Error("repair unavailable"), { code })
		const write = vi.fn(store["writeTaskFile"].bind(store)).mockRejectedValueOnce(error)
		store["writeTaskFile"] = write
		const pending = store.initialize().catch((caught: unknown) => caught)
		if (code === "ELOCKED" || code === "EBUSY") {
			await waitForRetry()
			expect(store.isHealthy).toBe(false)
			await vi.advanceTimersByTimeAsync(1_000)
			expect(await pending).toBeUndefined()
			expect(write).toHaveBeenCalledTimes(2)
			expect(store.isHealthy).toBe(true)
		} else {
			expect(await pending).toBe(error)
			expect(store.isHealthy).toBe(false)
			expect(store.get("parent")?.status).toBe("delegated")
		}
	})

	it("caps backoff at eight seconds and gives up after six retries", async () => {
		const error = Object.assign(new Error("busy"), { code: "EBUSY" })
		const reconcile = vi.spyOn(store, "reconcile").mockRejectedValue(error)
		const result = store.initialize().catch((caught: unknown) => caught)
		await waitForRetry()
		for (const [index, delay] of [1_000, 2_000, 4_000, 8_000, 8_000, 8_000].entries()) {
			await vi.advanceTimersByTimeAsync(delay - 1)
			expect(reconcile).toHaveBeenCalledTimes(index + 1)
			await vi.advanceTimersByTimeAsync(1)
			await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(index + 2))
			if (index < 5) await waitForRetry()
		}
		expect(await result).toBe(error)
		await store.initialized
		expect(store.isHealthy).toBe(false)
		expect(vi.getTimerCount()).toBe(0)
		expect(store["fsWatcher"]).toBeNull()
	})

	it("cancels a pending retry on disposal and settles waiters without reporting health", async () => {
		const error = Object.assign(new Error("locked"), { code: "ELOCKED" })
		const reconcile = vi.spyOn(store, "reconcile").mockRejectedValue(error)
		const result = store.initialize().catch((caught: unknown) => caught)
		await waitForRetry()
		store.dispose()
		expect(await result).toBe(error)
		await store.initialized
		await vi.advanceTimersByTimeAsync(60_000)
		expect(store.isHealthy).toBe(false)
		expect(reconcile).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)
	})
})
