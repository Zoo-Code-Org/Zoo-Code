import * as fs from "fs/promises"
import type { BigIntStats } from "fs"
import * as fsSync from "fs"
import { execFile } from "child_process"
import type { ChildProcess } from "child_process"
import * as path from "path"

import {
	PostCommitDurabilityError,
	DaclInspectionError,
	resolveLockKey,
	safeWriteText,
	StagingPathError,
	TargetExistsError,
	UnsupportedFilesystemError,
	TargetMovedError,
	AncestorReplacedError,
	PublishCancelledError,
	OrphanedBackupAfterFailedWriteError,
	OrphanedBackupError,
	OrphanedPublishedBackupError,
} from "../safeWriteText"

// Full mock for fs/promises — all methods are vi.fn() stubs
vi.mock("fs/promises", () => ({
	mkdir: vi.fn(),
	access: vi.fn(),
	rename: vi.fn(),
	link: vi.fn(),
	copyFile: vi.fn(),
	chmod: vi.fn(),
	unlink: vi.fn(),
	rmdir: vi.fn(),
	realpath: vi.fn(),
	stat: vi.fn(),
	lstat: vi.fn(),
	readlink: vi.fn(),
}))

// Full mock for fs — all sync methods are vi.fn() stubs. Stats is a bare
// class stub so tests can build minimal Stats stand-ins via its prototype.
vi.mock("fs", () => ({
	// Mirrors Node's value; the no-replace fallback passes it to copyFile.
	constants: { COPYFILE_EXCL: 1 },
	openSync: vi.fn(),
	writeSync: vi.fn(),
	closeSync: vi.fn(),
	mkdirSync: vi.fn(),
	fsyncSync: vi.fn(),
	chmodSync: vi.fn(),
	fchmodSync: vi.fn(),
	fchownSync: vi.fn(),
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
// Minimal Stats stand-in: the SUT only reads `.mode` from it.
// Async lstat stand-in: the SUT only asks whether the path is a link or a file.
// Built on the Stats prototype so the mock value still satisfies fsSync.Stats.
function _fileStats(isLink: boolean): fsSync.Stats {
	const s = Object.create(fsSync.Stats.prototype) as fsSync.Stats
	s.isSymbolicLink = () => isLink
	s.isFile = () => !isLink
	return s
}

function mockDefaults(): void {
	vi.resetAllMocks()
	// After resetAllMocks, vi.fn() returns undefined — restore promise defaults.
	vi.mocked(fs.mkdir).mockResolvedValue(undefined)
	vi.mocked(fs.access).mockResolvedValue(undefined)
	vi.mocked(fs.rename).mockResolvedValue(undefined)
	vi.mocked(fs.link).mockResolvedValue(undefined)
	vi.mocked(fs.unlink).mockResolvedValue(undefined)
	vi.mocked(fs.rmdir).mockResolvedValue(undefined)
	// Existing-target default: a regular 0o644 file.
	vi.mocked(fsSync.statSync).mockReturnValue(_stats(0o644))
	// Staged-file default: a regular file, not a link, so a caller-supplied
	// tempPath passes the location and file-type check by default.
	vi.mocked(fs.lstat).mockResolvedValue(_fileStats(false))
	// Ancestor-identity pin: default to one stable directory identity so the pin
	// passes unless a test overrides it.
	vi.mocked(fs.stat).mockResolvedValue(_dirIdentity(100n))
}

// BigIntStats stand-in for the ancestor pin: the SUT reads only dev/ino off it.
// BigIntStats is class-backed with no public constructor, so this is a
// last-resort double assertion (test-local, per AGENTS.md).
function _dirIdentity(ino: bigint): BigIntStats {
	return { dev: 1n, ino } as unknown as BigIntStats
}
// BigIntStats stand-in for a regular staging file: the SUT reads dev/ino off it and asks
// whether it is a link. Same last-resort double assertion as _dirIdentity, test-local.
function _fileIdentity(dev: bigint, ino: bigint): BigIntStats {
	return { dev, ino, isSymbolicLink: () => false, isFile: () => true } as unknown as BigIntStats
}
function _stats(mode: number): fsSync.Stats {
	const s = Object.create(fsSync.Stats.prototype) as fsSync.Stats
	Object.assign(s, { mode })
	return s
}

// ── Test 1: staging file created then cleaned after success ────────────────

describe("safeWriteText", () => {
	beforeEach(() => {
		mockDefaults()
		// Default sync-write behaviour: report that all requested bytes were
		// written. The Buffer overload passes (fd, buffer, offset, length),
		// so the fourth argument is the requested length.
		vi.mocked(fsSync.writeSync).mockImplementation((...args: unknown[]) =>
			typeof args[3] === "number" ? args[3] : 0,
		)
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

		it("removes the now-empty staging directory after a successful self-staged commit", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			await safeWriteText(targetPath, "hello", { platform: "linux" })

			// the staging subdir is removed best-effort after the commit rename
			// (stringContaining: the SUT and the test helper resolve Windows
			// drive-relative paths differently, as in the existing staging tests)
			expect(fs.rmdir).toHaveBeenCalledTimes(1)
			expect(fs.rmdir).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"))
			// the win32 DACL restore gate must stay closed on other platforms:
			// no icacls save or restore is attempted
			expect(execFile).not.toHaveBeenCalled()
		})

		it("still removes the staging directory when no options are supplied at all", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			// options is undefined: the self-staged check and the optional-chained
			// DACL runner lookup must not dereference it
			await expect(safeWriteText(targetPath, "hello")).resolves.toBeUndefined()

			expect(fs.rmdir).toHaveBeenCalledTimes(1)
			expect(fs.rmdir).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"))
			if (process.platform === "win32") {
				// default platform is win32: the DACL save + restore still ran
				// through the default icacls path (options?.execFileRunner must
				// not throw when options is undefined)
				expect(vi.mocked(execFile)).toHaveBeenCalledTimes(2)
				expect(vi.mocked(fs.unlink)).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.acl"))
			}
		})

		it("does not remove the staging directory when the caller supplies its own tempPath", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			const callerTemp = "/tmp/test-dir/caller-staged.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			await safeWriteText(targetPath, "hello", { platform: "linux", tempPath: callerTemp })

			// the caller owns its temp file's directory; safeWriteText must not
			// rmdir a directory it did not create
			expect(fs.rmdir).not.toHaveBeenCalled()
		})

		it("a failed staging-dir removal never fails the committed write", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(fs.rmdir).mockRejectedValue(Object.assign(new Error("ENOTEMPTY"), { code: "ENOTEMPTY" }))

			await expect(safeWriteText(targetPath, "hello", { platform: "linux" })).resolves.toBeUndefined()

			// the commit rename still happened and the rmdir error was swallowed
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"), targetPath)
			expect(fs.rmdir).toHaveBeenCalledTimes(1)
			expect(fs.rmdir).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"))
		})

		it("gives each self-staged write its own staging directory so a concurrent write cannot remove it", async () => {
			const targetA = "/tmp/test-dir/target-a.txt"
			const targetB = "/tmp/test-dir/target-b.txt"
			vi.mocked(fs.realpath).mockImplementation((p) => Promise.resolve(p as string))
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			await safeWriteText(targetA, "a", { platform: "linux" })
			await safeWriteText(targetB, "b", { platform: "linux" })

			// Two self-staged writes in the same directory must not share one staging
			// directory: the first write's best-effort rmdir would otherwise delete the
			// directory the second write had created but not yet opened (ENOENT on openSync).
			const created = vi.mocked(fsSync.mkdirSync).mock.calls.map((c) => String(c[0]))
			const staging = created.filter((p) => p.includes(".file-safety-staging_"))
			expect(staging).toHaveLength(2)
			expect(staging[0]).not.toBe(staging[1])
			// Uniqueness comes from the documented name shape
			// <dir>/.file-safety-staging_<timestamp>_<random>: pinning the shape
			// keeps the separator and the random suffix meaningful, not just the prefix.
			for (const dir of staging) {
				expect(dir).toMatch(/\.file-safety-staging_\d+_[a-z0-9]+$/)
			}
			const removed = vi.mocked(fs.rmdir).mock.calls.map((c) => String(c[0]))
			expect(removed).toEqual([staging[0], staging[1]])
		})

		it("removes its own staging directory when a self-staged write fails", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(fs.rename).mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }))

			await expect(safeWriteText(targetPath, "hello", { platform: "linux" })).rejects.toThrow("EACCES")

			// The failed write's temp file is unlinked, then the directory it
			// created is removed — a failed write must not leave an empty
			// .file-safety-staging directory behind.
			// mkdirSync created this write's staging directory; the temp file lives
			// inside it, so the unlink targets a path under that directory.
			const staging = vi.mocked(fsSync.mkdirSync).mock.calls.map((c) => String(c[0]))
			expect(staging).toHaveLength(1)
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining(staging[0]))
			expect(fs.rmdir).toHaveBeenCalledWith(staging[0])
			// The directory is only empty after its temp file is gone, so the
			// unlink must happen before the rmdir.
			expect(vi.mocked(fs.unlink).mock.invocationCallOrder[0]).toBeLessThan(
				vi.mocked(fs.rmdir).mock.invocationCallOrder[0],
			)
		})

		it("does not remove a staging directory it did not create when a caller-staged write fails", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			const callerTemp = "/tmp/test-dir/caller-staged.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(fs.rename).mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }))

			await expect(
				safeWriteText(targetPath, "hello", { platform: "linux", tempPath: callerTemp }),
			).rejects.toThrow("EACCES")

			// The caller owns that directory: only the caller's temp file is cleaned,
			// never a rmdir of a directory safeWriteText never created.
			expect(fs.unlink).toHaveBeenCalledWith(callerTemp)
			expect(fs.rmdir).not.toHaveBeenCalled()
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
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), targetPath)
			// The title promises the order, so compare the invocations rather than
			// only count them: a rename before closeSync, or a close before fsync,
			// would not be a durable commit.
			const fsyncOrder = vi.mocked(fsSync.fsyncSync).mock.invocationCallOrder[0]
			const closeOrder = vi.mocked(fsSync.closeSync).mock.invocationCallOrder[0]
			const renameOrder = vi.mocked(fs.rename).mock.invocationCallOrder[0]
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

		it("a post-commit backup cleanup failure is non-fatal: the target stays committed and no temp is left behind", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// The post-commit backup unlink (SUT step 6) fails — the write must
			// still succeed; an orphaned backup is the documented acceptable
			// outcome, so the failure is swallowed instead of rolling back.
			vi.mocked(fs.unlink).mockRejectedValueOnce(new Error("EPERM"))

			await safeWriteText(targetPath, "data", { backup: true, platform: "linux" })

			// the commit rename (temp -> target) still happened; it is the only rename
			expect(fs.rename).toHaveBeenCalledTimes(1)
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), targetPath)

			// the failing cleanup was the post-commit backup unlink
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.bak_"))

			// the staging temp was already committed by the rename; nothing
			// temp-shaped is unlinked afterwards
			expect(fs.unlink).not.toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"))
		})
	})

	// ── Test 4: backup:true keeps old safeWriteJson semantics incl. rollback ──

	describe("backup:true", () => {
		it("copies target -> backup before commit without moving the target, deletes the copy on success", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			await safeWriteText(targetPath, "new data", { backup: true })

			// target was accessed (exists check)
			expect(fs.access).toHaveBeenCalledWith(targetPath)

			// The backup is a copy: the canonical target is never moved away, so readers
			// never see a missing file and no later step can clobber a concurrent publish.
			expect(fs.copyFile).toHaveBeenCalledWith(targetPath, expect.stringContaining("safeWriteText.bak_"))
			expect(fs.rename).not.toHaveBeenCalledWith(targetPath, expect.stringContaining("safeWriteText.bak_"))

			// the only rename is the atomic commit temp -> target
			expect(fs.rename).toHaveBeenCalledTimes(1)
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), targetPath)

			// backup copy was deleted on success
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.bak_"))
		})

		it("a failed commit does not move the target, so nothing has to be rolled back", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// The commit rename is the only rename in the flow and it fails.
			vi.mocked(fs.rename).mockRejectedValue(new Error("ENOSPC"))

			await expect(safeWriteText(targetPath, "new data", { backup: true })).rejects.toThrow("ENOSPC")

			// The target never left its path, so there is no restore rename and the
			// pre-write content is still what a reader sees at targetPath.
			expect(fs.rename).toHaveBeenCalledTimes(1)
			expect(fs.copyFile).toHaveBeenCalledWith(targetPath, expect.stringContaining("safeWriteText.bak_"))

			// Both the backup copy and the staging temp are cleaned up on failure.
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.bak_"))
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"))
		})

		it("retries the post-commit backup removal and succeeds when the retry clears", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			const backupUnlinks: string[] = []
			vi.mocked(fs.unlink).mockImplementation(async (candidate: unknown) => {
				const asString = String(candidate)
				if (asString.includes("safeWriteText.bak_")) {
					backupUnlinks.push(asString)
					// The first attempt hits a transient Windows handle; the retry succeeds.
					if (backupUnlinks.length === 1) {
						throw Object.assign(new Error("EBUSY"), { code: "EBUSY" })
					}
				}
			})

			await safeWriteText(targetPath, "new data", { backup: true })

			expect(backupUnlinks).toHaveLength(2)
		})

		it("surfaces an orphaned pre-write copy instead of returning success", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(fs.unlink).mockImplementation(async (candidate: unknown) => {
				if (String(candidate).includes("safeWriteText.bak_")) {
					throw Object.assign(new Error("EPERM"), { code: "EPERM" })
				}
			})

			const error = await safeWriteText(targetPath, "new data", { backup: true }).catch(
				(caught: unknown) => caught,
			)

			expect(error).toBeInstanceOf(OrphanedPublishedBackupError)
			const orphan = error as OrphanedPublishedBackupError
			expect(orphan.orphanedBackupPath).toContain("safeWriteText.bak_")
			expect(orphan.publishedPath).toBe(targetPath)
			// Two attempts, then the failure is reported instead of swallowed.
			expect(
				vi.mocked(fs.unlink).mock.calls.filter((call) => String(call[0]).includes("safeWriteText.bak_")),
			).toHaveLength(2)
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
		})

		it("a failed backup flush is reported and leaves no partial backup behind", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// The copy lands, but the fsync of the copy fails: the retained content is not
			// known to be durable, so the write must not proceed on a half-written backup.
			// The staged temp is fsynced earlier with a different handle, so target the
			// backup's fd specifically.
			vi.mocked(fsSync.openSync).mockImplementation((p: unknown) =>
				String(p).includes("safeWriteText.bak_") ? 7 : 1,
			)
			vi.mocked(fsSync.fsyncSync).mockImplementation((fd: unknown) => {
				if (fd === 7) {
					throw new Error("EIO")
				}
			})

			await expect(safeWriteText(targetPath, "new data", { backup: true, platform: "linux" })).rejects.toThrow(
				"EIO",
			)

			// Nothing was published, and the incomplete copy is removed rather than left
			// next to the target looking like a usable backup.
			expect(fs.rename).not.toHaveBeenCalled()
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.bak_"))
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"))
		})

		it("carries the leftover path when the partial backup cannot be removed either", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockImplementation((p: unknown) =>
				String(p).includes("safeWriteText.bak_") ? 7 : 1,
			)
			vi.mocked(fsSync.fsyncSync).mockImplementation((fd: unknown) => {
				if (fd === 7) {
					throw new Error("EIO")
				}
			})
			let unlinkAttempts = 0
			vi.mocked(fs.unlink).mockImplementation(async (p: unknown) => {
				if (String(p).includes("safeWriteText.bak_")) {
					unlinkAttempts++
				}
				throw Object.assign(new Error("EPERM"), { code: "EPERM" })
			})

			// The copy failed and the locked leftover could not be unlinked even after the
			// retry. Dropping the path would leave a partial copy of the previous content on
			// disk with no reference to it anywhere, so the error carries it.
			const error = await safeWriteText(targetPath, "new data", {
				backup: true,
				platform: "linux",
			}).catch((caught: unknown) => caught)

			expect(error).toBeInstanceOf(OrphanedBackupError)
			const orphan = error as OrphanedBackupError
			expect(orphan.orphanedBackupPath).toContain("safeWriteText.bak_")
			expect(orphan.message).toContain("safeWriteText.bak_")
			expect(orphan.message).toContain("EPERM")
			expect(orphan.originalError).toBeInstanceOf(Error)
			expect((orphan.originalError as Error).message).toBe("EIO")
			expect(orphan.cause).toBe(orphan.originalError)
			expect(unlinkAttempts).toBe(2)
			expect(fs.rename).not.toHaveBeenCalled()
		})

		it("refuses a backup name another writer already owns instead of unlinking it", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			// The exclusive seed open hits a backup name this write never created.
			vi.mocked(fsSync.openSync).mockImplementation((...args: unknown[]) => {
				if (typeof args[0] === "string" && args[0].includes("safeWriteText.bak_")) {
					throw Object.assign(new Error("EEXIST"), { code: "EEXIST" })
				}
				return 1
			})

			const error = await safeWriteText(targetPath, "new data", {
				backup: true,
				platform: "linux",
			}).catch((caught: unknown) => caught)

			expect((error as Error).message).toContain("EEXIST")
			// The name is not this write's orphan: unlinking it on the way out would
			// delete another writer's backup to clean up a file this write never made.
			const backupUnlinks = vi.mocked(fs.unlink).mock.calls.filter(function (call: unknown[]) {
				return typeof call[0] === "string" && call[0].includes("safeWriteText.bak_")
			})
			expect(backupUnlinks).toHaveLength(0)
			expect(fs.copyFile).not.toHaveBeenCalled()
			expect(fs.rename).not.toHaveBeenCalled()
		})

		it("reports a backup copy it cannot remove after a failed write instead of dropping it", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// The copy is seeded and flushed fine; only its removal on the failure
			// path fails, twice, with the same handle-not-released error Windows
			// reports for a fresh file.
			vi.mocked(fs.unlink).mockImplementation(async (p: unknown) => {
				if (String(p).includes("safeWriteText.bak_")) {
					throw Object.assign(new Error("EPERM"), { code: "EPERM" })
				}
			})
			// The commit is what fails here, so nothing was published.
			vi.mocked(fs.rename).mockRejectedValue(Object.assign(new Error("EIO"), { code: "EIO" }))

			const error = await safeWriteText(targetPath, "new data", {
				backup: true,
				platform: "linux",
			}).catch((caught: unknown) => caught)

			expect(error).toBeInstanceOf(OrphanedBackupAfterFailedWriteError)
			const orphan = error as OrphanedBackupAfterFailedWriteError
			expect(orphan.orphanedBackupPath).toContain("safeWriteText.bak_")
			expect(orphan.message).toContain("safeWriteText.bak_")
			expect(orphan.message).toContain("EPERM")
			// The write's own failure stays the primary fact: it travels as
			// originalError and as the cause, and cleanupError says why the copy
			// is still on disk.
			expect((orphan.originalError as Error).message).toBe("EIO")
			expect((orphan.cleanupError as Error).message).toBe("EPERM")
			expect(orphan.cause).toBe(orphan.originalError)
			// The commit never succeeded, so the target still holds the previous
			// content and the copy duplicates it rather than going stale.
			expect(orphan.contentPublished).toBe(false)
			const backupUnlinks = vi.mocked(fs.unlink).mock.calls.filter(function (call: unknown[]) {
				return typeof call[0] === "string" && call[0].includes("safeWriteText.bak_")
			})
			expect(backupUnlinks).toHaveLength(2)
			// Reporting the leftover must not skip cleaning the write's own staged
			// file and staging directory: both ran before the leftover was reported.
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"))
			expect(fs.rmdir).toHaveBeenCalled()
		})

		it("a backup copy that fails part-way is removed, not left as a usable-looking backup", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// The destination is seeded with openSync("wx") BEFORE any content exists at it,
			// and the copy then fails part-way: the name is there, holding a partial copy of
			// nothing usable. Cleanup has to key off the attempt, not off a copy that
			// succeeded, or this file outlives the failed write beside the target.
			vi.mocked(fs.copyFile).mockRejectedValue(Object.assign(new Error("EIO"), { code: "EIO" }))

			await expect(safeWriteText(targetPath, "new data", { backup: true, platform: "linux" })).rejects.toThrow(
				"EIO",
			)

			// Nothing was published, and the half-written copy is removed rather than left
			// next to the target looking like a backup someone could restore.
			expect(fs.rename).not.toHaveBeenCalled()
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.bak_"))
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"))
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

		it("win32 DACL failure refuses the publish instead of renaming over the target", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// icacls dump fails — the callback-based mock must invoke cb with an error.
			vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
				if (typeof cb === "function") cb(new Error("icacls error"), "", "")
				return fakeChild
			})

			// Captured once: calling safeWriteText twice here would double-count the single
			// icacls attempt asserted below.
			const refusal = await safeWriteText(targetPath, "data", { platform: "win32" }).catch(
				(error: unknown) => error,
			)

			expect(refusal).toBeInstanceOf(DaclInspectionError)
			// The class alone does not pin the contract: swapping the phase or dropping the
			// target path still satisfies toBeInstanceOf, and both are caller-visible - the
			// phase says which check refused, the path names the file the caller must not
			// assume was saved.
			expect(refusal).toMatchObject({
				name: "DaclInspectionError",
				phase: "save",
				targetPath,
				message: expect.stringContaining("its DACL could not be saved"),
			})

			// The refusal names the phase and the path but not what icacls did. The
			// platform failure travels on the error so a caller can tell a refused
			// icacls from an icacls that could not be started at all.
			const cause = (refusal as DaclInspectionError).causeError
			expect(cause).toBeInstanceOf(Error)
			expect((cause as Error).message).toBe("icacls error")

			// Contract change (Security Boundaries row): a target whose DACL could not be
			// saved is no longer replaced by a file that inherits different rights.
			expect(fs.rename).not.toHaveBeenCalled()
			// one icacls attempt only: a failed capture must not try to restore
			expect(execFile).toHaveBeenCalledTimes(1)
		})

		it("win32 DACL: a partial dump left by a failed save is removed and the publish is refused", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// icacls save fails - a real icacls may have written a partial dump
			// before erroring, so the dump path must be cleaned up and must never
			// be used for a restore.
			vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
				if (typeof cb === "function") cb(new Error("icacls save error"), "", "")
				return fakeChild
			})

			const refusal = await safeWriteText(targetPath, "data", { platform: "win32" }).catch(
				(error: unknown) => error,
			)

			// The contract changed with the refusal: a target whose DACL could not be captured is
			// not replaced by a file that inherits different rights, so no rename happens at all.
			expect(refusal).toBeInstanceOf(DaclInspectionError)
			expect(refusal).toMatchObject({ name: "DaclInspectionError", phase: "save", targetPath })
			expect(fs.rename).not.toHaveBeenCalled()
			expect(execFile).toHaveBeenCalledTimes(1)
			const saveArgs = vi.mocked(execFile).mock.calls[0]?.[1]
			expect(saveArgs?.[1]).toBe("/save")
			// the dump path (possibly partially created by icacls) was unlinked
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.acl"))
		})
		it("win32: refuses the publish when the target exists but its access rights cannot be read", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// The target exists but is not readable: that is not "absent", and skipping DACL
			// preservation has to stop the publish rather than be reported beside it.
			vi.mocked(fs.access).mockImplementation(async (p) => {
				if (String(p) === targetPath) {
					throw Object.assign(new Error("EACCES"), { code: "EACCES" })
				}
				return undefined
			})

			// Captured once: a second call would double-count the assertions below.
			const refusal = await safeWriteText(targetPath, "data", { platform: "win32" }).catch(
				(error: unknown) => error,
			)

			expect(refusal).toBeInstanceOf(DaclInspectionError)
			// The class alone does not pin the contract: the phase says which check refused and
			// the path names the file the caller must not assume was saved.
			expect(refusal).toMatchObject({
				name: "DaclInspectionError",
				phase: "inspect",
				targetPath,
				message: expect.stringContaining("its access rights could not be checked"),
			})

			// The publish is refused before any icacls runs, and nothing is renamed.
			expect(execFile).not.toHaveBeenCalled()
			expect(fs.rename).not.toHaveBeenCalled()
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
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), targetPath)
			expect(fs.rename).toHaveBeenCalledTimes(1)

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

			const customTempPath = "/tmp/test-dir/custom-temp.tmp"

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

			const customTempPath = "/tmp/test-dir/custom-temp.tmp"

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

			const customTempPath = "/tmp/test-dir/custom-temp.tmp"

			await safeWriteText(targetPath, "", { tempPath: customTempPath, platform: "linux" })

			// no existing target, so nothing to preserve and no fchmod on the temp
			expect(fsSync.fchmodSync).not.toHaveBeenCalled()
			expect(fs.rename).toHaveBeenCalledWith(customTempPath, targetPath)
		})

		it("propagates a non-ENOENT stat failure rather than defaulting the mode (caller-staged)", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
			vi.mocked(fsSync.statSync).mockImplementation(() => {
				throw eacces
			})
			vi.mocked(fsSync.openSync).mockReturnValue(2)

			const customTempPath = "/tmp/test-dir/custom-temp.tmp"

			// A target that cannot be stat'd is not a fresh target: publishing with
			// the default mode would widen a restrictive target through the rename.
			await expect(
				safeWriteText(targetPath, "", { tempPath: customTempPath, platform: "linux" }),
			).rejects.toThrow("EACCES")
			expect(fsSync.fchmodSync).not.toHaveBeenCalled()
			expect(fs.rename).not.toHaveBeenCalled()
		})

		it("propagates a non-ENOENT stat failure rather than defaulting the mode (self-staged)", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			const eio = Object.assign(new Error("EIO: i/o error"), { code: "EIO" })
			vi.mocked(fsSync.statSync).mockImplementation(() => {
				throw eio
			})

			// The mode is read before the temp is opened, so a real I/O failure stops
			// the write before anything is staged.
			await expect(safeWriteText(targetPath, "hello world", { platform: "linux" })).rejects.toThrow("EIO")
			expect(fsSync.openSync).not.toHaveBeenCalled()
			expect(fs.rename).not.toHaveBeenCalled()
		})

		it("opens the temp before applying a read-only target's mode (0o444 does not block the open)", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.statSync).mockReturnValue(_stats(0o444))
			vi.mocked(fsSync.openSync).mockReturnValue(3)

			const customTempPath = "/tmp/test-dir/custom-temp.tmp"

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

		it("applies the existing target's exact mode to the self-staged temp (umask must not narrow it)", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.statSync).mockReturnValue(_stats(0o664))
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			await safeWriteText(targetPath, "data", { platform: "linux" })

			// openSync's creation mode is narrowed by the process umask (0o664 -> 0o644 with
			// the common 0o022), and the rename publishes the temp's mode onto the target,
			// so the existing target's mode must be applied on the fd before the commit.
			expect(fsSync.fchmodSync).toHaveBeenCalledWith(1, 0o664)
			const openIdx = vi.mocked(fsSync.openSync).mock.invocationCallOrder[0]
			const fchmodIdx = vi.mocked(fsSync.fchmodSync).mock.invocationCallOrder[0]
			expect(openIdx).toBeLessThan(fchmodIdx)
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), targetPath)
		})

		it("a failed post-commit directory fsync does not roll the backup back over the published content", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			const dirPath = path.dirname(targetPath)
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			// The file fd opens normally; the parent-directory open after the commit
			// rename fails, which is the post-commit durability failure.
			vi.mocked(fsSync.openSync).mockImplementation((target) => {
				if (String(target) === dirPath) throw new Error("EBADF")
				return 1
			})

			await expect(safeWriteText(targetPath, "new data", { backup: true, platform: "linux" })).rejects.toThrow(
				PostCommitDurabilityError,
			)

			// The commit rename already published the new content, and the backup was only
			// ever a copy: the target was never moved, so there is nothing to rename back.
			expect(fs.copyFile).toHaveBeenCalledWith(targetPath, expect.stringContaining("safeWriteText.bak_"))
			expect(fs.rename).toHaveBeenCalledTimes(1)
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), targetPath)

			// The durability failure is reported, not swallowed - and the backup copy is not
			// left beside the target where no caller could find it.
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.bak_"))
		})

		it("does not fchmod the self-staged temp for a fresh target", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
			vi.mocked(fsSync.statSync).mockImplementation(() => {
				throw enoent
			})
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			await safeWriteText(targetPath, "data", { platform: "linux" })

			// Nothing exists to preserve: the default creation mode is the intended one.
			expect(fsSync.fchmodSync).not.toHaveBeenCalled()
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
			// lstat reports the path itself as absent, so this is a new target and
			// the fallback is allowed.
			vi.mocked(fs.lstat).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			await safeWriteText(targetPath, "data", { platform: "linux" })

			// rename still happened with the fallback path (path.resolve on /tmp → C:\tmp)
			const resolvedFallback = _resolvedTarget(targetPath)
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), resolvedFallback)
		})

		it("propagates a dangling symlink instead of writing through the link path", async () => {
			// realpath resolves the referent, so a link whose target is missing reports
			// ENOENT. Falling back to the link path would replace the symlink with a
			// regular file, so the error must propagate and nothing may be committed.
			const linkPath = "/tmp/test-dir/dangling-link.txt"
			vi.mocked(fs.realpath).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
			const linkStats = Object.create(fsSync.Stats.prototype) as fsSync.Stats
			linkStats.isSymbolicLink = () => true
			vi.mocked(fs.lstat).mockResolvedValue(linkStats)
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			await expect(safeWriteText(linkPath, "data", { platform: "linux" })).rejects.toThrow("ENOENT")

			expect(fs.rename).not.toHaveBeenCalled()
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

		it("stops instead of looping when a write makes no progress at all", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			const content = "abcdefg" // 7 bytes
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// Every write reports zero bytes. The short-write loop is bounded by
			// offset < buffer.length only, so a zero return would spin on the same
			// offset forever, holding the fd and the event loop.
			vi.mocked(fsSync.writeSync).mockReturnValue(0)

			const error = await safeWriteText(targetPath, content, {
				platform: "linux",
			}).catch((caught: unknown) => caught)

			expect(error).toBeInstanceOf(Error)
			expect((error as Error).message).toContain("stalled after 0 of 7 bytes")
			// The stalled staging file never reached durability or the commit.
			expect(fsSync.fsyncSync).not.toHaveBeenCalled()
			expect(fs.rename).not.toHaveBeenCalled()
			// The finally around the write closes the descriptor, so a stalled write
			// strands neither the fd nor the process.
			expect(fsSync.closeSync).toHaveBeenCalledWith(1)
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

		it("reports a failed parent-directory fsync instead of claiming a durable write", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync)
				.mockReturnValueOnce(1)
				.mockImplementationOnce(() => {
					throw new Error("EBADF")
				})

			// The content rename committed, so the caller can still find the data at
			// the target; what the write cannot claim is that the directory entry
			// reached the disk. Returning success here would claim durability the
			// filesystem did not grant.
			await expect(safeWriteText(targetPath, "data", { platform: "linux" })).rejects.toThrow(
				PostCommitDurabilityError,
			)

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

	it("a failed post-commit directory fsync never unlinks the committed target", async () => {
		const targetPath = "/tmp/test-dir/target.txt"
		const dirPath = path.dirname(targetPath)
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
		vi.mocked(fsSync.openSync).mockImplementation((target) => {
			if (String(target) === dirPath) throw new Error("EBADF")
			return 1
		})

		await expect(safeWriteText(targetPath, "new data", { backup: true, platform: "linux" })).rejects.toThrow(
			PostCommitDurabilityError,
		)

		// The commit state is what cleanup is allowed to act on: the staging file may be
		// unlinked only while it is still the staging file. Once the rename has committed,
		// the only path this write owns at the target is the published content itself, and
		// removing it would turn a durability warning into data loss.
		expect(fs.unlink).not.toHaveBeenCalledWith(targetPath)
	})

	it("a failed post-commit directory fsync does not unlink the staging path this write no longer owns", async () => {
		const targetPath = "/tmp/test-dir/target.txt"
		const dirPath = path.dirname(targetPath)
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
		// A caller-supplied staging file: the name is the caller's, not one this write made
		// up, so after the commit it is a path another writer may already be using again.
		// The caller's staging file sits beside the target, as this contract requires.
		const suppliedTemp = path.join(dirPath, "caller.new_data.json")
		vi.mocked(fsSync.openSync).mockImplementation((target) => {
			if (String(target) === dirPath) throw new Error("EBADF")
			return 1
		})

		await expect(
			safeWriteText(targetPath, "new data", { backup: true, platform: "linux", tempPath: suppliedTemp }),
		).rejects.toThrow(PostCommitDurabilityError)

		// The rename consumed the staging file; the commit is what says so. Unlinking the
		// staging NAME afterwards is an unlink of whatever now answers to that name.
		expect(fs.unlink).not.toHaveBeenCalledWith(suppliedTemp)
		expect(fs.unlink).not.toHaveBeenCalledWith(targetPath)
	})

	describe("content bytes", () => {
		const targetPath = "/tmp/enc-dir/target.txt"

		beforeEach(() => {
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
		})

		it("stages UTF-8 bytes for string content", async () => {
			await safeWriteText(targetPath, "héllo", { platform: "linux" })
			expect(fsSync.writeSync).toHaveBeenCalledWith(1, Buffer.from("héllo", "utf8"), 0, 6)
		})

		it("publishes caller-supplied bytes unchanged instead of re-encoding them", async () => {
			// The extension host encodes a document with VS Code's own codec, which
			// covers the legacy code pages and BOMs Node cannot represent, and hands
			// the result over: those bytes must reach the commit rename exactly as
			// they were given.
			const bytes = Buffer.from([0x00, 0x68, 0x00, 0x69])
			await safeWriteText(targetPath, bytes, { platform: "linux" })
			expect(fsSync.writeSync).toHaveBeenCalledWith(1, bytes, 0, 4)
		})
	})
	it("a no-replace commit links the staged file into place when the target is absent", async () => {
		// Isolate the commit-phase counters from any async cleanup a previous
		// test left in flight.
		vi.mocked(fs.rename).mockClear()
		vi.mocked(fs.unlink).mockClear()
		const targetPath = "/tmp/test-dir/target.txt"
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)

		await safeWriteText(targetPath, "new data", { failIfExist: true, platform: "linux" })

		// link(2) is the only atomic no-replace publish: a rename would displace a
		// target that appeared after the caller's absence check.
		expect(fs.link).toHaveBeenCalledWith(expect.stringContaining("safeWriteText"), targetPath)
		expect(fs.rename).not.toHaveBeenCalled()
		// The staged copy is dropped once the name points at it.
		expect(
			vi.mocked(fs.unlink).mock.calls.some(function (call) {
				return String(call[0]).includes("safeWriteText")
			}),
		).toBe(true)
	})

	it("a no-replace commit refuses a target that appeared after the caller checked", async () => {
		// Isolate the commit-phase counters from any async cleanup a previous
		// test left in flight.
		vi.mocked(fs.rename).mockClear()
		vi.mocked(fs.unlink).mockClear()
		const targetPath = "/tmp/test-dir/target.txt"
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
		vi.mocked(fs.link).mockRejectedValue(Object.assign(new Error("EEXIST"), { code: "EEXIST" }))
		// The failure path still cleans up its staging file and directory; keep those
		// promises real so the cleanup does not mask the rejection under test.
		vi.mocked(fs.unlink).mockResolvedValue(undefined)
		vi.mocked(fs.rmdir).mockResolvedValue(undefined)

		const error = await safeWriteText(targetPath, "new data", {
			failIfExist: true,
			platform: "linux",
		}).catch((caught: unknown) => caught)

		expect(error).toBeInstanceOf(TargetExistsError)
		expect((error as TargetExistsError).targetPath).toBe(targetPath)
		// Nothing replaced the newer file, and the staged copy is not left behind.
		expect(fs.rename).not.toHaveBeenCalled()
		expect(
			vi.mocked(fs.unlink).mock.calls.some(function (call) {
				return String(call[0]).includes("safeWriteText")
			}),
		).toBe(true)
	})

	it("resolves an absent target through a symlinked ancestor to the canonical path", async () => {
		// The guard pins the publish to the canonical nearest-ancestor path. An absent
		// target has to resolve to that same path, or a create through a symlinked
		// ancestor aborts with TargetMovedError although nothing moved.
		const linkDir = path.resolve("/tmp/link-dir")
		const canonicalDir = path.resolve("/real/dir")
		const canonical = path.join(canonicalDir, "target.txt")
		vi.mocked(fs.realpath).mockImplementation(async (p: unknown) => {
			if (String(p) === path.join(linkDir, "target.txt")) {
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
			}
			if (String(p) === linkDir) return canonicalDir
			return String(p)
		})
		vi.mocked(fs.lstat).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

		await safeWriteText(path.join(linkDir, "target.txt"), "new data", {
			expectedResolvedPath: canonical,
			platform: "linux",
		})

		expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText"), canonical)
	})

	it("fails closed when the filesystem has no atomic no-replace primitive", async () => {
		// FAT32/exFAT and some SMB mounts reject link(2). Publishing by an exclusive
		// copy would put bytes at the final name that readers can observe mid-copy,
		// and a crash or an EIO mid-copy leaves damaged bytes there with the
		// 'already exists' verdict on retry. No atomic no-replace primitive exists
		// on those volumes, so the guarded create refuses to publish at all.
		const targetPath = "/tmp/test-dir/target.txt"
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
		vi.mocked(fs.link).mockRejectedValue(Object.assign(new Error("ENOTSUP"), { code: "ENOTSUP" }))

		await expect(
			safeWriteText(targetPath, "new data", { failIfExist: true, platform: "linux" }),
		).rejects.toBeInstanceOf(UnsupportedFilesystemError)

		// Nothing was published: no copy at the final name, no rename - the name
		// stays absent for a retry on a capable volume.
		// Every "no hard links here" code takes the same fail-closed path.
		for (const code of ["EPERM", "ENOTSUP", "ENOSYS"]) {
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fs.link).mockRejectedValue(Object.assign(new Error(code), { code }))

			await expect(
				safeWriteText(targetPath, "new data", { failIfExist: true, platform: "linux" }),
			).rejects.toBeInstanceOf(UnsupportedFilesystemError)
		}
		expect(fs.copyFile).not.toHaveBeenCalled()
		expect(fs.rename).not.toHaveBeenCalled()
		// Every code reached the link path (the first call plus the three codes
		// below), so the loop above really exercised all four refusals.
		expect(fs.link).toHaveBeenCalledTimes(4)
		// The refusal must not leave its staging file or directory beside the
		// target: a regression here would drop a .file-safety-staging_* directory
		// on FAT32/exFAT/SMB volumes after every refused create.
		expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"))
		const stagedDirs = vi.mocked(fsSync.mkdirSync).mock.calls.map((call) => String(call[0]))
		expect(vi.mocked(fs.rmdir).mock.calls.map((call) => String(call[0]))).toEqual(stagedDirs)
	})
	it("still reports success when the staged copy cannot be unlinked after the link", async () => {
		// An antivirus handle on Windows can make unlink fail with EBUSY after link(2)
		// published the name. The content is readable at the target, so the write must
		// not be reported as a failure the model then retries into an 'already exists'.
		const targetPath = "/tmp/test-dir/target.txt"
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
		vi.mocked(fs.unlink).mockRejectedValue(Object.assign(new Error("EBUSY"), { code: "EBUSY" }))

		await expect(
			safeWriteText(targetPath, "new data", { failIfExist: true, platform: "linux" }),
		).resolves.toBeUndefined()
		expect(fs.link).toHaveBeenCalledWith(expect.stringContaining("safeWriteText"), targetPath)
	})

	it("refuses to publish when the path no longer resolves to the authorized target", async () => {
		// Isolate the commit-phase counters from any async cleanup a previous test left
		// in flight.
		vi.mocked(fs.rename).mockClear()
		vi.mocked(fs.link).mockClear()
		const authorized = "/tmp/test-dir/target.txt"
		// The caller authorized this path while it was a real file in the workspace; by the
		// time the publish resolves it, a local process has swapped in a link to somewhere
		// else. The decision was never made about that other file, so nothing is published.
		vi.mocked(fs.realpath).mockResolvedValue("/outside/the-victim.txt")

		const error = await safeWriteText(authorized, "new data", {
			expectedResolvedPath: authorized,
			platform: "linux",
		}).catch((caught: unknown) => caught)

		expect(error).toBeInstanceOf(TargetMovedError)
		const moved = error as TargetMovedError
		expect(moved.authorizedPath).toBe(authorized)
		expect(moved.resolvedPath).toBe("/outside/the-victim.txt")
		expect(moved.message).toContain("/outside/the-victim.txt")
		expect(fs.rename).not.toHaveBeenCalled()
		expect(fs.link).not.toHaveBeenCalled()
		// Nothing was staged either: the check runs before the staging directory is made.
		expect(fs.mkdir).not.toHaveBeenCalled()
	})

	it("refuses to publish when an authorized parent directory was replaced after the check", async () => {
		// expectedResolvedPath pins the NAME being published, so it cannot notice the
		// directory the name lives in being swapped for another one (a link to outside the
		// workspace looks exactly like this). The recorded ancestor identities are what
		// catch it, and the commit is aborted before anything is moved into place.
		const dir = path.resolve("/tmp/test-dir")
		const targetPath = path.join(dir, "target.txt")
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
		vi.mocked(fs.rename).mockClear()
		vi.mocked(fs.link).mockClear()
		vi.mocked(fs.stat).mockResolvedValue(_dirIdentity(999n)) // was 100n when authorized

		const error = await safeWriteText(targetPath, "new data", {
			expectedResolvedPath: targetPath,
			expectedAncestorIdentities: [{ dir, dev: 1n, ino: 100n }],
			platform: "linux",
		}).catch((caught: unknown) => caught)

		expect(error).toBeInstanceOf(AncestorReplacedError)
		expect((error as AncestorReplacedError).directory).toBe(dir)
		expect((error as AncestorReplacedError).message).toContain("no longer the directory that was authorized")
		expect(fs.rename).not.toHaveBeenCalled()
		expect(fs.link).not.toHaveBeenCalled()
		// The staged copy is cleaned up rather than left beside the target.
		expect(vi.mocked(fs.unlink).mock.calls.some((call) => String(call[0]).includes("safeWriteText"))).toBe(true)
	})

	it("refuses to publish when an authorized ancestor name was moved and replaced by a link", async () => {
		// Moving a directory preserves (dev, ino), and replacing the old name with a
		// symlink to the moved location keeps the identity check matching - stat
		// follows the link. The commit takes path strings and would follow it too,
		// publishing at the moved location outside the chain the caller walked, so
		// the authorized name must still RESOLVE to the authorized location.
		const dir = path.resolve("/tmp/test-dir")
		const movedDir = path.resolve("/outside/workspace")
		const targetPath = path.join(dir, "target.txt")
		vi.mocked(fs.realpath).mockImplementation(async (p) =>
			path.resolve(String(p)) === dir ? movedDir : targetPath,
		)
		vi.mocked(fs.rename).mockClear()
		vi.mocked(fs.link).mockClear()
		vi.mocked(fs.stat).mockResolvedValue(_dirIdentity(100n)) // SAME identity as authorized

		const error = await safeWriteText(targetPath, "new data", {
			expectedResolvedPath: targetPath,
			expectedAncestorIdentities: [{ dir, dev: 1n, ino: 100n }],
			platform: "linux",
		}).catch((caught: unknown) => caught)

		expect(error).toBeInstanceOf(AncestorReplacedError)
		expect((error as AncestorReplacedError).message).toContain("no longer resolves to the authorized location")
		// Nothing was published at either location.
		expect(fs.rename).not.toHaveBeenCalled()
		expect(fs.link).not.toHaveBeenCalled()
	})

	it("propagates a transient realpath failure instead of reporting a replaced ancestor", async () => {
		// EACCES/EIO while re-validating the authorized ancestry is not a containment
		// violation: reporting AncestorReplacedError would point the user (and the
		// model) at a security problem that is not there.
		const dir = path.resolve("/tmp/test-dir")
		const targetPath = path.join(dir, "target.txt")
		const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
		vi.mocked(fs.realpath).mockImplementation(async (p) => {
			if (path.resolve(String(p)) === dir) throw denied
			return targetPath
		})
		vi.mocked(fs.stat).mockResolvedValue(_dirIdentity(100n))

		const error = await safeWriteText(targetPath, "new data", {
			expectedResolvedPath: targetPath,
			expectedAncestorIdentities: [{ dir, dev: 1n, ino: 100n }],
			platform: "linux",
		}).catch((caught: unknown) => caught)

		expect(error).toBe(denied)
		expect(fs.rename).not.toHaveBeenCalled()
		expect(fs.link).not.toHaveBeenCalled()
	})

	it("publishes when the recorded ancestor identities are unchanged", async () => {
		// The pin must not turn every guarded write into a false rejection: an unchanged
		// directory chain publishes normally.
		const dir = path.resolve("/tmp/test-dir")
		const targetPath = path.join(dir, "target.txt")
		// The unchanged chain resolves where it names: the ancestor realpath check
		// sees the authorized directory itself, not a moved location.
		vi.mocked(fs.realpath).mockImplementation(async (p) => (path.resolve(String(p)) === dir ? dir : targetPath))
		vi.mocked(fs.stat).mockResolvedValue(_dirIdentity(100n))

		await safeWriteText(targetPath, "new data", {
			expectedResolvedPath: targetPath,
			expectedAncestorIdentities: [{ dir, dev: 1n, ino: 100n }],
			platform: "linux",
		})

		expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText"), targetPath)
	})

	it("publishes when a pinned ancestor is a stable symlink alias", async () => {
		// A caller that authorized a chain running THROUGH an alias records the alias spelling as
		// dir and the location that alias resolves to as resolvedPath. The alias's realpath differs
		// from dir by definition while nothing moved, so comparing realpath(dir) against dir alone
		// refused a write whose ancestry and target never changed. The (dev, ino) check is what
		// still catches the alias being re-pointed; this row is the control on that.
		const aliasDir = path.resolve("/tmp/alias-dir")
		const realDir = path.resolve("/tmp/real-dir")
		const targetPath = path.join(aliasDir, "target.txt")
		vi.mocked(fs.realpath).mockImplementation(async (p: unknown) =>
			path.resolve(String(p)) === aliasDir ? realDir : targetPath,
		)
		vi.mocked(fs.stat).mockResolvedValue(_dirIdentity(100n))
		vi.mocked(fs.rename).mockClear()
		vi.mocked(fs.link).mockClear()

		await safeWriteText(targetPath, "new data", {
			expectedResolvedPath: targetPath,
			expectedAncestorIdentities: [{ dir: aliasDir, dev: 1n, ino: 100n, resolvedPath: realDir }],
			platform: "linux",
		})

		expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText"), targetPath)
	})

	it("refuses the publish when a pinned alias no longer resolves to the authorized location", async () => {
		// resolvedPath has to stay a comparison, not an escape hatch: an alias re-pointed to a third
		// location resolves to neither the location it was authorized against nor its own spelling,
		// and the commit must stop there instead of publishing through the new link.
		const aliasDir = path.resolve("/tmp/alias-dir")
		const authorizedLocation = path.resolve("/tmp/real-dir")
		const repointedTo = path.resolve("/tmp/elsewhere-dir")
		const targetPath = path.join(aliasDir, "target.txt")
		vi.mocked(fs.realpath).mockImplementation(async (p: unknown) =>
			path.resolve(String(p)) === aliasDir ? repointedTo : targetPath,
		)
		vi.mocked(fs.stat).mockResolvedValue(_dirIdentity(100n))
		vi.mocked(fs.rename).mockClear()
		vi.mocked(fs.link).mockClear()

		const error = await safeWriteText(targetPath, "new data", {
			expectedResolvedPath: targetPath,
			expectedAncestorIdentities: [{ dir: aliasDir, dev: 1n, ino: 100n, resolvedPath: authorizedLocation }],
			platform: "linux",
		}).catch((caught: unknown) => caught)

		expect(error).toBeInstanceOf(AncestorReplacedError)
		expect((error as AncestorReplacedError).message).toContain("no longer resolves to the authorized location")
		expect(fs.rename).not.toHaveBeenCalled()
		expect(fs.link).not.toHaveBeenCalled()
	})

	it("fsyncs every parent directory it had to create, not only the target's immediate parent", async () => {
		// The commit rename makes the entry INSIDE the immediate parent durable. A grandparent this
		// call created is itself an entry in ITS parent, so syncing only the immediate parent leaves
		// the newer ancestors unsynced: a crash can drop the chain and take the published file with
		// it. The double reports the two nested components as created, which is what mkdir answers
		// on the real filesystem, so the sync order is observable: deepest first, ending with the
		// directory that holds the outermost new entry. Only directories are opened with "r", so
		// the calls below are directory syncs and nothing else.
		const root = path.resolve("/tmp/test-dir")
		const nested = path.join(root, "nested")
		const deep = path.join(nested, "deep")
		const targetPath = path.join(deep, "target.txt")
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
		// The outermost component mkdir had to create, in the spelling Node answers with.
		vi.mocked(fs.mkdir).mockResolvedValue(nested)
		vi.mocked(fsSync.openSync).mockClear()
		// Distinct descriptors per directory, so a flush is attributable to the directory it belongs
		// to rather than being one indistinguishable call on an undefined handle.
		const dirDescriptors: Record<string, number> = { [deep]: 901, [nested]: 902, [root]: 903 }
		vi.mocked(fsSync.openSync).mockImplementation(function (p: unknown) {
			return dirDescriptors[path.resolve(String(p))] ?? 1
		})

		await safeWriteText(targetPath, "new data", { platform: "linux" })

		const dirSyncs = vi
			.mocked(fsSync.openSync)
			.mock.calls.filter(function (call: unknown[]) {
				return call[1] === "r"
			})
			.map(function (call: unknown[]) {
				return String(call[0])
			})
		expect(dirSyncs).toEqual([deep, nested, root])
		// The open list alone only proves handles were taken. The durable effect is the flush: a
		// production change that opened each created ancestor and closed it without fsyncing would leave
		// this row green while the chain it just created stayed volatile, so each descriptor the open
		// list names is pinned to its own flush and its own close, in the same deepest-first order.
		const dirFdSet = new Set([901, 902, 903])
		const dirFlushes = vi
			.mocked(fsSync.fsyncSync)
			.mock.calls.filter(function (call: unknown[]) {
				return dirFdSet.has(call[0] as number)
			})
			.map(function (call: unknown[]) {
				return call[0]
			})
		expect(dirFlushes).toEqual([901, 902, 903])
		const dirCloses = vi
			.mocked(fsSync.closeSync)
			.mock.calls.filter(function (call: unknown[]) {
				return dirFdSet.has(call[0] as number)
			})
			.map(function (call: unknown[]) {
				return call[0]
			})
		expect(dirCloses).toEqual([901, 902, 903])
	})

	// A row about what the Windows filesystem reports, so it belongs to the Windows leg: it is
	// gated exactly like the icacls rows in this describe. The marker is stripped by a string
	// comparison, but deciding WHICH directories the answer names walks the runner's own path
	// semantics, and on POSIX a drive-lettered path like "C:/test-dir/nested" is not even
	// absolute, so a marker built that way is an input the platform cannot produce. The option
	// keeps the write on the non-win32 durability branch - the branch this row is about - while
	// the runner supplies win32 path semantics. The POSIX spelling of the same answer is pinned
	// by the preceding row, and the answer this write cannot place by the row after it.
	it.skipIf(process.platform !== "win32")(
		"maps the namespace marker Windows reports for the directory it created",
		async () => {
			const nested = path.resolve("C:/test-dir/nested")
			const deep = path.join(nested, "deep")
			const targetPath = path.join(deep, "target.txt")
			const stripped = nested.startsWith("/") ? nested.slice(1) : nested
			const reported = "\\\\?\\" + stripped.split("/").join("\\")
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fs.mkdir).mockResolvedValue(reported)
			vi.mocked(fsSync.openSync).mockClear()

			await safeWriteText(targetPath, "new data", { platform: "linux" })

			const dirSyncs = vi
				.mocked(fsSync.openSync)
				.mock.calls.filter(function (call: unknown[]) {
					return call[1] === "r"
				})
				.map(function (call: unknown[]) {
					return String(call[0])
				})
			// The marker had to map onto the write's own paths: nothing under the marker is synced.
			expect(dirSyncs).toEqual([deep, nested, path.dirname(nested)])
			expect(
				dirSyncs.some(function (p: string) {
					return p.includes("?")
				}),
			).toBe(false)
		},
	)

	it("syncs no ancestor when mkdir names a directory this write cannot place", async () => {
		// The chain is derived by walking up from the target's own directory until it reaches what
		// mkdir reported. An answer that is not on that walk is not a directory this write created,
		// and it must not be synced: flushing a directory someone else owns, while the published
		// file's own new ancestors stay unsynced, is the opposite of what step 4b is for. Only the
		// immediate parent is flushed, because the commit rename put its entry there. Constructed
		// from path.resolve so the answer is absolute, and off the walk, on both platforms.
		const targetPath = path.join(path.resolve("/tmp/test-dir/deep"), "target.txt")
		const unrelated = path.resolve("/tmp/other-tree/nested")
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
		vi.mocked(fs.mkdir).mockResolvedValue(unrelated)
		vi.mocked(fsSync.openSync).mockClear()

		await safeWriteText(targetPath, "new data", { platform: "linux" })

		const dirSyncs = vi
			.mocked(fsSync.openSync)
			.mock.calls.filter(function (call: unknown[]) {
				return call[1] === "r"
			})
			.map(function (call: unknown[]) {
				return String(call[0])
			})
		expect(dirSyncs).toEqual([path.dirname(targetPath)])
		expect(
			dirSyncs.some(function (p: string) {
				return p.includes(unrelated)
			}),
		).toBe(false)
	})

	it("reports a post-commit durability failure together with the backup it cannot remove", async () => {
		// The commit rename succeeded and then the parent-directory fsync failed. Nothing is rolled
		// back - the published bytes stay at the target - and the failure path still removes the
		// backup. When that removal also fails the caller gets both facts: contentPublished says the
		// leftover is stale beside published content, and originalError names the durability failure.
		const targetPath = "/tmp/test-dir/target.txt"
		const eio = Object.assign(new Error("EIO"), { code: "EIO" })
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
		// Only directories are opened with "r", so this fd marks the post-commit directory sync:
		// the failure lands exactly after the rename instead of on the staged file's fsync.
		vi.mocked(fsSync.openSync).mockImplementation(function (p: unknown, flags?: unknown): number {
			return flags === "r" ? 77 : 1
		})
		vi.mocked(fsSync.fsyncSync).mockImplementation(function (fd: number): void {
			if (fd === 77) {
				throw eio
			}
		})
		vi.mocked(fs.unlink).mockImplementation(async (p: unknown) => {
			if (String(p).includes("safeWriteText.bak_")) {
				throw Object.assign(new Error("EPERM"), { code: "EPERM" })
			}
		})
		vi.mocked(fs.rename).mockClear()

		const error = await safeWriteText(targetPath, "new data", {
			backup: true,
			platform: "linux",
		}).catch((caught: unknown) => caught)

		expect(error).toBeInstanceOf(OrphanedBackupAfterFailedWriteError)
		const orphan = error as OrphanedBackupAfterFailedWriteError
		// The commit ran: the durability failure is downstream of the rename, not before it.
		expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText"), targetPath)
		expect(orphan.contentPublished).toBe(true)
		expect(orphan.originalError).toBeInstanceOf(PostCommitDurabilityError)
		expect((orphan.cleanupError as Error).message).toBe("EPERM")
		expect(orphan.message).toContain("the target holds the new content")
		// Both removal attempts ran, and the failure path still cleaned what it owned.
		const backupUnlinks = vi.mocked(fs.unlink).mock.calls.filter(function (call: unknown[]) {
			return typeof call[0] === "string" && call[0].includes("safeWriteText.bak_")
		})
		expect(backupUnlinks).toHaveLength(2)
		expect(fs.rmdir).toHaveBeenCalled()
	})

	it("refuses the publish when an authorized ancestor disappears before the commit", async () => {
		const dir = path.resolve("/tmp/test-dir")
		const targetPath = path.join(dir, "target.txt")
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
		vi.mocked(fs.stat).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

		const error = await safeWriteText(targetPath, "new data", {
			expectedResolvedPath: targetPath,
			expectedAncestorIdentities: [{ dir, dev: 1n, ino: 100n }],
			platform: "linux",
		}).catch((caught: unknown) => caught)

		expect(error).toBeInstanceOf(AncestorReplacedError)
		expect((error as AncestorReplacedError).message).toContain("no longer exists")
		expect(fs.rename).not.toHaveBeenCalled()
		expect(fs.link).not.toHaveBeenCalled()
	})
})

