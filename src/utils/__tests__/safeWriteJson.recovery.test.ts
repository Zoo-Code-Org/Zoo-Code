import * as fs from "fs/promises"
import { constants } from "fs"
import { execFileSync } from "child_process"
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
		unlink: vi.fn(actual.unlink),
		lstat: vi.fn(actual.lstat),
		open: vi.fn(actual.open),
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
		vi.mocked(fs.unlink).mockReset().mockImplementation(actual.unlink)
		vi.mocked(fs.lstat).mockReset().mockImplementation(actual.lstat)
		vi.mocked(fs.open).mockReset().mockImplementation(actual.open)
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

	// Creating file symlinks requires privileges not guaranteed on Windows CI.
	it.skipIf(process.platform === "win32").each(["recover", "read", "write"] as const)(
		"rejects a symlinked backup through %s without reading its target",
		async (entry) => {
			const secret = path.join(dir, "secrets.json")
			await fs.writeFile(secret, JSON.stringify({ secret: "must not be restored" }))
			await fs.unlink(backup)
			await fs.symlink(secret, backup)
			const merge = vi.fn()
			const pending =
				entry === "recover"
					? recoverJsonFile(canonical)
					: entry === "read"
						? readFileWithMissingRetry(canonical)
						: safeWriteJson(canonical, {}, { merge })
			await expect(pending).rejects.toMatchObject({ code: "EINVAL" })
			expect(merge).not.toHaveBeenCalled()
			await expect(fs.lstat(canonical)).rejects.toMatchObject({ code: "ENOENT" })
			expect((await fs.lstat(backup)).isSymbolicLink()).toBe(true)
			expect(JSON.parse(await fs.readFile(secret, "utf8"))).toEqual({ secret: "must not be restored" })
		},
	)

	it("rejects a directory backup without publishing it", async () => {
		await fs.unlink(backup)
		await fs.mkdir(backup)
		await expect(recoverJsonFile(canonical)).rejects.toMatchObject({ code: "EINVAL" })
		await expect(fs.lstat(canonical)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it.each(["before", "opened", "after"] as const)(
		"rejects non-regular %s metadata even when identity is unchanged",
		async (phase) => {
			let sourceOpened = false
			let checked = false
			vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
				const source = await actual.open(file, flags, mode)
				if (file === backup) {
					sourceOpened = true
					if (phase === "opened") {
						const stats = await source.stat({ bigint: true })
						Object.defineProperty(stats, "isFile", { value: () => false })
						vi.spyOn(source, "stat").mockResolvedValue(stats)
						checked = true
					}
				}
				return source
			})
			vi.mocked(fs.lstat).mockImplementation(async (...args) => {
				const stats = await actual.lstat(...args)
				if (
					args[0] === backup &&
					args[1]?.bigint &&
					phase !== "opened" &&
					sourceOpened === (phase === "after")
				) {
					Object.defineProperty(stats, "isFile", { value: () => false })
					checked = true
				}
				return stats
			})
			await expect(recoverJsonFile(canonical)).rejects.toMatchObject({ code: "EINVAL" })
			expect(checked).toBe(true)
			await expect(fs.access(canonical)).rejects.toMatchObject({ code: "ENOENT" })
			expect(JSON.parse(await fs.readFile(backup, "utf8"))).toEqual({ committed: true })
		},
	)

	it.skipIf(process.platform === "win32" || !constants.O_NOFOLLOW)(
		"refuses a symlink swap at the open syscall",
		async () => {
			const secret = path.join(dir, "secret.json")
			await fs.writeFile(secret, '{"secret":true}')
			vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
				if (file === backup) {
					// Assert before opening: the guard must apply even before descriptor validation.
					expect(typeof flags).toBe("number")
					if (typeof flags === "number") expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW)
					await actual.rename(backup, backup + ".saved")
					await fs.symlink(secret, backup)
				}
				return actual.open(file, flags, mode)
			})
			await expect(recoverJsonFile(canonical)).rejects.toMatchObject({ code: "ELOOP" })
			await expect(fs.access(canonical)).rejects.toMatchObject({ code: "ENOENT" })
			expect(await fs.readFile(secret, "utf8")).toBe('{"secret":true}')
		},
	)

	it.skipIf(process.platform === "win32" || !constants.O_NONBLOCK)(
		"rejects a FIFO swapped in before open without blocking",
		async () => {
			vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
				if (file === backup) {
					// Fail safely before a possibly blocking syscall if this flag is removed.
					expect(typeof flags).toBe("number")
					if (typeof flags === "number") expect(flags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK)
					await actual.rename(backup, backup + ".saved")
					execFileSync("mkfifo", [backup])
				}
				return actual.open(file, flags, mode)
			})
			await expect(recoverJsonFile(canonical)).rejects.toMatchObject({ code: "EINVAL" })
			expect((await fs.lstat(backup)).isFIFO()).toBe(true)
			await expect(fs.access(canonical)).rejects.toMatchObject({ code: "ENOENT" })
			expect(JSON.parse(await fs.readFile(backup + ".saved", "utf8"))).toEqual({ committed: true })
		},
	)

	it.skipIf(process.platform === "win32")("rejects a swapped backup even without O_NOFOLLOW", async () => {
		const secret = path.join(dir, "secrets.json")
		await fs.writeFile(secret, JSON.stringify({ secret: true }))
		vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
			if (file === backup) {
				await fs.rename(backup, backup + ".saved")
				await fs.symlink(secret, backup)
				// Exercise identity validation on platforms without O_NOFOLLOW.
				return actual.open(file, "r", mode)
			}
			return actual.open(file, flags, mode)
		})
		await expect(recoverJsonFile(canonical)).rejects.toMatchObject({ code: "EINVAL" })
		await expect(fs.lstat(canonical)).rejects.toMatchObject({ code: "ENOENT" })
		expect(JSON.parse(await fs.readFile(secret, "utf8"))).toEqual({ secret: true })
	})

	it.skipIf(process.platform === "win32")(
		"copies descriptor bytes when the backup path changes after validation",
		async () => {
			const secret = path.join(dir, "secrets.json")
			await fs.writeFile(secret, JSON.stringify({ secret: true }))
			let swapped = false
			let sourceOpened = false
			vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
				const handle = await actual.open(file, flags, mode)
				if (file === backup) sourceOpened = true
				return handle
			})
			vi.mocked(fs.lstat).mockImplementation(async (...args) => {
				const stats = await actual.lstat(...args)
				if (args[0] === backup && sourceOpened && !swapped) {
					swapped = true
					await fs.rename(backup, backup + ".saved")
					await fs.symlink(secret, backup)
				}
				return stats
			})
			await recoverJsonFile(canonical)
			expect(swapped).toBe(true)
			expect((await fs.lstat(backup + ".saved")).isFile()).toBe(true)
			expect((await fs.lstat(canonical)).isFile()).toBe(true)
			expect(JSON.parse(await fs.readFile(canonical, "utf8"))).toEqual({ committed: true })
			expect(JSON.parse(await fs.readFile(secret, "utf8"))).toEqual({ secret: true })
		},
	)

	it.each(
		(["dev", "ino"] as const).flatMap((field) => (["before", "after"] as const).map((phase) => ({ field, phase }))),
	)("rejects a regular backup with a changed $phase $field identity", async ({ field, phase }) => {
		let sourceOpened = false
		let changed = false
		vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
			const handle = await actual.open(file, flags, mode)
			if (file === backup) sourceOpened = true
			return handle
		})
		vi.mocked(fs.lstat).mockImplementation(async (...args) => {
			const stats = await actual.lstat(...args)
			if (args[0] === backup && args[1]?.bigint && sourceOpened === (phase === "after")) {
				const value = stats[field]
				Object.defineProperty(stats, field, { value: typeof value === "bigint" ? value + 1n : value + 1 })
				changed = true
			}
			return stats
		})
		await expect(recoverJsonFile(canonical)).rejects.toMatchObject({ code: "EINVAL" })
		expect(changed).toBe(true)
		expect(await fs.readdir(dir)).toEqual([path.basename(backup)])
	})

	it.each(["before-open", "after-open"])("rejects a different regular inode swapped %s", async (stage) => {
		let swapped = false
		const swap = async () => {
			await actual.rename(backup, backup + ".saved")
			await fs.writeFile(backup, JSON.stringify({ replacement: true }))
			swapped = true
		}
		vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
			if (file !== backup) return actual.open(file, flags, mode)
			if (stage === "before-open") await swap()
			const source = await actual.open(file, flags, mode)
			if (stage === "after-open") await swap()
			return source
		})
		await expect(recoverJsonFile(canonical)).rejects.toMatchObject({ code: "EINVAL" })
		expect(swapped).toBe(true)
		await expect(fs.access(canonical)).rejects.toMatchObject({ code: "ENOENT" })
		expect((await fs.readdir(dir)).filter((name) => name.includes(".new_"))).toEqual([])
		expect(JSON.parse(await fs.readFile(backup + ".saved", "utf8"))).toEqual({ committed: true })
	})

	it("keeps restored data readable when backup cleanup fails", async () => {
		const error = ioError("EACCES")
		vi.mocked(fs.unlink).mockImplementation(async (file) => {
			if (file === backup) throw error
			return actual.unlink(file)
		})
		const log = vi.spyOn(console, "error").mockImplementation(() => {})
		const lines: string[] = []
		setPersistenceTraceSink((line) => lines.push(line))
		await recoverJsonFile(canonical)
		expect(JSON.parse(await fs.readFile(canonical, "utf8"))).toEqual({ committed: true })
		expect(JSON.parse(await fs.readFile(backup, "utf8"))).toEqual({ committed: true })
		expect(log).toHaveBeenCalledWith(expect.stringContaining("leftover"), error)
		expect(lines.map((line) => JSON.parse(line.slice("[persistence-trace] ".length)))).toContainEqual(
			expect.objectContaining({ stage: "json-cleanup-failed", detail: "EACCES" }),
		)
	})

	it("copies a regular backup across multiple buffers before publishing it", async () => {
		const committed = JSON.stringify({ text: "x".repeat(150 * 1024) })
		await fs.writeFile(backup, committed)
		await recoverJsonFile(canonical)
		expect((await fs.lstat(canonical)).isFile()).toBe(true)
		expect(await fs.readFile(canonical, "utf8")).toBe(committed)
		expect(await fs.readdir(dir)).toEqual(["history.json"])
	})

	it("preserves committed backups and aborts before merge when restoration fails", async () => {
		vi.mocked(fs.rename).mockRejectedValueOnce(ioError("EIO"))
		const merge = vi.fn()
		const trace = vi.fn<SafeWriteJsonTrace>()
		await expect(safeWriteJson(canonical, {}, { merge, trace })).rejects.toMatchObject({ code: "EIO" })
		expect(JSON.parse(await fs.readFile(backup, "utf8"))).toEqual({ committed: true })
		expect(merge).not.toHaveBeenCalled()
		expect((await fs.readdir(dir)).filter((name) => name.includes(".new_"))).toEqual([])
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

	it.each(["readdir", "lstat"] as const)("preserves backups and stops a write after %s fails", async (operation) => {
		vi.mocked(fs[operation]).mockRejectedValueOnce(ioError("EIO"))
		await expect(safeWriteJson(canonical, {})).rejects.toMatchObject({ code: "EIO" })
		await expect(fs.access(backup)).resolves.toBeUndefined()
		await expect(fs.access(canonical)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("breaks equal-mtime backup ties by name and discards incomplete replacements", async () => {
		const newest = path.join(dir, ".history.json.bak_9_new.tmp")
		const incomplete = path.join(dir, ".history.json.new_99_uncommitted.tmp")
		await fs.writeFile(newest, JSON.stringify({ newest: true }))
		await fs.writeFile(incomplete, '{"partial":')
		for (const file of [backup, newest]) await fs.utimes(file, new Date(1_000), new Date(1_000))
		await recoverJsonFile(canonical)
		expect(JSON.parse(await fs.readFile(canonical, "utf8"))).toEqual({ newest: true })
		expect(await fs.readdir(dir)).toEqual(["history.json"])
	})

	it("ignores a vanished backup while restoring the newest available committed state", async () => {
		const newer = path.join(dir, ".history.json.bak_2_new.tmp")
		const vanished = path.join(dir, ".history.json.bak_3_gone.tmp")
		await fs.writeFile(newer, JSON.stringify({ newest: true }))
		await fs.writeFile(vanished, "{}")
		await fs.utimes(backup, new Date(1_000), new Date(1_000))
		await fs.utimes(newer, new Date(2_000), new Date(2_000))
		// Make the vanished stat deterministic, regardless of directory order.
		vi.mocked(fs.lstat)
			.mockReset()
			.mockImplementation((...args) => {
				if (args[0] === vanished) return Promise.reject(ioError("ENOENT"))
				return actual.lstat(...args)
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
			"json-recovered",
			"ui-messages-recovery",
			"ui-messages-write-start",
			"ui-messages-replacement-rename",
			"ui-messages-write-complete",
		])
		expect(
			events.filter((event) => event.stage.startsWith("ui-messages")).every((event) => event.taskId === taskId),
		).toBe(true)
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

	it.each([
		{ name: "retrying reader", read: readFileWithMissingRetry },
		{ name: "recovery helper", read: recoverJsonFile },
	])("propagates recovery failures through the $name", async ({ read }) => {
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
