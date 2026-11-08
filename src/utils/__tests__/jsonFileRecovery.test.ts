import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { acquireFileLock } from "../fileLock"
import { setPersistenceTraceSink } from "../../core/task-persistence/persistenceTrace"
import { deleteJsonFile, recoverMissingJsonFile } from "../jsonFileRecovery"
import { readFileWithMissingRetry } from "../../core/task-persistence/readFileWithMissingRetry"

vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	return { ...actual, readdir: vi.fn(actual.readdir), rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink) }
})

describe("reader recovery", () => {
	let dir: string
	let target: string
	let backup: string
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "json-reader-recovery-"))
		target = path.join(dir, "history_item.json")
		backup = path.join(dir, ".history_item.json.bak_1_saved.tmp")
		await fs.writeFile(backup, JSON.stringify({ committed: true }))
	})
	afterEach(async () => {
		setPersistenceTraceSink(undefined)
		vi.restoreAllMocks()
		await fs.rm(dir, { recursive: true, force: true })
	})

	it.each(["hint-scan", "locked-scan", "restore"] as const)(
		"preserves history after a failed %s and recovers on retry",
		async (step) => {
			const sink = vi.fn()
			setPersistenceTraceSink(sink)
			const error = Object.assign(new Error("Private filesystem detail"), { code: "EIO" })
			if (step === "restore") vi.mocked(fs.rename).mockRejectedValueOnce(error)
			else {
				if (step === "locked-scan") {
					const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
					vi.mocked(fs.readdir).mockImplementationOnce(actual.readdir)
				}
				vi.mocked(fs.readdir).mockRejectedValueOnce(error)
			}
			await expect(readFileWithMissingRetry(target)).rejects.toBe(error)
			expect(sink).toHaveBeenCalledWith(expect.stringContaining('"result":"failed"'))
			expect(JSON.parse(await fs.readFile(backup, "utf8"))).toEqual({ committed: true })
			await expect(fs.readFile(target)).rejects.toMatchObject({ code: "ENOENT" })
			expect(JSON.parse(await readFileWithMissingRetry(target))).toEqual({ committed: true })
		},
	)

	it("rechecks the canonical file under lock and never replaces a newer commit with a stale backup", async () => {
		await fs.writeFile(target, JSON.stringify({ newest: true }))
		await recoverMissingJsonFile(target)
		expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ newest: true })
		await expect(fs.readFile(backup)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("traces reader restoration and lock waiting", async () => {
		const sink = vi.fn()
		setPersistenceTraceSink(sink)
		await readFileWithMissingRetry(target)
		expect(sink).toHaveBeenCalledWith(expect.stringContaining('"stage":"json-lock-wait"'))
		expect(sink).toHaveBeenCalledWith(expect.stringContaining('"result":"restored"'))
	})

	it("does not steal a live writer lock during startup recovery", async () => {
		const release = await acquireFileLock(target)
		try {
			await expect(recoverMissingJsonFile(target, { waitForStaleLock: false })).rejects.toMatchObject({
				code: "ELOCKED",
			})
			expect(await fs.readFile(backup, "utf8")).toContain("committed")
			await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" })
		} finally {
			await release()
		}
		await expect(recoverMissingJsonFile(target)).resolves.toBe(true)
	})

	it("returns false when only an uncommitted replacement exists", async () => {
		await fs.rename(backup, path.join(dir, ".history_item.json.new_1.tmp"))
		await expect(recoverMissingJsonFile(target)).resolves.toBe(false)
	})

	it("deletes backups before the canonical file and prevents resurrection", async () => {
		await fs.writeFile(target, "{}")
		await deleteJsonFile(target)
		await expect(recoverMissingJsonFile(target)).resolves.toBe(false)
		await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" })
		await expect(deleteJsonFile(target)).resolves.toBeUndefined()
	})

	it("preserves the canonical file when deleting a backup fails", async () => {
		await fs.writeFile(target, "committed")
		const error = Object.assign(new Error("unlink failed"), { code: "EACCES" })
		vi.mocked(fs.unlink).mockRejectedValueOnce(error)
		await expect(deleteJsonFile(target)).rejects.toBe(error)
		expect(await fs.readFile(target, "utf8")).toBe("committed")
		await expect(fs.access(backup)).resolves.toBeUndefined()
	})

	it("does not create a missing task directory", async () => {
		await fs.rm(dir, { recursive: true })
		await expect(recoverMissingJsonFile(target)).resolves.toBe(false)
		await expect(fs.stat(dir)).rejects.toMatchObject({ code: "ENOENT" })
	})
})