// ── Test 12: lock key, staging path, and post-commit durability ─────────────

describe("resolveLockKey", () => {
	beforeEach(() => mockDefaults())

	it("canonicalizes the parent directory, not just the file", async () => {
		vi.mocked(fs.realpath).mockImplementation(async (target) => {
			const key = String(target)
			if (key === "/tmp/linkdir/file.json") return "/real/dir/file.json"
			if (key === "/real/dir") return "/real/dir"
			return key
		})

		// The key is the canonical directory plus the basename, so a symlinked
		// ancestor and its referent share one lock.
		await expect(resolveLockKey("/tmp/linkdir/file.json")).resolves.toBe(path.join("/real/dir", "file.json"))
	})

	it("computes a key for a dangling link, which resolvePublishTarget refuses", async () => {
		const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
		vi.mocked(fs.realpath).mockRejectedValue(enoent)
		vi.mocked(fs.lstat).mockResolvedValue(_fileStats(true))
		// The walk ends when readlink throws, because a plain file is not a link.
		// Answering every call with the same value would let a walk that never
		// stopped return the same key, so the mock has to distinguish the link from
		// the referent and the test has to check that the walk stopped.
		const notALink = Object.assign(new Error("EINVAL: not a link"), { code: "EINVAL" })
		vi.mocked(fs.readlink).mockImplementation(async (target) => {
			if (String(target) === "/tmp/linkdir/file.json") return "referent.json"
			throw notALink
		})

		// Mid-commit a peer writer renames the referent away and back, so the key
		// must still be computable while the link dangles.
		await expect(resolveLockKey("/tmp/linkdir/file.json")).resolves.toBe(
			path.resolve(path.join("/tmp/linkdir", "referent.json")),
		)
		// Two calls means the walk stopped at the referent: the link, then one more
		// on the referent that reports it is not a link. A walk that never stopped
		// would run the full 8 steps.
		expect(fs.readlink).toHaveBeenCalledTimes(2)
	})

	it("terminates on a two-link cycle instead of walking forever", async () => {
		const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
		vi.mocked(fs.realpath).mockRejectedValue(enoent)
		vi.mocked(fs.lstat).mockResolvedValue(_fileStats(true))
		// Every readlink answers with the same link, so an unbounded walk would
		// never end; the bounded walk returns the key it actually reached.
		vi.mocked(fs.readlink).mockImplementation(async () => "a.json")

		await expect(resolveLockKey("/tmp/linkdir/a.json")).resolves.toBe(
			path.resolve(path.join("/tmp/linkdir", "a.json")),
		)
		expect(fs.readlink).toHaveBeenCalledTimes(8)
	})
})

