import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { acquireFileLock } from "../fileLock"
import { setPersistenceTraceSink } from "../../core/task-persistence/persistenceTrace"
import { recoverInterruptedReplacement, deleteJsonFile, recoverMissingJsonFile } from "../jsonFileRecovery"
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

describe("replacement leftover name patterns", () => {
	let dir: string
	let target: string
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "json-recovery-names-"))
		target = path.join(dir, "a.json")
		await fs.writeFile(target, JSON.stringify({ committed: true }))
	})
	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(dir, { recursive: true, force: true })
	})

	// The three names recovery accepts. The first two are the staging and backup
	// names safeWriteJson used before it published through safeWriteText; the third
	// is the name safeWriteText requires of a caller-staged file (.new_*.tmp), with
	// this file's basename embedded after the anchor so the name stays scoped.
	it.each([".a.json.new_1_legacy.tmp", ".a.json.bak_1_legacy.tmp", ".new_a.json_1_staged.tmp"])(
		"garbage collects the accepted leftover named %s when the canonical file exists",
		async (name: string) => {
			const leftover = path.join(dir, name)
			await fs.writeFile(leftover, "stale")
			await expect(recoverMissingJsonFile(target)).resolves.toBe(true)
			expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ committed: true })
			await expect(fs.access(leftover)).rejects.toMatchObject({ code: "ENOENT" })
		},
	)

	// The tail rule is deliberately not uniform across the prefixes, and core/task-persistence/
	// __tests__/TaskHistoryStore.realConcurrency.spec.ts is the reason it may not be: that spec plants
	// `.history_item.json.bak_1.tmp`, a backup from before writers appended a random token, and
	// migration must still recover it. The dot-anchored prefix already pins this file's basename
	// through the literal dot before the kind, so the token stays optional there.
	it("collects a timestamp-only backup name under the dot-anchored prefix", async () => {
		const leftover = path.join(dir, ".a.json.bak_1.tmp")
		await fs.writeFile(leftover, "stale")
		await expect(recoverMissingJsonFile(target)).resolves.toBe(true)
		expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ committed: true })
		await expect(fs.access(leftover)).rejects.toMatchObject({ code: "ENOENT" })
	})

	// The other half of the same rule: on the underscore-anchored staged prefix the token is the only
	// thing that attributes a staged-looking name to this target, so the very same tail shape there
	// is somebody else's in-flight file and must survive.
	// The token a writer can actually be handed: Math.random() === 0 stringifies to "0", so
	// substring(2) answers the empty string and the name ends timestamp-underscore-dot-tmp (measured
	// with node 22.23.4). Under the dot-anchored prefix that name is still this target's own leftover -
	// the literal dot already pins the basename - so recovery has to take it.
	it("collects a dot-anchored backup whose random token came out empty", async () => {
		const leftover = path.join(dir, ".a.json.bak_1730000000000_.tmp")
		await fs.writeFile(leftover, "stale")
		await expect(recoverMissingJsonFile(target)).resolves.toBe(true)
		expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ committed: true })
		await expect(fs.access(leftover)).rejects.toMatchObject({ code: "ENOENT" })
	})

	// The same name on the reader's restore path, which is the half the rows above leave untested: with the
	// target gone the empty-token backup has to be what the reader returns, not merely a name the
	// scanner is willing to unlink.
	it("restores a dot-anchored backup whose random token came out empty", async () => {
		const leftover = path.join(dir, ".a.json.bak_1730000000000_.tmp")
		await fs.unlink(target)
		await fs.writeFile(leftover, JSON.stringify({ committed: true }))
		expect(JSON.parse(await readFileWithMissingRetry(target))).toEqual({ committed: true })
		await expect(fs.access(leftover)).rejects.toMatchObject({ code: "ENOENT" })
	})

	// And the name the writer produces out of that same answer: safeWriteJson guarantees a token, so the
	// staged name carries the empty token's stand-in, and the staged prefix - where the token is the only
	// thing that attributes the name - still recognises it.
	it("collects a staged leftover whose token is the empty-token stand-in", async () => {
		const leftover = path.join(dir, ".new_a.json_1730000000000_0.tmp")
		await fs.writeFile(leftover, "stale")
		await expect(recoverMissingJsonFile(target)).resolves.toBe(true)
		expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ committed: true })
		await expect(fs.access(leftover)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("does not collect a staged-looking name that lacks the token", async () => {
		const unscoped = path.join(dir, ".new_a.json_1.tmp")
		await fs.writeFile(unscoped, "someone else's staging file")
		await expect(recoverMissingJsonFile(target)).resolves.toBe(false)
		expect(await fs.readFile(unscoped, "utf8")).toBe("someone else's staging file")
		expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ committed: true })
	})

	// A shared directory is the failure mode the target-derived prefix exists to
	// prevent: a live writer of b.json holds only b.json's lock, so recovery of a.json
	// must not unlink the staging file that writer is about to rename onto b.json.
	it("leaves a sibling target's staging file alone when two targets share one directory", async () => {
		const sibling = path.join(dir, "b.json")
		await fs.writeFile(sibling, JSON.stringify({ sibling: true }))
		const mine = path.join(dir, ".new_a.json_1_mine.tmp")
		const theirs = path.join(dir, ".new_b.json_2_theirs.tmp")
		await fs.writeFile(mine, "stale")
		await fs.writeFile(theirs, "in flight")
		await expect(recoverMissingJsonFile(target)).resolves.toBe(true)
		await expect(fs.access(mine)).rejects.toMatchObject({ code: "ENOENT" })
		expect(await fs.readFile(theirs, "utf8")).toBe("in flight")
		expect(JSON.parse(await fs.readFile(sibling, "utf8"))).toEqual({ sibling: true })
	})

	// The boundary a prefix check alone misses: a sibling whose basename *starts with* this
	// basename plus an underscore. Its staging name carries this file's prefix, and its writer
	// holds only its own lock, so collecting that name would unlink a live writer's staging file
	// and fail its commit rename with ENOENT.
	it("leaves the staging file of a sibling whose name extends this basename", async () => {
		const sibling = path.join(dir, "a.json_extra.json")
		await fs.writeFile(sibling, JSON.stringify({ sibling: true }))
		const mine = path.join(dir, ".new_a.json_1_mine.tmp")
		const theirs = path.join(dir, ".new_a.json_extra_2_theirs.tmp")
		await fs.writeFile(mine, "stale")
		await fs.writeFile(theirs, "in flight")
		await expect(recoverMissingJsonFile(target)).resolves.toBe(true)
		await expect(fs.access(mine)).rejects.toMatchObject({ code: "ENOENT" })
		expect(await fs.readFile(theirs, "utf8")).toBe("in flight")
		expect(await fs.readFile(sibling, "utf8")).toBe(JSON.stringify({ sibling: true }))
	})

	// The negative boundary: safeWriteText accepts any basename matching .new_*.tmp, so
	// an unscoped name proves nothing about which target staged it, and recovery must
	// not treat it as this target's leftover.
	it("does not collect a bare .new_ staging file that is not scoped to this target", async () => {
		const unscoped = path.join(dir, ".new_unscoped.tmp")
		await fs.writeFile(unscoped, "someone else's staging file")
		await expect(recoverMissingJsonFile(target)).resolves.toBe(false)
		expect(await fs.readFile(unscoped, "utf8")).toBe("someone else's staging file")
		expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ committed: true })
	})
})
