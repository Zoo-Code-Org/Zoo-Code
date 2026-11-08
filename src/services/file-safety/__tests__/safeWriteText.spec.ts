import * as fs from "fs/promises"
import * as fsSync from "fs"
import { execFile } from "child_process"
import type { ChildProcess } from "child_process"
import * as path from "path"

import { flushPendingBackupRemovals, safeWriteText } from "../safeWriteText"

// Full mock for fs/promises — all methods are vi.fn() stubs
vi.mock("fs/promises", () => ({
	mkdir: vi.fn(),
	access: vi.fn(),
	copyFile: vi.fn(),
	chmod: vi.fn(),
	rename: vi.fn(),
	unlink: vi.fn(),
	realpath: vi.fn(),
	lstat: vi.fn(),
	rmdir: vi.fn(),
}))

// Full mock for fs — all sync methods are vi.fn() stubs. Stats is a bare
// class stub so tests can build minimal Stats stand-ins via its prototype.
vi.mock("fs", () => ({
	openSync: vi.fn(),
	writeSync: vi.fn(),
	closeSync: vi.fn(),
	mkdirSync: vi.fn(),
	fsyncSync: vi.fn(),
	chmodSync: vi.fn(),
	fchmodSync: vi.fn(),
	statSync: vi.fn(),
	Stats: class Stats {},
}))

// Mock child_process.execFile (callback-based — must invoke callback to resolve)
vi.mock("child_process", () => ({
	execFile: vi.fn((cmd, args, opts, cb) => {
		if (typeof cb === "function") cb(null)
	}),
}))

// Minimal stand-in for the ChildProcess that callback-form execFile returns.
const fakeChild = { kill: () => true } as unknown as ChildProcess

// Helper that mirrors safeWriteText's path resolution exactly
function _resolvedTarget(filePath: string): string {
	return path.resolve(filePath)
}
function _dirPath(filePath: string): string {
	return path.dirname(_resolvedTarget(filePath))
}
function _stagingDir(dir: string): string {
	return path.join(dir, ".file-safety-staging")
}

// Minimal Stats stand-in: the SUT only reads `.mode` from it.
// Counts unlinks that targeted a backup path, so a retry loop cannot hide inside a
// total unlink count that also covers the staging temp and the DACL dump.
function _backupUnlinkCalls(): number {
	return vi
		.mocked(fs.unlink)
		.mock.calls.map(([candidate]) => String(candidate))
		.filter((candidate) => candidate.includes("safeWriteText.bak_")).length
}

// A symlink stand-in: only isSymbolicLink and mode are read by safeWriteText.
function _lstatLike(mode: number, symbolic: boolean): fsSync.Stats {
	const s = Object.create(fsSync.Stats.prototype) as fsSync.Stats
	Object.assign(s, { mode, isSymbolicLink: () => symbolic })
	return s
}

function _stats(mode: number): fsSync.Stats {
	const s = Object.create(fsSync.Stats.prototype) as fsSync.Stats
	Object.assign(s, { mode })
	return s
}

// ── Test 1: staging file created then cleaned after success ────────────────