describe("caller-supplied staging path", () => {
	beforeEach(() => mockDefaults())

	it("rejects a staging file outside the target's directory before writing anything", async () => {
		const targetPath = "/tmp/test-dir/target.txt"
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)

		// A rename across filesystems fails with EXDEV, and a path elsewhere lets
		// a caller publish an unrelated file onto the target.
		await expect(
			safeWriteText(targetPath, "data", { tempPath: "/tmp/other-dir/x.tmp", platform: "linux" }),
		).rejects.toThrow(StagingPathError)
		expect(fsSync.openSync).not.toHaveBeenCalled()
		expect(fs.rename).not.toHaveBeenCalled()
	})

	it("rejects a staging path that is a symlink", async () => {
		const targetPath = "/tmp/test-dir/target.txt"
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
		vi.mocked(fs.lstat).mockResolvedValue(_fileStats(true))

		// Renaming a link over the target publishes whatever the link points at.
		await expect(
			safeWriteText(targetPath, "data", { tempPath: "/tmp/test-dir/x.tmp", platform: "linux" }),
		).rejects.toThrow(StagingPathError)
		expect(fsSync.openSync).not.toHaveBeenCalled()
		expect(fs.rename).not.toHaveBeenCalled()
	})

	it("rejects a staging path that is the target itself", async () => {
		const targetPath = "/tmp/test-dir/target.txt"
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
		// Same inode and device for the supplied staging path and the target: the
		// failure handler would unlink the only copy of the content, so a failed
		// write would delete the file it was meant to protect.
		const stats = _fileIdentity(42n, 7n)
		vi.mocked(fs.lstat).mockResolvedValue(stats)

		await expect(safeWriteText(targetPath, "data", { tempPath: targetPath, platform: "linux" })).rejects.toThrow(
			StagingPathError,
		)
		expect(fsSync.openSync).not.toHaveBeenCalled()
		expect(fs.rename).not.toHaveBeenCalled()
		// The comparison is only sound when both stats are read as bigint: on NTFS/ReFS the file
		// identifiers exceed Number.MAX_SAFE_INTEGER.
		// Filter on the options, not the spelling: path.resolve prefixes a drive letter on Windows,
		// so the two identity reads are the calls that asked for options at all.
		const identityLookups = vi.mocked(fs.lstat).mock.calls.filter((c) => c[1] !== undefined)
		expect(identityLookups.length).toBeGreaterThanOrEqual(2)
		for (const c of identityLookups) {
			expect(c[1]).toEqual({ bigint: true })
		}
		expect(fs.unlink).not.toHaveBeenCalled()
	})

	it("rejects when the target identity cannot be compared for a reason other than a missing target", async () => {
		const targetPath = "/tmp/test-dir/target.txt"
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
		// A hard-linked staging file shares the target's inode, so the identity comparison is the only thing
		// between this write and a rename onto the very file the guard protects. An EACCES from the target
		// lstat must not be mistaken for "there is no target".
		const stagingStats = _fileIdentity(42n, 7n)
		vi.mocked(fs.lstat).mockImplementation(async (p) => {
			if (String(p) === targetPath) {
				throw Object.assign(new Error("EACCES"), { code: "EACCES" })
			}
			return stagingStats
		})

		await expect(
			safeWriteText(targetPath, "data", { tempPath: "/tmp/test-dir/hardlink.txt", platform: "linux" }),
		).rejects.toThrow("Staging file could not be compared with the target")
		expect(fsSync.openSync).not.toHaveBeenCalled()
		expect(fs.rename).not.toHaveBeenCalled()
		// Both identity reads must ask for bigint stats, or the comparison silently falls
		// back to rounded numbers on NTFS/ReFS.
		const identityLookups = vi.mocked(fs.lstat).mock.calls.filter((c) => c[1] !== undefined)
		expect(identityLookups).toHaveLength(2)
		for (const c of identityLookups) {
			expect(c[1]).toEqual({ bigint: true })
		}
	})
})

