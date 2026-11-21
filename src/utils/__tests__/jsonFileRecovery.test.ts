import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as fsSync from "fs"

import { acquireFileLock } from "../fileLock"
import { setPersistenceTraceSink } from "../../core/task-persistence/persistenceTrace"
import { recoverInterruptedReplacement, deleteJsonFile, recoverMissingJsonFile } from "../jsonFileRecovery"
import { LockKeyWalkIncompleteError, resolveLockKey } from "../../services/file-safety/safeWriteText"
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

	// The recency choice is `sort((a, b) => b.mtimeMs - a.mtimeMs)` followed by renaming
	// the head of that list. mtime is the only signal recovery has, so an exact tie says
	// nothing about which backup holds the committed content - the winner would be readdir
	// order, and the loser is unlinked. The tie is set with utimes rather than raced
	// against the clock, so the row does not depend on how fast two writes land; the
	// second row is the control that keeps this from being a test which merely asserts
	// "two backups means reject".
	it("refuses an exact mtime tie between two backups instead of picking by directory order", async () => {
		const otherBackup = path.join(dir, ".history_item.json.bak_2_other.tmp")
		await fs.writeFile(otherBackup, JSON.stringify({ other: true }))
		const shared = new Date(1_700_000_000_000)
		await fs.utimes(backup, shared, shared)
		await fs.utimes(otherBackup, shared, shared)

		const error = await recoverInterruptedReplacement(target).then(
			() => undefined,
			(reason: unknown) => reason,
		)
		expect(error).toMatchObject({
			name: "AmbiguousBackupRecencyError",
			code: "AMBIGUOUS_BACKUP_RECENCY",
			mtimeMs: 1_700_000_000_000,
		})
		// The diagnostic has to name the magnitude it refused to guess about.
		expect(String((error as Error).message)).toContain("share mtime 1700000000000")

		// Fail closed: nothing restored, nothing deleted, so both copies survive for a
		// human to read.
		await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" })
		expect(JSON.parse(await fs.readFile(backup, "utf8"))).toEqual({ committed: true })
		expect(JSON.parse(await fs.readFile(otherBackup, "utf8"))).toEqual({ other: true })
	})

	it("restores the newer backup when two backups have different mtimes", async () => {
		const otherBackup = path.join(dir, ".history_item.json.bak_2_other.tmp")
		await fs.writeFile(otherBackup, JSON.stringify({ other: true }))
		const older = new Date(1_700_000_000_000)
		const newer = new Date(1_700_000_000_001)
		await fs.utimes(otherBackup, older, older)
		await fs.utimes(backup, newer, newer)

		const recovery = await recoverInterruptedReplacement(target)

		expect(recovery.foundLeftovers).toBe(true)
		expect(recovery.restoredFrom).toBe(backup)
		expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ committed: true })
		// The loser of a decided race is still garbage-collected, which is the contract the
		// tie row must not break.
		await expect(fs.access(otherBackup)).rejects.toMatchObject({ code: "ENOENT" })
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

	// The three rows below put resolveLockKey's fail-closed rule in front of a caller rather than
	// asserting it at the function: this file's own delete, which computes the key before it takes
	// the lock and so is the operation that either refuses or proceeds on a key nobody agreed to.
	// The link geometry they need - a referent that is not there, a readlink that is refused, a
	// chain that never answers - is supplied by spies, because this lane cannot build a file symlink
	// for real (fs.symlink answers EPERM here, and the alias rows above say so). Everything else
	// runs on the real filesystem: the lock machinery, the canonicalization inside the walk, and
	// the files the rows assert on.
	it("refuses the delete when the filesystem will not say what the path refers to", async () => {
		await fs.writeFile(target, JSON.stringify({ committed: true }))
		// This spec's unlink double is a vi.fn shared across rows and afterEach restores spies without
		// resetting vi.fn history, so the row clears it before asking whether the delete touched a file.
		vi.mocked(fs.unlink).mockClear()
		const refusal = Object.assign(new Error("EACCES: permission denied, realpath '" + target + "'"), {
			code: "EACCES",
		})
		const realpathSpy = vi.spyOn(fs, "realpath").mockRejectedValueOnce(refusal)
		try {
			await expect(deleteJsonFile(target)).rejects.toBe(refusal)
			// The refusal was the first question the resolution asked, and it is the error the caller
			// receives rather than a wrapped one, so a caller that logs the code still sees EACCES.
			// A restored spy keeps no call history, so the count is read while it is installed.
			expect(realpathSpy).toHaveBeenCalledTimes(1)
		} finally {
			realpathSpy.mockRestore()
		}
		// The key is computed before the lock is taken, so the delete stops before it starts instead
		// of locking a key derived from the caller's own spelling. Nothing was unlinked.
		expect(fs.unlink).not.toHaveBeenCalled()
		expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ committed: true })
		expect(JSON.parse(await fs.readFile(backup, "utf8"))).toEqual({ committed: true })
	})

	it("refuses the delete when reading the link itself is refused", async () => {
		await fs.writeFile(target, JSON.stringify({ committed: true }))
		const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
		vi.mocked(fs.unlink).mockClear()
		// The referent is not there - the window a peer's commit rename opens - so the resolution
		// falls to the walk, and the walk's first readlink is refused. The refusal used to be read as
		// "not a link", which ends the walk and hands back whatever spelling it reached.
		const linkStats = Object.assign(Object.create(fsSync.Stats.prototype) as fsSync.Stats, {
			isSymbolicLink: () => true,
		})
		const refusal = Object.assign(new Error("EACCES: permission denied, readlink '" + target + "'"), {
			code: "EACCES",
		})
		const realpathSpy = vi.spyOn(fs, "realpath").mockRejectedValueOnce(enoent)
		const lstatSpy = vi.spyOn(fs, "lstat").mockResolvedValueOnce(linkStats)
		const readlinkSpy = vi.spyOn(fs, "readlink").mockRejectedValueOnce(refusal)
		try {
			await expect(deleteJsonFile(target)).rejects.toBe(refusal)
			// One readlink, and it is the one that was refused: the walk stopped because the filesystem
			// refused to answer, not because it decided the answer was "not a link". Read while the
			// spy is still installed - restoring it clears the call history.
			expect(readlinkSpy).toHaveBeenCalledTimes(1)
		} finally {
			readlinkSpy.mockRestore()
			lstatSpy.mockRestore()
			realpathSpy.mockRestore()
		}
		expect(fs.unlink).not.toHaveBeenCalled()
		expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ committed: true })
	})

	it("refuses the delete when the link chain stops at the walk's depth bound", async () => {
		await fs.writeFile(target, JSON.stringify({ committed: true }))
		const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
		const linkStats = Object.assign(Object.create(fsSync.Stats.prototype) as fsSync.Stats, {
			isSymbolicLink: () => true,
		})
		vi.mocked(fs.unlink).mockClear()
		const realpathSpy = vi.spyOn(fs, "realpath").mockRejectedValueOnce(enoent)
		const lstatSpy = vi.spyOn(fs, "lstat").mockResolvedValueOnce(linkStats)
		const readlinkSpy = vi.spyOn(fs, "readlink").mockImplementation(async () => "alias.json")
		let failure: unknown
		try {
			failure = await deleteJsonFile(target).then(
				() => undefined,
				(error: unknown) => error,
			)
			// Eight links answered and none of them was an answer. The count is the seam running: a
			// shorter count would mean the row never reached the bound it names. Read before the
			// restores below, which clear the spy's call history.
			expect(readlinkSpy).toHaveBeenCalledTimes(8)
		} finally {
			readlinkSpy.mockRestore()
			lstatSpy.mockRestore()
			realpathSpy.mockRestore()
		}
		expect(failure).toBeInstanceOf(LockKeyWalkIncompleteError)
		if (!(failure instanceof LockKeyWalkIncompleteError)) {
			throw new Error("the depth bound must reject, not resolve :: " + String(failure))
		}
		expect(failure.bound).toBe(8)
		expect(failure.absoluteFilePath).toBe(path.resolve(target))
		expect(path.basename(failure.lastKey)).toBe("alias.json")
		expect(fs.unlink).not.toHaveBeenCalled()
		expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ committed: true })
	})

	// The three rows below need a file symlink. `fs.symlink` on a file answers EPERM on the Windows
	// lane, which has neither privilege nor Developer Mode, and no other Windows spelling carries the
	// meaning: a hard link has no referent for resolveLockKey to follow, and a junction links
	// directories. So these run on the non-Windows lanes - executed there by the ubuntu coverage run,
	// not verified locally - and the claim they pin is a POSIX claim about what an alias delete does.
	const itPosix = it.runIf(process.platform !== "win32")

	itPosix("contends with the writer holding the referent lock when asked for through an alias", async () => {
		const alias = path.join(dir, "history_item_alias.json")
		await fs.writeFile(target, JSON.stringify({ committed: true }))
		await fs.symlink(target, alias)
		// The row is only about the key. If the two spellings did not resolve to the same lock, the
		// delete below would be contending for a name no writer ever takes, and the refusal would
		// prove nothing about the alignment.
		expect(await resolveLockKey(alias)).toBe(await resolveLockKey(target))
		const release = await acquireFileLock(target)
		try {
			await expect(deleteJsonFile(alias)).rejects.toMatchObject({ code: "ELOCKED" })
			// Refused, so it touched nothing: not the referent, and not the backup beside it.
			expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ committed: true })
			expect(JSON.parse(await fs.readFile(backup, "utf8"))).toEqual({ committed: true })
			expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true)
		} finally {
			await release()
		}
		// Once the writer is gone the same call goes through, and it removes the referent.
		await deleteJsonFile(alias)
		await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" })
	})

	itPosix("removes the referent an alias names, leaving the link standing and unreadable", async () => {
		const alias = path.join(dir, "history_item_alias.json")
		await fs.writeFile(target, JSON.stringify({ committed: true }))
		await fs.symlink(target, alias)
		await deleteJsonFile(alias)
		// This is what the alignment costs, and it is a change from unlinking the name the caller
		// passed: the spelling the caller asked about is still there, and reading through it now
		// answers ENOENT because what it pointed at is gone. The leftover prefixes come from the
		// referent's basename too, so the backup is removed under either spelling.
		expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true)
		await expect(fs.stat(alias)).rejects.toMatchObject({ code: "ENOENT" })
		await expect(fs.readFile(alias, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
		await expect(fs.access(backup)).rejects.toMatchObject({ code: "ENOENT" })
	})

	itPosix("asks the referent-side delete for the same lock it asked for before", async () => {
		const alias = path.join(dir, "history_item_alias.json")
		await fs.writeFile(target, JSON.stringify({ committed: true }))
		await fs.symlink(target, alias)
		// Asked for by the referent's own name nothing here is new: that delete already contended
		// with the referent lock, because its key was always the referent. The alignment is only
		// visible from the alias side, which is why the row asserts both halves - the contention that
		// was already there, and the outcome that is unchanged by the change.
		const release = await acquireFileLock(target)
		try {
			await expect(deleteJsonFile(target)).rejects.toMatchObject({ code: "ELOCKED" })
			expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ committed: true })
		} finally {
			await release()
		}
		await deleteJsonFile(target)
		await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" })
		expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true)
		await expect(fs.readFile(alias, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("does not create a missing task directory", async () => {
		await fs.rm(dir, { recursive: true })
		await expect(recoverMissingJsonFile(target)).resolves.toBe(false)
		await expect(fs.stat(dir)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("restores the newest backup when two OLDER backups share a tie", async () => {
		// Three backups: 200, 100, 100. The tie sits BELOW the winner, so recency is decidable
		// and recovery must restore the newest copy and remove both losers. A guard that refused
		// every duplicate mtime - not just a tie for the newest slot - would fail this row, which
		// is what stops the two tie rows above from standing in for "any duplicate means refuse".
		const otherBackup = path.join(dir, ".history_item.json.bak_2_other.tmp")
		const thirdBackup = path.join(dir, ".history_item.json.bak_3_third.tmp")
		await fs.writeFile(otherBackup, JSON.stringify({ other: true }))
		await fs.writeFile(thirdBackup, JSON.stringify({ third: true }))
		const older = new Date(1_700_000_000_100)
		const newest = new Date(1_700_000_000_200)
		await fs.utimes(otherBackup, older, older)
		await fs.utimes(thirdBackup, older, older)
		await fs.utimes(backup, newest, newest)

		const recovery = await recoverInterruptedReplacement(target)

		expect(recovery.foundLeftovers).toBe(true)
		expect(recovery.restoredFrom).toBe(backup)
		expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ committed: true })
		await expect(fs.access(otherBackup)).rejects.toMatchObject({ code: "ENOENT" })
		await expect(fs.access(thirdBackup)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("refuses a tie through the reader entry point and keeps both copies", async () => {
		// The refusal has to survive the path a reader actually takes: recoverMissingJsonFile runs
		// recovery under the lock and reports the failure through the persistence trace. Asserting
		// it here as well keeps a propagation or trace regression from passing while the internal
		// helper row still goes green.
		const otherBackup = path.join(dir, ".history_item.json.bak_2_other.tmp")
		await fs.writeFile(otherBackup, JSON.stringify({ other: true }))
		const shared = new Date(1_700_000_000_000)
		await fs.utimes(backup, shared, shared)
		await fs.utimes(otherBackup, shared, shared)
		const sink = vi.fn()
		setPersistenceTraceSink(sink)

		await expect(recoverMissingJsonFile(target)).rejects.toMatchObject({
			name: "AmbiguousBackupRecencyError",
			code: "AMBIGUOUS_BACKUP_RECENCY",
		})

		expect(sink).toHaveBeenCalledWith(expect.stringContaining('"stage":"json-recovery"'))
		expect(sink).toHaveBeenCalledWith(expect.stringContaining('"result":"failed"'))
		// Fail closed: the tie is still there for a human to decide about.
		await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" })
		expect(JSON.parse(await fs.readFile(backup, "utf8"))).toEqual({ committed: true })
		expect(JSON.parse(await fs.readFile(otherBackup, "utf8"))).toEqual({ other: true })
	})

	it("keeps the tied paths out of the tie error message and on the error properties", async () => {
		// Error telemetry captures message and stack, and a workspace path carries the local
		// username into that capture. The message names the basenames it refused to choose between;
		// the full paths stay on the properties, which is where a human acts on them.
		const otherBackup = path.join(dir, ".history_item.json.bak_2_other.tmp")
		await fs.writeFile(otherBackup, JSON.stringify({ other: true }))
		const shared = new Date(1_700_000_000_000)
		await fs.utimes(backup, shared, shared)
		await fs.utimes(otherBackup, shared, shared)

		const error = await recoverInterruptedReplacement(target).then(
			() => undefined,
			(reason: unknown) => reason,
		)
		const tie = error as Error & { targetPath: string; firstBackupPath: string; secondBackupPath: string }

		expect(tie.name).toBe("AmbiguousBackupRecencyError")
		expect(tie.message).not.toContain(path.sep)
		expect(tie.message).not.toContain(dir)
		expect(tie.message).toContain("history_item.json")
		expect(tie.message).toContain("share mtime 1700000000000")
		expect(tie.targetPath).toBe(target)
		// The two tied files, whatever order readdir handed them in: the guard reports both,
		// and which one lands on which property is not something the caller can rely on.
		expect([tie.firstBackupPath, tie.secondBackupPath].sort()).toEqual([backup, otherBackup].sort())
		expect(tie.message).toContain(path.basename(backup))
		expect(tie.message).toContain(path.basename(otherBackup))
	})
})