describe("safeWriteText", () => {
	beforeEach(() => {
		vi.resetAllMocks()
		// After resetAllMocks, vi.fn() returns undefined — restore promise defaults.
		vi.mocked(fs.mkdir).mockResolvedValue(undefined)
		vi.mocked(fs.access).mockResolvedValue(undefined)
		// lstat answers ENOENT for a name that does not exist yet, which is the default
		// condition of the create-if-absent cases; the dangling-symlink case overrides it.
		vi.mocked(fs.lstat).mockRejectedValue(
			Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
		)
		vi.mocked(fs.rename).mockResolvedValue(undefined)
		vi.mocked(fs.unlink).mockResolvedValue(undefined)
		// Existing-target default: a regular 0o644 file.
		vi.mocked(fsSync.statSync).mockReturnValue(_stats(0o644))
		// Default sync-write behaviour: report that all requested bytes were
		// written. The Buffer overload passes (fd, buffer, offset, length),
		// so the fourth argument is the requested length.
		vi.mocked(fsSync.writeSync).mockImplementation((...args: unknown[]) =>
			typeof args[3] === "number" ? args[3] : 0,
		)
	})

	// PENDING_BACKUP_REMOVALS is module state, not per-case state: a case whose write retains a
	// backup hands that path to the next case's write, which then unlinks a path it never created.
	// Draining through the exported flush with unlink made to succeed empties the set without
	// reaching for a private symbol, so no case here depends on which cases ran before it.
	afterEach(async () => {
		vi.mocked(fs.unlink).mockResolvedValue(undefined)
		await flushPendingBackupRemovals()
	})

	describe("staging and cleanup", () => {
		it("creates a temp file in the staging dir, fsyncs it, renames to target, and cleans up on success", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1) // fd=1
			vi.mocked(fsSync.closeSync).mockReturnValue(undefined)

			await safeWriteText(targetPath, "hello world", { platform: "linux" })

			// staging dir was created with private permissions — use
			// stringContaining to handle Windows path resolution
			expect(fsSync.mkdirSync).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"), {
				recursive: true,
				mode: 0o700,
			})
			// a pre-existing staging dir is repaired to private permissions too
			expect(fsSync.chmodSync).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"), 0o700)

			// temp file was opened for writing with the existing target's mode
			// (default 0o644 from the statSync default mock)
			expect(fsSync.openSync).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), "w", 0o644)

			// content was written as a buffer (partial-write loop, full write)
			expect(fsSync.writeSync).toHaveBeenCalledWith(1, Buffer.from("hello world", "utf8"), 0, 11)

			// fsync (sync form) was called on the fd
			expect(fsSync.fsyncSync).toHaveBeenCalledWith(1)

			// file was closed
			expect(fsSync.closeSync).toHaveBeenCalledWith(1)

			// atomic rename happened — realpath mock returns targetPath, so that's the dest
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), targetPath)

			// no unlink of temp (it's now the committed file; DACL skipped via platform:linux)
			expect(fs.unlink).not.toHaveBeenCalled()
		})

		it("gives each self-staged write its own staging directory", async () => {
			// A workspace can ship a directory entry named .file-safety-staging, and a
			// shared fixed name is then a path the workspace controls rather than one this
			// write created. Each self-staged write must get its own name.
			const first = "/tmp/test-dir/a.txt"
			const second = "/tmp/test-dir/b.txt"
			vi.mocked(fs.realpath).mockImplementation(async (p) => String(p))
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			await safeWriteText(first, "one", { platform: "linux" })
			await safeWriteText(second, "two", { platform: "linux" })

			const staging = vi
				.mocked(fsSync.mkdirSync)
				.mock.calls.map((c) => String(c[0]))
				.filter((p) => p.includes(".file-safety-staging_"))
			expect(staging).toHaveLength(2)
			expect(staging[0]).not.toBe(staging[1])
			for (const sd of staging) expect(sd).toMatch(/\.file-safety-staging_\d+_[a-z0-9]+$/)
		})

		it("removes the staging directory after the commit lands", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			await safeWriteText(targetPath, "data", { platform: "linux" })

			// The directory only exists to hold this write's temp file, so a successful publish
			// must not leave it behind in the user's workspace.
			expect(fs.rmdir).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"))
		})

		it("surfaces a failed staging open once, without re-creating a directory it cannot recover", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
			vi.mocked(fsSync.openSync).mockImplementation(() => {
				throw enoent
			})

			await expect(safeWriteText(targetPath, "data", { platform: "linux" })).rejects.toBe(enoent)

			// The staging directory carries a name this call generated, so nothing shares it
			// and a failed open has no recovery to reach for. Re-creating a directory would
			// create a different one and leave tempPath without a parent, so the retry that
			// used to live here could only fail a second time: one create, one open.
			expect(fsSync.mkdirSync).toHaveBeenCalledTimes(1)
			expect(fsSync.openSync).toHaveBeenCalledTimes(1)
			expect(fs.rename).not.toHaveBeenCalled()
		})
	})

	// ── Test 2: fsync ordering ───────────────────────────────────────────────

	describe("fsync ordering", () => {
		it("calls fsync on the fd before close, and rename after close", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			await safeWriteText(targetPath, "data", { platform: "linux" })

			// Verify call order: openSync(temp) → writeSync → fsyncSync(temp)
			// → closeSync(temp) → rename. On POSIX the parent directory is then
			// opened and fsynced after the commit rename, so openSync/fsyncSync/
			// closeSync each have a second (directory) call.
			expect(vi.mocked(fsSync.openSync).mock.calls.length).toBe(2)
			expect(vi.mocked(fsSync.writeSync).mock.calls.length).toBe(1)
			expect(vi.mocked(fsSync.fsyncSync).mock.calls.length).toBe(2)
			expect(vi.mocked(fsSync.closeSync).mock.calls.length).toBe(2)

			// the temp file was fully closed before the commit rename
			expect(vi.mocked(fsSync.closeSync).mock.calls[0][0]).toBe(1)
			expect(fs.rename).toHaveBeenCalled()

			// ... and in that order: everything above counts calls, so a commit rename that
			// ran before the file fsync would satisfy every assertion here. Compare call order
			// across the four steps the durability contract is about.
			const writeOrder = vi.mocked(fsSync.writeSync).mock.invocationCallOrder[0]
			const fsyncOrder = vi.mocked(fsSync.fsyncSync).mock.invocationCallOrder[0]
			const closeOrder = vi.mocked(fsSync.closeSync).mock.invocationCallOrder[0]
			const renameOrder = vi.mocked(fs.rename).mock.invocationCallOrder[0]
			expect(writeOrder).toBeLessThan(fsyncOrder)
			expect(fsyncOrder).toBeLessThan(closeOrder)
			expect(closeOrder).toBeLessThan(renameOrder)
		})
	})

	// ── Test 3: simulated failure between write and rename leaves target intact ──

	describe("crash/torn-write safety", () => {
		it("simulated failure between fsync and rename leaves the target byte-identical and no temp left behind", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(fs.rename).mockRejectedValue(new Error("ENOSPC"))

			await expect(safeWriteText(targetPath, "new data", { platform: "linux" })).rejects.toThrow("ENOSPC")

			// rename was attempted (the failure point)
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), targetPath)

			// temp file was cleaned up on failure
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"))

			// backup was NOT created (backup:false by default), so target is untouched
			// The only rename call was temp→target, not a rollback rename
			expect(fs.rename).toHaveBeenCalledTimes(1)
		})

		it("removes the empty staging directory when the commit fails", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(fs.rename).mockRejectedValue(new Error("ENOSPC"))

			await expect(safeWriteText(targetPath, "new data", { platform: "linux" })).rejects.toThrow("ENOSPC")

			// The temp file is gone, so the staging directory it was created for is empty.
			// Leaving it behind puts hidden clutter in the user's workspace until some later
			// successful write happens to remove it.
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"))
			expect(fs.rmdir).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"))
		})

		it("a preCommitVerify rejection skips the commit rename and leaves the target untouched", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			const verify = vi.fn(async () => {
				throw new Error("Stale version at commit time")
			})

			await expect(
				safeWriteText(targetPath, "new data", { platform: "linux", preCommitVerify: verify }),
			).rejects.toThrow("Stale version at commit time")

			// The verifier runs after staging and fsync but before the rename, so the target
			// was never moved and the staged content was cleaned up.
			expect(verify).toHaveBeenCalledWith(targetPath)
			// Order is the contract here, not the call: the verifier must run after the staged
			// file is written and fsynced. The other half - that it ran before the commit rename
			// - is the rename assertion below, because a rejected verification never renames.
			// Both sides of the comparison have to exist before they are compared: a verifier
			// that runs too early never stages anything, and that must read as a failed call
			// assertion rather than as a comparison against undefined.
			expect(fsSync.writeSync).toHaveBeenCalledTimes(1)
			expect(fsSync.fsyncSync).toHaveBeenCalled()
			const stagedWriteOrder = vi.mocked(fsSync.writeSync).mock.invocationCallOrder[0]
			const stagedFsyncOrder = vi.mocked(fsSync.fsyncSync).mock.invocationCallOrder[0]
			const verifyOrder = verify.mock.invocationCallOrder[0]
			expect(stagedWriteOrder).toBeLessThan(stagedFsyncOrder)
			expect(stagedFsyncOrder).toBeLessThan(verifyOrder)
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"))
			expect(fs.rmdir).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"))
		})

		it("retains a backup whose cleanup failed and clears it on the next flush", async () => {
			const targetPath = "/tmp/test-dir/retry-target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// Every unlink attempt fails during the write, so the path has to be kept rather than
			// abandoned - that is the difference between a retry and an orphan.
			vi.mocked(fs.unlink).mockRejectedValue(new Error("EBUSY"))

			await safeWriteText(targetPath, "data", { backup: true, platform: "linux" })

			const backupPaths = vi
				.mocked(fs.unlink)
				.mock.calls.map(([candidate]) => String(candidate))
				.filter((candidate) => candidate.includes("safeWriteText.bak_"))
			expect(backupPaths.length).toBeGreaterThan(1) // retried before giving up

			// A later cleanup, once the filesystem lets go, must clear the retained path.
			vi.mocked(fs.unlink).mockResolvedValue(undefined)
			await expect(flushPendingBackupRemovals()).resolves.toBe(1)
		})
		it("treats a backup that is already gone as removed rather than re-registering it for every later write", async () => {
			const targetPath = "/tmp/test-dir/enoent-target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// The backup disappears between the commit and the cleanup, so every unlink reports
			// ENOENT - the outcome the cleanup was after. Retrying it treats a missing file as
			// work, and the 25 + 50 ms of retry sleep is then paid on every later write, because
			// safeWriteText flushes the pending set before it does anything else.
			vi.mocked(fs.unlink).mockRejectedValue(
				Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
			)

			await safeWriteText(targetPath, "data", { backup: true, platform: "linux" })

			// One attempt on the backup, not three.
			expect(_backupUnlinkCalls()).toBe(1)
			// Nothing is left pending: an already-removed backup is done, not owed.
			await expect(flushPendingBackupRemovals()).resolves.toBe(0)

			// A later write to the same target attempts its own cleanup once and never revisits
			// the path that is already gone.
			await safeWriteText(targetPath, "data2", { backup: true, platform: "linux" })
			expect(_backupUnlinkCalls()).toBe(2)
		})

		it("does not re-register a backup path that a concurrent flush already removed", async () => {
			const targetPath = "/tmp/test-dir/race-target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// A scanner holds the backup for the whole write, so the path is retained at the end
			// of step 6 - the state two flushes can then race over.
			vi.mocked(fs.unlink).mockRejectedValue(new Error("EBUSY"))
			await safeWriteText(targetPath, "data", { backup: true, platform: "linux" })

			// Two flushes iterate the same snapshot of the pending set. The first unlink succeeds
			// and removes the file, so every attempt the losing flush makes afterwards reports
			// ENOENT for a path it is still holding in its own iteration.
			let unlinkAttempts = 0
			vi.mocked(fs.unlink).mockImplementation(async () => {
				unlinkAttempts += 1
				if (unlinkAttempts === 1) {
					return undefined
				}
				throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
			})
			const cleared = await Promise.all([flushPendingBackupRemovals(), flushPendingBackupRemovals()])
			expect(cleared).toEqual([1, 1])

			// The path must not be back in the set: with unlink working again there is nothing
			// left for a later write to clear.
			vi.mocked(fs.unlink).mockResolvedValue(undefined)
			await expect(flushPendingBackupRemovals()).resolves.toBe(0)
		})

		it("a post-commit backup cleanup failure is non-fatal: the target stays committed and the path is handed to a later write", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// The post-commit backup unlink (SUT step 6) fails for the whole attempt. The write
			// still succeeds: the failure is swallowed rather than rolled back, and the path is
			// retained for a later write rather than abandoned. Rejecting once would let the
			// helper's own second attempt succeed and the retention would never be observable.
			vi.mocked(fs.unlink).mockRejectedValue(new Error("EPERM"))

			await safeWriteText(targetPath, "data", { backup: true, platform: "linux" })

			// the commit rename (temp -> target) still happened, and it is the only rename:
			// the backup is a copy, so the target was never moved out of the way.
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), targetPath)
			expect(fs.rename).toHaveBeenCalledTimes(1)

			// the failing cleanup was the post-commit backup unlink, retried to exhaustion
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.bak_"))
			expect(_backupUnlinkCalls()).toBe(3)

			// no rollback rename: nothing was ever renamed away from the committed target
			expect(fs.rename).not.toHaveBeenCalledWith(targetPath, expect.anything())

			// the staging temp was already committed by the rename; nothing
			// temp-shaped is unlinked afterwards
			expect(fs.unlink).not.toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"))

			// retention is the outcome this failure produces and it is observable: with the
			// filesystem let go, a flush clears exactly the one path this write left behind
			vi.mocked(fs.unlink).mockResolvedValue(undefined)
			await expect(flushPendingBackupRemovals()).resolves.toBe(1)
		})
	})

	// ── Test 4: backup:true keeps old safeWriteJson semantics, copy-based ──

	describe("backup:true", () => {
		it("copies target -> backup before commit without moving the target, and deletes the copy on success", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			await safeWriteText(targetPath, "new data", { backup: true })

			// target was accessed (exists check)
			expect(fs.access).toHaveBeenCalledWith(targetPath)

			// The backup is a copy: the target never leaves its path, so a reader sees the
			// pre-write content for the whole attempt and there is nothing to roll back.
			expect(fs.copyFile).toHaveBeenCalledWith(targetPath, expect.stringContaining("safeWriteText.bak_"))

			// The only rename is the commit: temp -> target.
			expect(fs.rename).toHaveBeenCalledTimes(1)
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), targetPath)

			// backup copy was deleted on success
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.bak_"))
		})

		it("creates the backup privately before its content exists, then fsyncs it", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			await safeWriteText(targetPath, "new data", { backup: true })

			// The destination must exist with a private mode before copyFile writes anything
			// into it: copyFile chooses the destination mode itself, so a restrictive target
			// could otherwise leave a group/world-readable copy that a later chmod cannot
			// undo. "wx" also means a pre-existing path is never silently reused.
			const seedOpen = vi.mocked(fsSync.openSync).mock.calls.find(function (call) {
				return String(call[0]).includes("safeWriteText.bak_") && call[1] === "wx"
			})
			expect(seedOpen).toBeDefined()
			expect(seedOpen?.[2]).toBe(0o600)
			const seedOrder = vi.mocked(fsSync.openSync).mock.invocationCallOrder[
				vi.mocked(fsSync.openSync).mock.calls.indexOf(seedOpen!)
			]
			expect(seedOrder).toBeLessThan(vi.mocked(fs.copyFile).mock.invocationCallOrder[0])

			// The chmod keeps a copied read-only attribute (Windows) from breaking the fsync
			// open, and keeps a backup of a permissive file private.
			expect(fs.copyFile).toHaveBeenCalledWith(targetPath, expect.stringContaining("safeWriteText.bak_"))
			expect(fs.chmod).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.bak_"), 0o600)
			expect(vi.mocked(fs.chmod).mock.invocationCallOrder[0]).toBeGreaterThan(
				vi.mocked(fs.copyFile).mock.invocationCallOrder[0],
			)

			// The copy is then opened for fsync with the writable flag.
			const backupOpen = vi.mocked(fsSync.openSync).mock.calls.find(function (call) {
				return String(call[0]).includes("safeWriteText.bak_") && call[1] === "r+"
			})
			expect(backupOpen).toBeDefined()
			// The writable open must come after the chmod: an open taken before it would
			// fsync the copy while copyFile's chosen mode is still on the file.
			const backupOpenOrder = vi.mocked(fsSync.openSync).mock.invocationCallOrder[
				vi.mocked(fsSync.openSync).mock.calls.indexOf(backupOpen!)
			]
			expect(backupOpenOrder).toBeGreaterThan(vi.mocked(fs.chmod).mock.invocationCallOrder[0])
		})

		it("a failed commit leaves the pre-write content at the target and drops the backup copy", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// The commit rename is the only rename in this flow, and it fails.
			vi.mocked(fs.rename).mockRejectedValue(new Error("ENOSPC"))

			await expect(safeWriteText(targetPath, "new data", { backup: true })).rejects.toThrow("ENOSPC")

			// The backup was a copy of the target, taken before the commit.
			expect(fs.copyFile).toHaveBeenCalledWith(targetPath, expect.stringContaining("safeWriteText.bak_"))
			// No restore: the target was never moved, so no rename can put the copy back.
			expect(fs.rename).toHaveBeenCalledTimes(1)
			// The copy is dropped and the staging temp is released.
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.bak_"))
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"))
		})

		// Written before the fix: the seed open is where a taken backup name is discovered, and today
		// the catch beside it removes the path whether or not this call created it.
		it("leaves a backup name it did not create alone when the exclusive seed open finds it taken", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			const eexist = Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" })
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			// The "wx" open on a .bak_ name is the seed, and it is the only place this flow can
			// discover that the generated name is already owned by another write. Failing it there
			// means this call created nothing, so it has no business removing anything.
			vi.mocked(fsSync.openSync).mockImplementation(function (pathArg: unknown, flagArg?: unknown) {
				if (flagArg === "wx" && String(pathArg).includes("safeWriteText.bak_")) {
					throw eexist
				}
				return 1
			})

			await expect(safeWriteText(targetPath, "data", { backup: true, platform: "linux" })).rejects.toEqual(
				expect.objectContaining({ code: "EEXIST" }),
			)

			// Not one unlink attempt against a backup path: three strikes would mean it treated a
			// file it never made as its own to throw away.
			expect(_backupUnlinkCalls()).toBe(0)
			expect(fs.copyFile).not.toHaveBeenCalled()
			expect(fs.rename).not.toHaveBeenCalled()
		})
		it("hands a backup whose failure-path removal could not complete to a later write", async () => {
			const targetPath = "/tmp/test-dir/verify-fail.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// The verifier runs after step 3 has copied the target to the backup, and every unlink
			// fails, so the intended drop cannot complete. The path must then be owned by a later
			// write rather than forgotten beside the target with nothing pointing at it.
			const verify = vi.fn(async () => {
				throw new Error("Stale version at commit time")
			})
			vi.mocked(fs.unlink).mockRejectedValue(new Error("EBUSY"))

			await expect(
				safeWriteText(targetPath, "data", { backup: true, platform: "linux", preCommitVerify: verify }),
			).rejects.toThrow("Stale version at commit time")

			// Retried rather than given up after one attempt.
			expect(_backupUnlinkCalls()).toBe(3)
			// Owned: once the filesystem lets go, a flush clears exactly that retained path.
			vi.mocked(fs.unlink).mockResolvedValue(undefined)
			await expect(flushPendingBackupRemovals()).resolves.toBe(1)
			// The drop is still the intent, so nothing was committed and the pre-write content is
			// still at the target path: no rename happened at all.
			expect(fs.rename).not.toHaveBeenCalled()
		})

		it("backup:true when target does not exist: no backup created, just commit", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// fs.access resolves for dirPath check, but rejects for target check (backup path)
			vi.mocked(fs.access).mockImplementation(async (p) => {
				if (typeof p === "string" && p.endsWith("target.txt")) throw { code: "ENOENT" }
			})

			await safeWriteText(targetPath, "new data", { backup: true, platform: "linux" })

			// no backup rename (target didn't exist)
			expect(fs.access).toHaveBeenCalledWith(targetPath)

			// only one rename: temp -> target
			expect(fs.rename).toHaveBeenCalledTimes(1)
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), targetPath)

			// no unlink (no backup to delete; DACL skipped via platform:linux)
			expect(fs.unlink).not.toHaveBeenCalled()
		})
	})

	// ── Test 5: win32 DACL path ──────────────────────────────────────────────

	describe("win32 DACL", () => {
		it.skipIf(process.platform !== "win32")(
			"copies target DACL onto staging file via icacls before rename on Windows",
			async () => {
				const targetPath = "/tmp/test-dir/target.txt"
				vi.mocked(fs.realpath).mockResolvedValue(targetPath)
				await safeWriteText(targetPath, "data", { platform: "win32" })

				// icacls dump + restore were called (execFile is callback-based mock)
				expect(execFile).toHaveBeenCalledTimes(2)
			},
		)

		it("non-win32: DACL path is unreachable when platform is not win32", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			await safeWriteText(targetPath, "data", { platform: "linux" })

			// icacls was NOT called on non-win32
			expect(execFile).not.toHaveBeenCalled()
		})

		it("win32 DACL failure falls back to plain rename (never fails the write)", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// icacls dump fails — the callback-based mock must invoke cb with an error.
			vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
				if (typeof cb === "function") cb(new Error("icacls error"), "", "")
				return fakeChild
			})

			await safeWriteText(targetPath, "data", { platform: "win32" })

			// write succeeded despite icacls failure (fallback to plain rename)
			expect(fs.rename).toHaveBeenCalled()
			// and the fallback leaves no dump file behind
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.acl"))
		})

		it("win32 DACL: a failed save never unlinks a dump this write did not create", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			// A file that already sits at the name an earlier fixed scheme would have used.
			// It belongs to whatever put it there, not to this write.
			const preExisting = targetPath + ".acl.tmp"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
				if (typeof cb === "function") cb(new Error("icacls save error"), "", "")
				return fakeChild
			})

			await safeWriteText(targetPath, "data", { platform: "win32" })

			// The dump icacls was told to write is a name this call generated...
			const dumpArg = vi.mocked(execFile).mock.calls[0]?.[1]?.[2]
			expect(typeof dumpArg).toBe("string")
			expect(String(dumpArg)).toContain("safeWriteText.acl")
			expect(String(dumpArg)).not.toBe(preExisting)
			// ...and the cleanup only ever reaches that owned name. The pre-existing file
			// survives a failed save instead of being deleted as if this write owned it.
			for (const call of vi.mocked(fs.unlink).mock.calls) {
				expect(String(call[0])).not.toBe(preExisting)
			}
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.acl"))
		})

		it("win32 DACL: a partial dump left by a failed save is removed and never restored", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// icacls save fails. A real icacls can create or partially write the dump
			// before it errors, so the dump path must be cleaned up even though nothing
			// valid may be restored from it.
			vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
				if (typeof cb === "function") cb(new Error("icacls save error"), "", "")
				return fakeChild
			})

			await safeWriteText(targetPath, "data", { platform: "win32" })

			// The write still committed and only the save was attempted: a failed dump
			// must never be handed to a restore.
			expect(fs.rename).toHaveBeenCalledTimes(1)
			expect(execFile).toHaveBeenCalledTimes(1)
			expect(vi.mocked(execFile).mock.calls[0]?.[1]?.[1]).toBe("/save")
			// The possibly partial dump was unlinked, not merely forgotten.
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.acl"))
		})

		it("win32 DACL save args are [targetPath, /save, dumpPath, /T] before backup rename", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			await safeWriteText(targetPath, "data", { backup: true, platform: "win32" })

			// icacls was called twice (save + restore)
			expect(execFile).toHaveBeenCalledTimes(2)

			// First call: save DACL from target before backup rename
			const firstCall = vi.mocked(execFile).mock.calls[0]
			expect(firstCall[0]).toBe("icacls")
			expect(firstCall[1]).toEqual([targetPath, "/save", expect.stringContaining("safeWriteText.acl"), "/T"])

			// Second call: restore DACL onto directory after commit rename
			const secondCall = vi.mocked(execFile).mock.calls[1]
			expect(secondCall[0]).toBe("icacls")
			expect(secondCall[1]).toEqual([
				expect.stringContaining("/tmp/test-dir"),
				"/restore",
				expect.stringContaining("safeWriteText.acl"),
			])

			// dump file was unlinked after restore
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.acl"))
		})

		it("win32 DACL: dump is unlinked even when restore fails", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			// icacls save succeeds, restore fails
			let callCount = 0
			vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
				callCount++
				if (typeof cb === "function") {
					cb(callCount === 1 ? null : new Error("icacls restore error"), "", "")
				}
				return fakeChild
			})

			await safeWriteText(targetPath, "data", { platform: "win32" })

			// write succeeded despite restore failure (best-effort)
			expect(fs.rename).toHaveBeenCalled()

			// dump file was still unlinked in finally
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.acl"))
		})

		it("win32 DACL: when target does not exist, no save/restore/dump", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			// fs.access rejects for targetPath (ENOENT), but resolves for dirPath
			vi.mocked(fs.access).mockImplementation(async (p) => {
				if (typeof p === "string" && p.endsWith("target.txt")) throw { code: "ENOENT" }
				return undefined
			})

			await safeWriteText(targetPath, "data", { platform: "win32" })

			// icacls was NOT called (target absent → skip DACL entirely)
			expect(execFile).not.toHaveBeenCalled()

			// no dump file created or unlinked
			expect(fs.unlink).not.toHaveBeenCalled()
		})
	})

	// ── Test 6: pre-written temp path (tempPath option) ──────────────────────

	describe("pre-written temp path", () => {
		it("uses the provided tempPath, fsyncs it, and renames to target", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			const customTempPath = "/tmp/custom-temp.tmp"

			// platform:linux skips DACL entirely so this test focuses on tempPath only
			await safeWriteText(targetPath, "", { tempPath: customTempPath, platform: "linux" })

			// openSync was called on the custom temp path (r+ mode for fsync)
			expect(fsSync.openSync).toHaveBeenCalledWith(customTempPath, "r+")

			// fsync was called
			expect(fsSync.fsyncSync).toHaveBeenCalledWith(1)

			// rename happened — realpath mock returns targetPath
			expect(fs.rename).toHaveBeenCalledWith(customTempPath, targetPath)

			// no unlink of custom temp (caller's concern; DACL skipped via platform:linux)
			expect(fs.unlink).not.toHaveBeenCalled()

			// a caller-supplied tempPath must not create the staging directory
			expect(fsSync.mkdirSync).not.toHaveBeenCalled()
		})

		it("applies the existing target's mode to a caller-supplied tempPath before publishing", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.statSync).mockReturnValue(_stats(0o600))
			vi.mocked(fsSync.openSync).mockReturnValue(2)

			const customTempPath = "/tmp/custom-temp.tmp"

			await safeWriteText(targetPath, "", { tempPath: customTempPath, platform: "linux" })

			// the caller-staged temp is fchmod'd to the restrictive target mode so
			// the atomic rename cannot widen a 0o600 target (CWE-732 regression)
			expect(fsSync.fchmodSync).toHaveBeenCalledWith(2, 0o600)
			expect(fsSync.openSync).toHaveBeenCalledWith(customTempPath, "r+")
			expect(fs.rename).toHaveBeenCalledWith(customTempPath, targetPath)
		})

		it("keeps the temp's default mode when the target does not exist yet (ENOENT)", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
			vi.mocked(fsSync.statSync).mockImplementation(() => {
				throw enoent
			})
			vi.mocked(fsSync.openSync).mockReturnValue(2)

			const customTempPath = "/tmp/custom-temp.tmp"

			await safeWriteText(targetPath, "", { tempPath: customTempPath, platform: "linux" })

			// no existing target, so nothing to preserve and no fchmod on the temp
			expect(fsSync.fchmodSync).not.toHaveBeenCalled()
			expect(fs.rename).toHaveBeenCalledWith(customTempPath, targetPath)
		})

		it("opens the temp before applying a read-only target's mode (0o444 does not block the open)", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.statSync).mockReturnValue(_stats(0o444))
			vi.mocked(fsSync.openSync).mockReturnValue(3)

			const customTempPath = "/tmp/custom-temp.tmp"

			await safeWriteText(targetPath, "", { tempPath: customTempPath, platform: "linux" })

			// a 0o444 target must not make openSync(tempPath, "r+") fail: the mode
			// is applied with fchmodSync on the already-open fd, after the open
			expect(fsSync.openSync).toHaveBeenCalledWith(customTempPath, "r+")
			expect(fsSync.fchmodSync).toHaveBeenCalledWith(3, 0o444)
			const openIdx = vi.mocked(fsSync.openSync).mock.invocationCallOrder[0]
			const fchmodIdx = vi.mocked(fsSync.fchmodSync).mock.invocationCallOrder[0]
			expect(openIdx).toBeLessThan(fchmodIdx)
			expect(fs.rename).toHaveBeenCalledWith(customTempPath, targetPath)
		})
	})

	// ── Test 7: symlink handling (Finding 4 regression test) ─────────────────

	describe("symlink handling", () => {
		it("a write through a symlink commits onto the resolved referent, never the link path", async () => {
			const linkPath = "/tmp/links/link.txt"
			const referentPath = "/tmp/targets/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(referentPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			await safeWriteText(linkPath, "new-content", { platform: "linux" })

			// The commit rename must target the realpath result (the referent), never the link itself —
			// that is what guarantees a write through a symlink replaces the referent's content
			// and preserves the link.
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), referentPath)
			expect(fs.rename).not.toHaveBeenCalledWith(expect.anything(), linkPath)
		})

		it("when realpath reports ENOENT (target absent), uses the given path as-is", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			await safeWriteText(targetPath, "data", { platform: "linux" })

			// rename still happened with the fallback path (path.resolve on /tmp → C:\tmp)
			const resolvedFallback = _resolvedTarget(targetPath)
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), resolvedFallback)
		})
	})

	// ── Test 8: review fixes (permissions, partial writes, resolution, durability) ──

	describe("review fixes", () => {
		it("preserves the target's restrictive mode and tolerates a failed staging-dir permission repair", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(fsSync.statSync).mockReturnValue(_stats(0o600))
			// a pre-existing staging dir may fail its best-effort permission repair
			vi.mocked(fsSync.chmodSync).mockImplementationOnce(() => {
				throw new Error("EACCES")
			})

			await safeWriteText(targetPath, "secret", { platform: "linux" })

			// the staging file inherits the target's 0o600 mode and the write commits
			expect(fsSync.openSync).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), "w", 0o600)
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), targetPath)
		})

		it("falls back to the 0o644 default when the target does not exist yet", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(fsSync.statSync).mockImplementation(() => {
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
			})

			await safeWriteText(targetPath, "fresh", { platform: "linux" })

			expect(fsSync.openSync).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), "w", 0o644)
		})

		it("loops on short writes until the full content is durable before fsync", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			const content = "0123456789" // 10 bytes
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			const buffer = Buffer.from(content, "utf8")
			// first write (offset 0) reports 4 bytes (short write); the loop continues
			vi.mocked(fsSync.writeSync).mockImplementation((...args: unknown[]) =>
				args[2] === 0 ? 4 : typeof args[3] === "number" ? args[3] : 0,
			)

			await safeWriteText(targetPath, content, { platform: "linux" })

			// [0,10) reports 4 bytes, then [4,10) writes the remaining 6
			expect(fsSync.writeSync).toHaveBeenCalledTimes(2)
			expect(fsSync.writeSync).toHaveBeenNthCalledWith(1, 1, buffer, 0, 10)
			expect(fsSync.writeSync).toHaveBeenNthCalledWith(2, 1, buffer, 4, 6)
			expect(fsSync.fsyncSync).toHaveBeenCalledWith(1)
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), targetPath)
		})

		it("fsyncs the parent directory after the commit rename on POSIX", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			// temp fd=1 then parent-dir fd=2 - distinct fds prove the ordering
			vi.mocked(fsSync.openSync).mockReturnValueOnce(1).mockReturnValue(2)

			await safeWriteText(targetPath, "data", { platform: "linux" })

			// the directory fsync (fd 2) happens only after the file fsync (fd 1);
			// the dir path assertion is path-agnostic (stringContaining) because
			// path.dirname renders the same input differently on Windows
			expect(fsSync.openSync).toHaveBeenCalledWith(expect.stringContaining("test-dir"), "r")
			expect(fsSync.fsyncSync).toHaveBeenNthCalledWith(1, 1)
			expect(fsSync.fsyncSync).toHaveBeenNthCalledWith(2, 2)
			expect(fsSync.closeSync).toHaveBeenCalledWith(2)
		})

		it("treats a failed parent-directory fsync as best-effort", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync)
				.mockReturnValueOnce(1)
				.mockImplementationOnce(() => {
					throw new Error("EBADF")
				})

			// the content rename already committed; a missing directory fsync is not fatal
			await safeWriteText(targetPath, "data", { platform: "linux" })

			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), targetPath)
		})

		it("propagates realpath errors (EACCES and code-less) instead of the fallback path", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
			vi.mocked(fs.realpath).mockRejectedValueOnce(eacces)
			await expect(safeWriteText(targetPath, "data", { platform: "linux" })).rejects.toBe(eacces)
			expect(fs.rename).not.toHaveBeenCalled()

			const plain = new Error("resolution failed")
			vi.mocked(fs.realpath).mockRejectedValueOnce(plain)
			await expect(safeWriteText(targetPath, "data", { platform: "linux" })).rejects.toBe(plain)
			expect(fs.rename).not.toHaveBeenCalled()
		})

		it("backup:true propagates access errors (EACCES and code-less) instead of skipping the backup", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			const eacces = Object.assign(new Error("EACCES"), { code: "EACCES" })
			const plain = new Error("access failed")
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// each write accesses dirPath then target; only the target access rejects
			const rejectTarget = (error: Error) => async (p: unknown) => {
				if (typeof p === "string" && p.endsWith("target.txt")) throw error
			}
			vi.mocked(fs.access)
				.mockImplementationOnce(rejectTarget(eacces))
				.mockImplementationOnce(rejectTarget(eacces))
				.mockImplementationOnce(rejectTarget(plain))
				.mockImplementationOnce(rejectTarget(plain))

			await expect(safeWriteText(targetPath, "data", { backup: true, platform: "linux" })).rejects.toEqual(
				expect.objectContaining({ code: "EACCES" }),
			)
			await expect(safeWriteText(targetPath, "data", { backup: true, platform: "linux" })).rejects.toThrow(
				"access failed",
			)
			expect(fs.rename).not.toHaveBeenCalled()
		})
	})

	// These three cases each pin one answer that the code currently gets wrong: what lstat
	// says when realpath says ENOENT, what mode the generated staging file is published
	// with, and who owns a backup whose cleanup unlink itself failed.
	describe("publication guards: dangling links, target mode and retained backups", () => {
		it("rejects a write whose target is a symlink with no referent instead of replacing the link", async () => {
			const linkPath = "/tmp/test-dir/link.txt"
			// realpath answers ENOENT both for a name that does not exist yet and for a symlink
			// whose referent is gone. lstat is what tells the two apart, and the documented
			// contract is that only an absent target may fall back to the link path.
			vi.mocked(fs.realpath).mockRejectedValue(
				Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
			)
			vi.mocked(fs.lstat).mockResolvedValue(_lstatLike(0o777, true))

			await expect(safeWriteText(linkPath, "data", { platform: "linux" })).rejects.toThrow(/dangling symlink/)
			expect(fs.rename).not.toHaveBeenCalled()
		})
		// Written before the fix: today lstat's failure is swallowed and read as "the name is
		// absent", which is the one guess that must not be made here.
		it("propagates a non-ENOENT lstat failure instead of treating the target as absent", async () => {
			const linkPath = "/tmp/test-dir/link.txt"
			// realpath answers ENOENT for an absent name and for a dangling link alike; lstat is
			// what tells the two apart. If lstat itself cannot answer, the code does not know which
			// world it is in, and guessing "absent" lets the commit rename replace a link with a
			// regular file where a link used to stand. An unreadable target has to stop the write.
			vi.mocked(fs.realpath).mockRejectedValue(
				Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
			)
			vi.mocked(fs.lstat).mockRejectedValue(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }))

			await expect(safeWriteText(linkPath, "data", { platform: "linux" })).rejects.toEqual(
				expect.objectContaining({ code: "EIO" }),
			)

			// Stopped before the write, not merely reported: nothing was created and nothing moved.
			expect(fs.mkdir).not.toHaveBeenCalled()
			expect(fs.rename).not.toHaveBeenCalled()
		})
		it("hands a caller-staged temp file back when target resolution refuses to guess", async () => {
			const linkPath = "/tmp/test-dir/link.txt"
			const callerTemp = "/tmp/test-dir/.staging/caller-staged.tmp"
			// safeWriteJson stages its temp file beside the resolved path before calling this
			// function. A refusal before the guarded region must hand that file back: step 8 of
			// the documented contract says a failed write cleans up temp + dump, and resolution
			// sits above the region that owns the staged file.
			vi.mocked(fs.realpath).mockRejectedValue(
				Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
			)
			vi.mocked(fs.lstat).mockRejectedValue(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }))

			await expect(safeWriteText(linkPath, "data", { platform: "linux", tempPath: callerTemp })).rejects.toEqual(
				expect.objectContaining({ code: "EIO" }),
			)

			// The caller's staged file is the only temp this call could have leaked, and it is
			// removed; nothing was created and nothing moved.
			expect(fs.unlink).toHaveBeenCalledWith(callerTemp)
			expect(_backupUnlinkCalls()).toBe(0)
			expect(fs.mkdir).not.toHaveBeenCalled()
			expect(fs.rename).not.toHaveBeenCalled()
			// Same convention as the two directory-setup tests below, extended to the sync write step:
			// this refusal happens before any of the write work.
			expect(fsSync.openSync).not.toHaveBeenCalled()
		})
		it("fixes the generated staging file's mode with fchmod so the umask cannot narrow it", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			// A permissive target: the generated staging file must be published with the same
			// mode rather than the creation mask the process happens to run under.
			vi.mocked(fsSync.statSync).mockReturnValue(_stats(0o664))
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			await safeWriteText(targetPath, "new data", { platform: "linux" })

			// The open argument is not the outcome - openSync's mode is subject to the umask -
			// so assert the call that fixes the mode on the descriptor, and that it lands
			// between the open and the fsync.
			expect(fsSync.fchmodSync).toHaveBeenCalledWith(1, 0o664)
			const openOrder = vi.mocked(fsSync.openSync).mock.invocationCallOrder[0]
			const chmodOrder = vi.mocked(fsSync.fchmodSync).mock.invocationCallOrder[0]
			const fsyncOrder = vi.mocked(fsSync.fsyncSync).mock.invocationCallOrder[0]
			expect(openOrder).toBeLessThan(chmodOrder)
			expect(chmodOrder).toBeLessThan(fsyncOrder)
		})
		it("keeps a backup whose creation cleanup failed for a later write to clear", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(fs.copyFile).mockRejectedValue(new Error("EXDEV: cross-device copy not permitted"))
			vi.mocked(fs.unlink).mockRejectedValue(new Error("EBUSY: resource busy or locked"))

			await expect(safeWriteText(targetPath, "data", { backup: true, platform: "linux" })).rejects.toThrow(
				"EXDEV: cross-device copy not permitted",
			)

			// The cleanup unlink failed, so the path must still be owned: it goes through the
			// same retry loop as every other backup removal - three attempts - and a later
			// flush has to be able to clear it instead of leaving it beside the target.
			expect(_backupUnlinkCalls()).toBe(3)
			vi.mocked(fs.unlink).mockResolvedValue(undefined)
			await expect(flushPendingBackupRemovals()).resolves.toBe(1)
		})
		it("hands a caller-staged temp file back when the parent directory cannot be prepared", async () => {
			const callerTemp = "/tmp/caller-staged-dir.tmp"
			vi.mocked(fs.realpath).mockImplementation(async (p: unknown) => String(p))
			vi.mocked(fs.lstat).mockRejectedValue(
				Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
			)
			vi.mocked(fs.mkdir).mockRejectedValueOnce(
				Object.assign(new Error("EACCES: permission denied, mkdir '/tmp/test-dir'"), { code: "EACCES" }),
			)

			await expect(
				safeWriteText("/tmp/test-dir/target.txt", "payload", { tempPath: callerTemp, platform: "linux" }),
			).rejects.toThrow("EACCES")

			// Directory setup sits above the guarded region, same as target resolution: the
			// rollback unlink cannot be reached from here, so the staged file has to be handed
			// back by the same cleanup the refusal path uses.
			expect(fs.unlink).toHaveBeenCalledWith(callerTemp)
			expect(_backupUnlinkCalls()).toBe(0)
			// Directory setup sits above the guarded region, so a refusal here has to stop before any
			// write work: a failure that fell through into the write would still hand the staged file
			// back and still throw EACCES, and only the absence of the write tells those two shapes
			// apart.
			expect(fsSync.openSync).not.toHaveBeenCalled()
			expect(fsSync.mkdirSync).not.toHaveBeenCalled()
			expect(fs.rename).not.toHaveBeenCalled()
		})

		it("hands a caller-staged temp file back when the prepared directory fails access check", async () => {
			const callerTemp = "/tmp/caller-staged-access.tmp"
			vi.mocked(fs.realpath).mockImplementation(async (p: unknown) => String(p))
			vi.mocked(fs.lstat).mockRejectedValue(
				Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
			)
			vi.mocked(fs.access).mockRejectedValueOnce(
				Object.assign(new Error("EACCES: permission denied, access '/tmp/test-dir'"), { code: "EACCES" }),
			)

			await expect(
				safeWriteText("/tmp/test-dir/target.txt", "payload", { tempPath: callerTemp, platform: "linux" }),
			).rejects.toThrow("EACCES")

			expect(fs.unlink).toHaveBeenCalledWith(callerTemp)
			expect(_backupUnlinkCalls()).toBe(0)
			// Directory setup sits above the guarded region, so a refusal here has to stop before any
			// write work: a failure that fell through into the write would still hand the staged file
			// back and still throw EACCES, and only the absence of the write tells those two shapes
			// apart.
			expect(fsSync.openSync).not.toHaveBeenCalled()
			expect(fsSync.mkdirSync).not.toHaveBeenCalled()
			expect(fs.rename).not.toHaveBeenCalled()
		})
	})
})