describe("cleanup before a rollback failure is reported", () => {
	beforeEach(() => mockDefaults())

	it("releases the staged file, its copy and its own staging directory before throwing", async () => {
		const targetPath = "/tmp/test-dir/target.txt"
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
		vi.mocked(fsSync.openSync).mockReturnValue(1)
		// The commit rename is the only rename in this flow and it fails.
		vi.mocked(fs.rename).mockRejectedValue(new Error("ENOSPC"))

		await expect(safeWriteText(targetPath, "data", { backup: true, platform: "linux" })).rejects.toThrow("ENOSPC")

		// The staging file and this write's own directory must not leak, and neither may
		// the backup copy: the target still holds the pre-write content on disk.
		expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"))
		expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.bak_"))
		const stagingDirs = vi.mocked(fsSync.mkdirSync).mock.calls.map((call) => String(call[0]))
		expect(stagingDirs.length).toBe(1)
		expect(fs.rmdir).toHaveBeenCalledWith(stagingDirs[0])

		const failingRenameOrder = vi.mocked(fs.rename).mock.invocationCallOrder[0]
		const unlinkOrder = vi.mocked(fs.unlink).mock.invocationCallOrder[0]
		const rmdirOrder = vi.mocked(fs.rmdir).mock.invocationCallOrder[0]
		expect(unlinkOrder).toBeGreaterThan(failingRenameOrder)
		expect(rmdirOrder).toBeGreaterThan(failingRenameOrder)
	})
})

