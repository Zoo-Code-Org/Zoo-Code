import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { HistoryItem } from "@roo-code/types"

import { TaskHistoryStore } from "../TaskHistoryStore"
import { acquireFileLock, LOCK_STALE_MS } from "../../../utils/fileLock"

vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	return { ...actual, rename: vi.fn(actual.rename), readFile: vi.fn(actual.readFile) }
})
const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
const entryPoints = ["initialize", "forced reconcile", "invalidate"] as const

describe("TaskHistoryStore interrupted history recovery", () => {
	let root: string
	let store: TaskHistoryStore
	let parent: HistoryItem
	let child: HistoryItem
	let canonical: string
	let backup: string
	let parentPath: string

	beforeEach(async () => {
		vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename)
		vi.mocked(fs.readFile).mockReset().mockImplementation(actual.readFile)
		root = await fs.mkdtemp(path.join(os.tmpdir(), "history-recovery-"))
		parent = {
			id: "parent",
			number: 1,
			ts: 1,
			task: "parent",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			status: "delegated",
			awaitingChildId: "child",
			delegatedToId: "child",
			childIds: ["child"],
		}
		child = {
			...parent,
			id: "child",
			task: "child",
			status: "interrupted",
			parentTaskId: "parent",
			childIds: [],
			awaitingChildId: undefined,
			delegatedToId: undefined,
		}
		parentPath = path.join(root, "tasks", "parent", "history_item.json")
		canonical = path.join(root, "tasks", "child", "history_item.json")
		backup = path.join(path.dirname(canonical), ".history_item.json.bak_interrupted.tmp")
		for (const [file, record] of [
			[parentPath, parent],
			[canonical, child],
		] as const) {
			await fs.mkdir(path.dirname(file), { recursive: true })
			await fs.writeFile(file, JSON.stringify(record))
		}
		store = new TaskHistoryStore(root)
	})

	afterEach(async () => {
		store.dispose()
		vi.restoreAllMocks()
		await fs.rm(root, { recursive: true, force: true })
	})

	async function prepare(entry: (typeof entryPoints)[number]) {
		if (entry !== "initialize") await store.initialize()
		await fs.rename(canonical, backup)
	}

	async function run(entry: (typeof entryPoints)[number]) {
		if (entry === "invalidate") await store.invalidate(child.id)
		else if (entry === "forced reconcile") await store.reconcile({ forceRefresh: true })
		else await store.initialize()
	}

	it.each(entryPoints)("restores an orphaned child before %s can treat it as missing", async (entry) => {
		await prepare(entry)
		await run(entry)
		expect(store.get(child.id)).toEqual(child)
		expect(store.get(parent.id)).toEqual(parent)
		expect(JSON.parse(await fs.readFile(parentPath, "utf8"))).toEqual(parent)
		expect(JSON.parse(await fs.readFile(canonical, "utf8"))).toEqual(child)
		await expect(fs.access(backup)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it.each(entryPoints)("fails %s closed when restoring a child fails", async (entry) => {
		await prepare(entry)
		vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error("restore failed"), { code: "EIO" }))
		await expect(run(entry)).rejects.toMatchObject({ code: "EIO" })
		expect(JSON.parse(await fs.readFile(parentPath, "utf8"))).toEqual(parent)
		expect(JSON.parse(await fs.readFile(backup, "utf8"))).toEqual(child)
		if (entry !== "initialize") expect(store.get(child.id)).toEqual(child)
	})

	it("retries a locked startup without repairing delegation from a partial snapshot", async () => {
		await prepare("initialize")
		const release = await acquireFileLock(canonical)
		const pending = store.initialize()
		try {
			await vi.waitFor(() => expect(store["initializationRetryTimer"]).not.toBeNull(), { timeout: 5_000 })
			expect(store.isHealthy).toBe(false)
			expect(JSON.parse(await fs.readFile(parentPath, "utf8"))).toEqual(parent)
			await expect(fs.access(backup)).resolves.toBeUndefined()
		} finally {
			await release()
		}
		await pending
		expect(store.isHealthy).toBe(true)
		expect(store.get(child.id)).toEqual(child)
		expect(store.get(parent.id)).toEqual(parent)
	})

	it("recovers orphaned history after taking over a stale crash lock", async () => {
		await prepare("initialize")
		await fs.mkdir(`${canonical}.lock`)
		const stale = new Date(Date.now() - LOCK_STALE_MS - 2_000)
		await fs.utimes(`${canonical}.lock`, stale, stale)
		await store.initialize()
		expect(store.get(child.id)).toEqual(child)
		expect(store.get(parent.id)).toEqual(parent)
	})
	it("treats a task path that is no longer a directory as an absent record", async () => {
		await store.initialize()
		await fs.rm(path.dirname(canonical), { recursive: true })
		await fs.writeFile(path.dirname(canonical), "not a task directory")
		await expect(store.reconcile()).resolves.toBeUndefined()
		expect(store.get(child.id)).toBeUndefined()
		expect(store.get(parent.id)).toEqual(parent)
	})
	it.each(
		(["background", "forced", "initialize"] as const).flatMap((entry) =>
			(["EACCES", "EIO", "EISDIR", "null"] as const).map((code) => ({ entry, code })),
		),
	)("keeps unreadable records and completes the $entry scan with $code", async ({ entry, code }) => {
		const gonePath = path.join(root, "tasks", "gone", "history_item.json")
		await fs.mkdir(path.dirname(gonePath), { recursive: true })
		await fs.writeFile(gonePath, JSON.stringify({ ...child, id: "gone" }))
		await store.reconcile()
		await fs.rm(path.dirname(gonePath), { recursive: true })
		const updated = { ...parent, totalCost: parent.totalCost + 1 }
		await fs.writeFile(parentPath, JSON.stringify(updated))
		await fs.utimes(parentPath, new Date(1), new Date(1))
		await fs.utimes(canonical, new Date(2), new Date(2))
		const error = Object.assign(new Error("unreadable task"), { code })
		vi.mocked(fs.readFile).mockImplementation(async (...args) => {
			if (String(args[0]) === canonical) {
				if (code === "null") return "null"
				throw error
			}
			return actual.readFile(...args)
		})
		const repair = vi.fn(store["reconcileDelegationState"].bind(store))
		store["reconcileDelegationState"] = repair
		const result =
			entry === "initialize" ? store.initialize() : store.reconcile({ forceRefresh: entry === "forced" })
		if (entry === "background") await expect(result).resolves.toBeUndefined()
		else if (code === "null") await expect(result).rejects.toBeInstanceOf(TypeError)
		else await expect(result).rejects.toBe(error)
		expect(store.get(child.id)).toEqual(child)
		expect(store.get(parent.id)).toEqual(updated)
		expect(store.get("gone")).toBeUndefined()
		expect(JSON.parse(await actual.readFile(parentPath, "utf8"))).toEqual(updated)
		expect(repair).not.toHaveBeenCalled()
		if (entry === "initialize") expect(store.isHealthy).toBe(false)
	})

	it("preserves a failed restore during background reconciliation", async () => {
		await prepare("forced reconcile")
		vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error("restore failed"), { code: "EIO" }))
		await expect(store.reconcile()).resolves.toBeUndefined()
		expect(store.get(child.id)).toEqual(child)
		expect(JSON.parse(await fs.readFile(backup, "utf8"))).toEqual(child)
	})
})
