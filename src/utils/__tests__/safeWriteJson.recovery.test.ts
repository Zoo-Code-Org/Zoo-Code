import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import * as fileLock from "../fileLock"
import { recoverJsonFile, safeWriteJson, type SafeWriteJsonTrace } from "../safeWriteJson"
import { readTaskMessages, saveTaskMessages } from "../../core/task-persistence/taskMessages"
import { readApiMessages } from "../../core/task-persistence/apiMessages"
import { setPersistenceTraceSink } from "../../core/task-persistence/persistenceTrace"
import { readFileWithMissingRetry } from "../../core/task-persistence/readFileWithMissingRetry"

vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	return {
		...actual,
		access: vi.fn(actual.access),
		rename: vi.fn(actual.rename),
		stat: vi.fn(actual.stat),
		readdir: vi.fn(actual.readdir),
	}
})

const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
const ioError = (code: string) => Object.assign(new Error(code), { code })

describe("interrupted JSON recovery", () => {
	let dir: string
	let canonical: string
	let backup: string

	beforeEach(async () => {
		vi.mocked(fs.access).mockReset().mockImplementation(actual.access)
		vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename)
		vi.mocked(fs.stat).mockReset().mockImplementation(actual.stat)
		vi.mocked(fs.readdir).mockReset().mockImplementation(actual.readdir)
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "json-recovery-"))
		canonical = path.join(dir, "history.json")
		backup = path.join(dir, ".history.json.bak_1_old.tmp")
		await fs.writeFile(backup, JSON.stringify({ committed: true }))
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		setPersistenceTraceSink(undefined)
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("preserves committed backups and aborts before merge when restoration fails", async () => {
		vi.mocked(fs.rename).mockRejectedValueOnce(ioError("EIO"))
		const merge = vi.fn()
		const trace = vi.fn<SafeWriteJsonTrace>()
		await expect(safeWriteJson(canonical, {}, { merge, trace })).rejects.toMatchObject({ code: "EIO" })
		expect(JSON.parse(await fs.readFile(backup, "utf8"))).toEqual({ committed: true })
		expect(merge).not.toHaveBeenCalled()
		expect(trace).toHaveBeenCalledWith({ stage: "recover", detail: "failed: EIO" })
		await expect(fs.access(canonical)).rejects.toMatchObject({ code: "ENOENT" })
		// Failure also releases the lock, allowing the next attempt to recover.
		await expect(safeWriteJson(canonical, {})).resolves.toBeUndefined()
	})

	it.each(["EACCES", "EIO", "EBUSY"])("does not overwrite existing data after access fails with %s", async (code) => {
		await fs.writeFile(canonical, JSON.stringify({ current: true }))
		vi.mocked(fs.access).mockImplementation(async (file, mode) => {
			if (file === canonical) throw ioError(code)
			return actual.access(file, mode)
		})
		await expect(safeWriteJson(canonical, {})).rejects.toMatchObject({ code })
		expect(JSON.parse(await fs.readFile(canonical, "utf8"))).toEqual({ current: true })
		expect(JSON.parse(await fs.readFile(backup, "utf8"))).toEqual({ committed: true })
		expect(fs.rename).not.toHaveBeenCalled()
	})

	it.each(["readdir", "stat"] as const)("preserves backups and stops a write after %s fails", async (operation) => {
		vi.mocked(fs[operation]).mockRejectedValueOnce(ioError("EIO"))
		await expect(safeWriteJson(canonical, {})).rejects.toMatchObject({ code: "EIO" })
		await expect(fs.access(backup)).resolves.toBeUndefined()
		await expect(fs.access(canonical)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("ignores a vanished backup while restoring the newest available committed state", async () => {
		const newer = path.join(dir, ".history.json.bak_2_new.tmp")
		const vanished = path.join(dir, ".history.json.bak_3_gone.tmp")
		await fs.writeFile(newer, JSON.stringify({ newest: true }))
		await fs.writeFile(vanished, "{}")
		await fs.utimes(backup, new Date(1_000), new Date(1_000))
		await fs.utimes(newer, new Date(2_000), new Date(2_000))
		// Make the vanished stat deterministic, regardless of directory order.
		vi.mocked(fs.stat)
			.mockReset()
			.mockImplementation((...args) => {
				if (args[0] === vanished) return Promise.reject(ioError("ENOENT"))
				return actual.stat(...args)
			})
		const merge = vi.fn((existing: unknown) => existing)
		const trace = vi.fn<SafeWriteJsonTrace>()
		await safeWriteJson(canonical, {}, { merge, trace })
		expect(merge).toHaveBeenCalledWith({ newest: true }, {})
		expect(trace).toHaveBeenCalledWith({ stage: "recover", detail: newer })
		expect(JSON.parse(await fs.readFile(canonical, "utf8"))).toEqual({ newest: true })
	})

	it("passes the canonical content to merge and leaves neighboring file leftovers alone", async () => {
		const neighbor = path.join(dir, ".history.json.other.bak_1_old.tmp")
		await fs.writeFile(neighbor, "neighbor")
		await fs.writeFile(canonical, JSON.stringify({ current: true }))
		const merge = vi.fn((existing: unknown) => existing)
		await safeWriteJson(canonical, {}, { merge })
		expect(merge).toHaveBeenCalledWith({ current: true }, {})
		expect(await fs.readFile(neighbor, "utf8")).toBe("neighbor")
	})

	it("heals a missing canonical file on a read without writing incoming data", async () => {
		expect(JSON.parse(await readFileWithMissingRetry(canonical))).toEqual({ committed: true })
		await expect(fs.access(backup)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it.each([
		{ name: "UI", file: "ui_messages.json", read: readTaskMessages },
		{ name: "API", file: "api_conversation_history.json", read: readApiMessages },
	])("restores orphaned $name history through the public reader", async ({ file, read }) => {
		const taskId = "recovery-task"
		const taskDir = path.join(dir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const messages = [{ role: "user", content: "committed", ts: 1, type: "say", text: "committed" }]
		await fs.writeFile(path.join(taskDir, `.${file}.bak_1_old.tmp`), JSON.stringify(messages))
		expect(await read({ taskId, globalStoragePath: dir })).toEqual(messages)
		expect(JSON.parse(await fs.readFile(path.join(taskDir, file), "utf8"))).toEqual(messages)
	})

	it("emits recovery and write traces through the real task-message writer", async () => {
		const taskId = "traced-task"
		const taskDir = path.join(dir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		await fs.writeFile(path.join(taskDir, ".ui_messages.json.bak_1_old.tmp"), "[]")
		const lines: string[] = []
		setPersistenceTraceSink((line) => lines.push(line))
		await saveTaskMessages({ taskId, globalStoragePath: dir, messages: [] })
		const events = lines.map(
			(line) => JSON.parse(line.slice("[persistence-trace] ".length)) as { stage: string; taskId: string },
		)
		expect(events.map((event) => event.stage)).toEqual([
			"ui-messages-recovery",
			"ui-messages-write-start",
			"ui-messages-replacement-rename",
			"ui-messages-write-complete",
		])
		expect(events.every((event) => event.taskId === taskId)).toBe(true)
	})

	it("does not acquire a recovery lock for a genuinely missing file", async () => {
		await fs.unlink(backup)
		const lock = vi.spyOn(fileLock, "withFileLock")
		await expect(readFileWithMissingRetry(canonical)).rejects.toMatchObject({ code: "ENOENT" })
		expect(lock).not.toHaveBeenCalled()
		await expect(fs.access(`${canonical}.lock`)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("preserves missing-file behavior while a first writer holds the lock", async () => {
		await fs.unlink(backup)
		const release = await fileLock.acquireFileLock(canonical)
		try {
			await expect(readFileWithMissingRetry(canonical)).rejects.toMatchObject({ code: "ENOENT" })
			await expect(fs.access(`${canonical}.lock`)).resolves.toBeUndefined()
		} finally {
			await release()
		}
	})

	it.each([readFileWithMissingRetry, recoverJsonFile])("propagates recovery failures to readers", async (read) => {
		vi.mocked(fs.rename).mockRejectedValueOnce(ioError("EIO"))
		await expect(read(canonical)).rejects.toMatchObject({ code: "EIO" })
		await expect(fs.access(backup)).resolves.toBeUndefined()
	})

	it("preserves the committed backup after both replacement and rollback fail", async () => {
		await fs.rename(backup, canonical)
		vi.mocked(fs.rename).mockClear()
		vi.mocked(fs.rename)
			.mockRejectedValueOnce(ioError("EPERM"))
			.mockImplementationOnce(actual.rename)
			.mockRejectedValueOnce(ioError("EIO"))
			.mockRejectedValueOnce(ioError("EBUSY"))
		await expect(safeWriteJson(canonical, { incoming: true })).rejects.toMatchObject({ code: "EIO" })
		const backups = (await fs.readdir(dir)).filter((entry) => entry.includes(".bak_"))
		expect(backups).toHaveLength(1)
		expect(JSON.parse(await fs.readFile(path.join(dir, backups[0]), "utf8"))).toEqual({ committed: true })
		expect(JSON.parse(await readFileWithMissingRetry(canonical))).toEqual({ committed: true })
	})

	it("keeps the canonical file intact when the fallback backup rename fails", async () => {
		await fs.rename(backup, canonical)
		vi.mocked(fs.rename).mockRejectedValueOnce(ioError("EPERM")).mockRejectedValueOnce(ioError("EIO"))
		await expect(safeWriteJson(canonical, {})).rejects.toMatchObject({ code: "EIO" })
		expect(JSON.parse(await fs.readFile(canonical, "utf8"))).toEqual({ committed: true })
	})

	it.each(["write", "read"])("traces recovery failures for a %s without an optional callback", async (operation) => {
		const lines: string[] = []
		setPersistenceTraceSink((line) => lines.push(line))
		vi.mocked(fs.rename).mockRejectedValueOnce(ioError("EIO"))
		const pending = operation === "write" ? safeWriteJson(canonical, {}) : readFileWithMissingRetry(canonical)
		await expect(pending).rejects.toMatchObject({ code: "EIO" })
		expect(lines).toHaveLength(1)
		expect(JSON.parse(lines[0].slice("[persistence-trace] ".length))).toMatchObject({
			stage: "json-recovery-failed",
			filePath: canonical,
			detail: "EIO",
			pid: process.pid,
		})
	})
})