describe("resolvePublishTarget", () => {
	beforeEach(() => mockDefaults())

	it("propagates an lstat failure that is not ENOENT instead of falling back to the link path", async () => {
		const targetPath = "/tmp/test-dir/target.txt"
		const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
		const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
		vi.mocked(fs.realpath).mockRejectedValue(enoent)
		vi.mocked(fs.lstat).mockRejectedValue(eacces)

		// A failed lstat says nothing about whether the path is a link, so the
		// fallback would publish through a link we were not allowed to inspect.
		await expect(safeWriteText(targetPath, "data", { platform: "linux" })).rejects.toBe(eacces)
		expect(fs.rename).not.toHaveBeenCalled()
	})

	it("still falls back to the given path when lstat also reports the path as absent", async () => {
		const targetPath = "/tmp/test-dir/target.txt"
		const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
		vi.mocked(fs.realpath).mockRejectedValue(enoent)
		vi.mocked(fs.lstat).mockRejectedValue(enoent)
		vi.mocked(fsSync.openSync).mockReturnValue(1)

		await safeWriteText(targetPath, "data", { platform: "linux" })

		// The fallback is the resolved path, not the string that was handed in.
		expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), path.resolve(targetPath))
	})
})

describe("resolveLockKey when the parent directory does not exist yet", () => {
	beforeEach(() => mockDefaults())

	it("canonicalizes through the nearest existing ancestor instead of the literal parent", async () => {
		// Two writers must take ONE lock: the one whose parent directory is already there,
		// and the one racing to create it. Resolving only the immediate parent and falling
		// back to its literal spelling on ENOENT gave them different keys whenever an
		// ancestor was a symlink or a Windows short name, so a read-modify-write under the
		// advisory lock lost one side.
		const aliasDir = path.resolve("/tmp/alias-parent")
		const canonicalDir = path.resolve("/tmp/real-parent")
		const nested = path.join(aliasDir, "nested")
		const target = path.join(nested, "history_item.json")
		vi.mocked(fs.lstat).mockResolvedValue(_fileStats(false))
		vi.mocked(fs.realpath).mockImplementation(async (p) => {
			const s = String(p)
			if (s === target || s === nested) {
				throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
			}
			if (s === aliasDir) {
				return canonicalDir
			}
			return s
		})

		expect(await resolveLockKey(target)).toBe(path.join(canonicalDir, "nested", "history_item.json"))
	})

	it("propagates a realpath failure that is not ENOENT instead of guessing a key", async () => {
		// A realpath that fails for another reason says nothing about the canonical form;
		// returning a literal key would silently put this writer on a different lock.
		const target = path.join(path.resolve("/tmp/test-dir"), "history_item.json")
		vi.mocked(fs.lstat).mockResolvedValue(_fileStats(false))
		// Not a link: the walk must reach the canonicalization step, which is where the
		// non-ENOENT failure has to surface.
		vi.mocked(fs.readlink).mockRejectedValue(
			Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
		)
		vi.mocked(fs.realpath).mockImplementation(async (p) => {
			if (String(p) === target) return target
			throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
		})

		await expect(resolveLockKey(target)).rejects.toThrow("EACCES")
	})
})

// -- asks landed at the refreshed 2357 footing --------------------------------
//
// Rows for the review asks on this file's own footing. Each row needs the line it describes:
// the round's negative control makes that line inert and these are the rows that fail.

describe("asks landed at the refreshed 2357 footing", () => {
	beforeEach(() => {
		mockDefaults()
		vi.mocked(fsSync.writeSync).mockImplementation((...args: unknown[]) =>
			typeof args[3] === "number" ? args[3] : 0,
		)
	})
	describe("created directories validated against the authorized location", () => {
		// The created chain is sampled AFTER the mkdir, so it records where the created directory ended
		// up, not where the caller authorized it to be. A directory that was not there when the caller
		// authorized can be a link by the time mkdir reaches it, and the created parent then sits
		// outside the chain the caller walked.
		function _scenario(linkPlantedDuringMkdir: boolean) {
			const pinned = path.resolve("/ws/a")
			const created = path.join(pinned, "new")
			const escaped = path.resolve("/outside/new")
			const target = path.join(created, "target.txt")
			let linkPlanted = false
			const enoent = () => Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
			vi.mocked(fs.realpath).mockImplementation(async (p) => {
				const s = String(p)
				if (s === target || (s === created && !linkPlanted)) throw enoent()
				// The link is planted between the canonicalization and the mkdir answer, so the same name
				// resolves elsewhere by the time the created chain is used.
				return s === created ? escaped : s
			})
			// Node reports the outermost directory mkdir created, in the caller's spelling.
			vi.mocked(fs.mkdir).mockImplementation(async () => {
				linkPlanted = linkPlantedDuringMkdir
				return created
			})
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			return { pinned, created, target }
		}
		const pin = (dir: string) => [{ dir, dev: 1n, ino: 100n, resolvedPath: dir }]
		it("refuses to publish when the directory mkdir created resolves outside the location the caller authorized", async () => {
			const { pinned, target } = _scenario(true)
			const promise = safeWriteText(target, "data", {
				platform: "linux",
				expectedAncestorIdentities: pin(pinned),
			})
			await expect(promise).rejects.toBeInstanceOf(AncestorReplacedError)
			// The pin covers the name mkdir reported, so the refusal now lands on the containment
			// check that compares the resolved directory against the selected location.
			await expect(promise).rejects.toThrow(/outside the authorized location/)
			expect(fs.rename).not.toHaveBeenCalled()
			expect(fs.link).not.toHaveBeenCalled()
		})
		it("publishes when the created directory resolves inside the location the caller authorized", async () => {
			const { pinned, target } = _scenario(false)
			const promise = safeWriteText(target, "data", {
				platform: "linux",
				expectedAncestorIdentities: pin(pinned),
			})
			await expect(promise).resolves.toBeUndefined()
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), target)
		})
		it("leaves the created chain alone when the caller pinned no location", async () => {
			const { target } = _scenario(true)
			const promise = safeWriteText(target, "data", { platform: "linux" })
			await expect(promise).resolves.toBeUndefined()
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), target)
		})
		it("publishes when a created directory merely has a name that begins with two dots under the pinned location", async () => {
			// A directory named ..cache is an ordinary child of the location the caller pinned. The
			// containment predicate read every name beginning with two dots as a walk out of the pin,
			// so this write was refused with AncestorReplacedError before anything was staged, even
			// though the pin the caller handed in covers it by its own name.
			const pinned = path.resolve("/ws")
			const created = path.join(pinned, "..cache")
			const target = path.join(created, "new", "target.txt")
			const enoent = () => Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
			vi.mocked(fs.realpath).mockImplementation(async (p) => {
				const s = String(p)
				if (s === target) throw enoent()
				// Nothing on this chain moved: the name carrying two leading dots is the only thing
				// that separates this scenario from the one above.
				return s
			})
			// The outermost directory mkdir created, in the spelling Node answers with.
			vi.mocked(fs.mkdir).mockImplementation(async () => created)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			const promise = safeWriteText(target, "data", {
				platform: "linux",
				expectedAncestorIdentities: pin(pinned),
			})
			await expect(promise).resolves.toBeUndefined()
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), target)
		})
		it("refuses to publish when a created directory resolves under a shallower pin than the name it was created under", async () => {
			// Two ancestor pins, /ws and /ws/a. mkdir reports creating /ws/a/new, and the link is
			// planted only when mkdir answers, so the name the chain carries is still the one the
			// caller walked while the directory it resolves to now sits under the shallower pin.
			// A pin selected by the resolved path finds /ws, whose containment check the redirected
			// directory passes, so the write publishes through grounds the caller never authorized
			// for that name.
			const shallow = path.resolve("/ws")
			const deep = path.resolve("/ws/a")
			const created = path.join(deep, "new")
			const redirected = path.join(shallow, "other", "new")
			const target = path.join(created, "target.txt")
			let linkPlanted = false
			const enoent = () => Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
			vi.mocked(fs.realpath).mockImplementation(async (p) => {
				const s = String(p)
				if (s === target || (s === created && !linkPlanted)) throw enoent()
				return s === created ? redirected : s
			})
			vi.mocked(fs.mkdir).mockImplementation(async () => {
				linkPlanted = true
				return created
			})
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			const promise = safeWriteText(target, "data", {
				platform: "linux",
				expectedAncestorIdentities: [
					{ dir: shallow, dev: 1n, ino: 100n, resolvedPath: shallow },
					{ dir: deep, dev: 1n, ino: 100n, resolvedPath: deep },
				],
			})
			await expect(promise).rejects.toBeInstanceOf(AncestorReplacedError)
			await expect(promise).rejects.toThrow(/outside the authorized location/)
			expect(fs.rename).not.toHaveBeenCalled()
			expect(fs.link).not.toHaveBeenCalled()
		})
		it("publishes when the created chain sits under the location a pinned alias resolved to", async () => {
			// The control on selecting by name. A caller that authorized a chain THROUGH an alias
			// records the alias spelling as dir and the location that alias resolves to as
			// resolvedPath, and mkdir answers on the location side. Selecting by dir alone would find
			// no pin for this chain and refuse a write whose ancestry never moved.
			const aliasDir = path.resolve("/ws/alias")
			const authorizedLocation = path.resolve("/ws/real")
			const created = path.join(authorizedLocation, "new")
			const target = path.join(created, "target.txt")
			const enoent = () => Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
			vi.mocked(fs.realpath).mockImplementation(async (p) => {
				const s = String(p)
				if (s === target) throw enoent()
				return path.resolve(s) === aliasDir ? authorizedLocation : s
			})
			vi.mocked(fs.mkdir).mockImplementation(async () => created)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			const promise = safeWriteText(target, "data", {
				platform: "linux",
				expectedAncestorIdentities: [{ dir: aliasDir, dev: 1n, ino: 100n, resolvedPath: authorizedLocation }],
			})
			await expect(promise).resolves.toBeUndefined()
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), target)
		})
		it("refuses to publish when a deeper pin covers the created name better than a longer alias spelling does", async () => {
			// Two pins cover the name mkdir reported creating. The identity pin reached it
			// through an alias, so its dir is the alias spelling /ws/long-root-alias - longer
			// than anything on the deeper side - while only the location that alias resolved to,
			// /ws, covers the created name at all. The path-form pin names the created directory
			// itself. Ranking candidates by the length of their dir field put the longer alias
			// first, so the containment check ran against /ws and a created /ws/a/new that had
			// become a link into /ws/other passed it, publishing through ground the caller never
			// authorized under that name.
			const shallow = path.resolve("/ws")
			const aliasDir = path.resolve("/ws/long-root-alias")
			const created = path.resolve("/ws/a/new")
			const redirected = path.join(shallow, "other", "new")
			const target = path.join(created, "target.txt")
			let linkPlanted = false
			const enoent = () => Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
			vi.mocked(fs.realpath).mockImplementation(async (p) => {
				const s = String(p)
				if (s === target || (s === created && !linkPlanted)) throw enoent()
				// The alias spelling stands for the location it was recorded resolving to, and the
				// created name became a link into shallower grounds between the canonicalization
				// and the mkdir answer.
				if (path.resolve(s) === aliasDir) return shallow
				return s === created ? redirected : s
			})
			vi.mocked(fs.mkdir).mockImplementation(async () => {
				linkPlanted = true
				return created
			})
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			const promise = safeWriteText(target, "data", {
				platform: "linux",
				expectedAncestorIdentities: [{ dir: aliasDir, dev: 1n, ino: 100n, resolvedPath: shallow }],
				expectedResolvedPath: target,
			})
			await expect(promise).rejects.toBeInstanceOf(AncestorReplacedError)
			await expect(promise).rejects.toThrow(/outside the authorized location/)
			expect(fs.rename).not.toHaveBeenCalled()
			expect(fs.link).not.toHaveBeenCalled()
		})
	})
	describe("target group carried onto the staging descriptor before publication", () => {
		// The commit publishes the staging inode, so the group the published file ends up in is whatever
		// the staging descriptor carried when it closed. The mode was re-applied with fchmodSync; the
		// group was not carried at all.
		const GID = 4321
		function _targetWithGroup(target: string, fd: number): void {
			vi.mocked(fs.realpath).mockResolvedValue(target)
			vi.mocked(fsSync.openSync).mockReturnValue(fd)
			// A Stats stand-in that reports a group, the way a POSIX target does.
			vi.mocked(fsSync.statSync).mockReturnValue(Object.assign(_stats(0o600), { gid: GID }))
		}
		it("carries the existing target's group onto the staging descriptor before the commit", async () => {
			const target = path.resolve("/ws/b/target.txt")
			_targetWithGroup(target, 1)
			await safeWriteText(target, "data", { platform: "linux" })
			expect(fsSync.fchmodSync).toHaveBeenCalledWith(1, 0o600)
			expect(fsSync.fchownSync).toHaveBeenCalledWith(1, -1, GID)
			// Before the close and the rename: after the commit the name belongs to the published file and
			// the window to carry anything onto that descriptor is gone.
			expect(vi.mocked(fsSync.fchownSync).mock.invocationCallOrder[0]).toBeLessThan(
				vi.mocked(fsSync.closeSync).mock.invocationCallOrder[0],
			)
		})
		it("carries the group onto a caller-supplied staging descriptor as well", async () => {
			const target = path.resolve("/ws/c/target.txt")
			const staged = path.join(path.dirname(target), "x.tmp")
			_targetWithGroup(target, 7)
			await safeWriteText(target, "data", { tempPath: staged, platform: "linux" })
			expect(fsSync.openSync).toHaveBeenCalledWith(staged, "r+")
			expect(fsSync.fchmodSync).toHaveBeenCalledWith(7, 0o600)
			expect(fsSync.fchownSync).toHaveBeenCalledWith(7, -1, GID)
		})
		it("asks for no group when the target is not there yet", async () => {
			const target = path.resolve("/ws/b/fresh.txt")
			vi.mocked(fs.realpath).mockResolvedValue(target)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(fsSync.statSync).mockImplementation(() => {
				throw Object.assign(new Error("ENOENT: no such file or directory, stat"), { code: "ENOENT" })
			})
			await safeWriteText(target, "data", { platform: "linux" })
			expect(fsSync.fchownSync).not.toHaveBeenCalled()
			expect(fs.rename).toHaveBeenCalledTimes(1)
		})
	})
	describe("cancellation honoured at the commit gate", () => {
		// Publish was one awaited submission with nothing a caller could cancel. Every step before the
		// commit is awaited, so the commit gate is the last point where publishing can still be refused.
		it("publishes nothing when the caller cancels before the commit", async () => {
			const target = path.resolve("/ws/d/target.txt")
			vi.mocked(fs.realpath).mockResolvedValue(target)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			const controller = new AbortController()
			controller.abort()
			const promise = safeWriteText(target, "data", { platform: "linux", signal: controller.signal })
			await expect(promise).rejects.toBeInstanceOf(PublishCancelledError)
			expect(fs.rename).not.toHaveBeenCalled()
			expect(fs.link).not.toHaveBeenCalled()
			// The staged file this write made is removed by the failure cleanup.
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"))
		})
		it("publishes nothing when the caller cancels while the backup copy is in flight", async () => {
			const target = path.resolve("/ws/e/target.txt")
			vi.mocked(fs.realpath).mockResolvedValue(target)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			const controller = new AbortController()
			vi.mocked(fs.copyFile).mockImplementation(async () => {
				controller.abort()
			})
			const promise = safeWriteText(target, "data", {
				platform: "linux",
				backup: true,
				signal: controller.signal,
			})
			await expect(promise).rejects.toBeInstanceOf(PublishCancelledError)
			expect(fs.rename).not.toHaveBeenCalled()
			// Both files this write made go: the staged file and the copy of the previous content.
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.bak"))
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"))
		})
		it("commits when the caller hands a signal that never fires", async () => {
			const target = path.resolve("/ws/f/target.txt")
			vi.mocked(fs.realpath).mockResolvedValue(target)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			const controller = new AbortController()
			const promise = safeWriteText(target, "data", { platform: "linux", signal: controller.signal })
			await expect(promise).resolves.toBeUndefined()
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), target)
		})
	})
})

describe("created root in the extended-length namespace", () => {
	// Node reports the directory mkdir created through the Windows extended-length namespace, and
	// only Windows spells a UNC root that way: the marker plus the "UNC" label stands for the
	// leading backslash pair. These rows run where that marker can appear and are skipped where it
	// cannot, so the spelling the fix answers is tested rather than assumed.
	const markerVisibleHere = process.platform === "win32"
	const conditionalIt = markerVisibleHere ? it : it.skip
	const serverRoot = "\\\\server\\share\\ws"
	const created = "\\\\server\\share\\ws\\new"
	const target = "\\\\server\\share\\ws\\new\\target.txt"
	const escaped = "\\\\outside\\share\\new"
	// The answer mkdir gives for a UNC target on Node 22, in the namespace spelling.
	const mkdirAnswer = "\\\\?\\UNC\\server\\share\\ws\\new"
	function _uncScenario(redirectCreatedDirectory: boolean) {
		vi.mocked(fs.realpath).mockImplementation(async (p) => {
			const s = String(p)
			// The planted redirect makes the created directory resolve under a host nothing pinned.
			if (redirectCreatedDirectory && s === created) return escaped
			return s
		})
		vi.mocked(fs.mkdir).mockResolvedValue(mkdirAnswer)
		vi.mocked(fsSync.openSync).mockReturnValue(1)
		return [{ dir: serverRoot, dev: 1n, ino: 100n, resolvedPath: serverRoot }]
	}
	beforeEach(() => {
		mockDefaults()
		vi.mocked(fsSync.writeSync).mockImplementation((...args: unknown[]) =>
			typeof args[3] === "number" ? args[3] : 0,
		)
	})
	conditionalIt(
		"refuses to publish when the created UNC directory resolves under nothing the caller pinned",
		async () => {
			const pin = _uncScenario(true)
			const promise = safeWriteText(target, "data", {
				platform: "linux",
				expectedAncestorIdentities: pin,
			})
			await expect(promise).rejects.toBeInstanceOf(AncestorReplacedError)
			// Selection is by the name the created chain carries, and the pin covers that name, so the
			// refusal lands on the containment check rather than on the absence of any pin.
			await expect(promise).rejects.toThrow(/outside the authorized location/)
			expect(fs.rename).not.toHaveBeenCalled()
			expect(fs.link).not.toHaveBeenCalled()
		},
	)
	conditionalIt(
		"publishes when the created UNC directory resolves inside the location the caller pinned",
		async () => {
			const pin = _uncScenario(false)
			await expect(
				safeWriteText(target, "data", { platform: "linux", expectedAncestorIdentities: pin }),
			).resolves.toBeUndefined()
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), target)
		},
	)
})

describe("effective parent validated when mkdir created nothing", () => {
	// mkdir names no first created directory when the final directory was already there, and a
	// name that is a link to a directory answers the same way because the stat after the create
	// succeeds. Nothing was created, so no created chain exists for the authorization loop, yet
	// the parent this write publishes into can have become a link after the caller authorized it.
	const pinned = path.resolve("/ws/a")
	const parent = path.join(pinned, "new")
	const escapedParent = path.resolve("/outside/new")
	const target = path.join(parent, "target.txt")
	function _scenario(parentResolvesElsewhere: boolean, pinGiven: boolean) {
		vi.mocked(fs.realpath).mockImplementation(async (p) => {
			const s = String(p)
			if (parentResolvesElsewhere && s === parent) return escapedParent
			return s
		})
		// Node 22 reports undefined for a recursive mkdir whose final directory already exists.
		vi.mocked(fs.mkdir).mockResolvedValue(undefined)
		vi.mocked(fsSync.openSync).mockReturnValue(1)
		return pinGiven ? [{ dir: pinned, dev: 1n, ino: 100n, resolvedPath: pinned }] : undefined
	}
	beforeEach(() => {
		mockDefaults()
		vi.mocked(fsSync.writeSync).mockImplementation((...args: unknown[]) =>
			typeof args[3] === "number" ? args[3] : 0,
		)
	})
	it("refuses to publish when the parent that already existed resolves under nothing the caller pinned", async () => {
		const pin = _scenario(true, true)
		const promise = safeWriteText(target, "data", {
			platform: "linux",
			expectedAncestorIdentities: pin,
		})
		await expect(promise).rejects.toBeInstanceOf(AncestorReplacedError)
		await expect(promise).rejects.toThrow(/nothing the caller authorized/)
		expect(fs.rename).not.toHaveBeenCalled()
		expect(fs.link).not.toHaveBeenCalled()
	})
	it("publishes when the parent that already existed resolves inside the location the caller pinned", async () => {
		const pin = _scenario(false, true)
		await expect(
			safeWriteText(target, "data", { platform: "linux", expectedAncestorIdentities: pin }),
		).resolves.toBeUndefined()
		expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), target)
	})
	it("publishes when the parent already existed and the caller pinned no location", async () => {
		const pin = _scenario(true, false)
		await expect(
			safeWriteText(target, "data", { platform: "linux", expectedAncestorIdentities: pin }),
		).resolves.toBeUndefined()
		expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), target)
	})
	it("refuses to publish when only the path form of the name pin is given and its parent resolves outside", async () => {
		_scenario(true, false)
		const promise = safeWriteText(target, "data", {
			platform: "linux",
			expectedResolvedPath: target,
		})
		await expect(promise).rejects.toBeInstanceOf(AncestorReplacedError)
		await expect(promise).rejects.toThrow(/nothing the caller authorized/)
		expect(fs.rename).not.toHaveBeenCalled()
		expect(fs.link).not.toHaveBeenCalled()
	})
	it("publishes when only the path form of the name pin is given and its parent resolves in place", async () => {
		// The accept path of the guard this block established. The narrowing that sends every
		// path-only pin through the effective-parent check left the reject case tested and the
		// accept case untested, so a regression that refused every path-only pin - publishing
		// nothing for a parent that resolved exactly where the caller pinned it - would have
		// passed this suite.
		_scenario(false, false)
		await expect(
			safeWriteText(target, "data", { platform: "linux", expectedResolvedPath: target }),
		).resolves.toBeUndefined()
		expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), target)
	})
})
