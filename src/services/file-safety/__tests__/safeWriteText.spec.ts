import * as fs from "fs/promises"
import * as fsSync from "fs"
import { execFile } from "child_process"
import type { ChildProcess } from "child_process"
import * as os from "os"
import * as path from "path"

import {
	DaclCaptureError,
	DaclRestoreError,
	PostCommitDurabilityError,
	resolveLockKey,
	safeWriteText,
	StagingPathError,
	type SafeWriteTextOptions,
} from "../safeWriteText"

// Full mock for fs/promises — all methods are vi.fn() stubs
vi.mock("fs/promises", () => ({
	copyFile: vi.fn(),
	chmod: vi.fn(),
	mkdir: vi.fn(),
	access: vi.fn(),
	rename: vi.fn(),
	unlink: vi.fn(),
	rmdir: vi.fn(),
	realpath: vi.fn(),
	lstat: vi.fn(),
	readlink: vi.fn(),
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
// Minimal Stats stand-in: the SUT only reads `.mode` from it.
// Async lstat stand-in: the SUT only asks whether the path is a link or a file.
// Built on the Stats prototype so the mock value still satisfies fsSync.Stats.
function _fileStats(isLink: boolean): fsSync.Stats {
	const s = Object.create(fsSync.Stats.prototype) as fsSync.Stats
	s.isSymbolicLink = () => isLink
	s.isFile = () => !isLink
	return s
}

// fs.BigIntStats is a type-only export (fs.BigIntStats is undefined at runtime), so the stand-in is
// a Stats object carrying bigint ino/dev - exactly what fs.lstat(path, { bigint: true }) hands
// back at runtime.
function _fileStatsWithIdentity(ino: bigint, dev: bigint): fsSync.BigIntStats {
	// Double assertion: the runtime value is the Stats stand-in, the type is the bigint variant.
	const s = _fileStats(false) as unknown as fsSync.BigIntStats
	s.ino = ino
	s.dev = dev
	return s
}

function mockDefaults(): void {
	vi.resetAllMocks()
	// After resetAllMocks, vi.fn() returns undefined — restore promise defaults.
	vi.mocked(fs.mkdir).mockResolvedValue(undefined)
	vi.mocked(fs.access).mockResolvedValue(undefined)
	vi.mocked(fs.rename).mockResolvedValue(undefined)
	vi.mocked(fs.unlink).mockResolvedValue(undefined)
	vi.mocked(fs.rmdir).mockResolvedValue(undefined)
	// Existing-target default: a regular 0o644 file.
	vi.mocked(fsSync.statSync).mockReturnValue(_stats(0o644))
	// Staged-file default: a regular file, not a link, so a caller-supplied
	// tempPath passes the location and file-type check by default.
	vi.mocked(fs.lstat).mockResolvedValue(_fileStats(false))
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

	it("win32: a rejecting async onWarning does not abort the write or leak an unhandled rejection", async () => {
		// TypeScript accepts an async sink where a void callback is expected, so the
		// wrapper has to attach a handler to the returned promise: an unhandled
		// rejection can end the process under Node's default mode, after a write that
		// already succeeded.
		const targetPath = "/tmp/test-dir/target.txt"
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
		vi.mocked(fsSync.openSync).mockReturnValue(1)
		// Only the restore fails, so a warning is delivered and the restrictive fallback
		// (drop inheritance, grant the current user, read the DACL back) verifies.
		vi.mocked(execFile).mockImplementation((_cmd, args, _opts, cb) => {
			const argv = args as unknown as string[]
			const callback = cb as unknown as (err: unknown, stdout: string, stderr: string) => void
			if (argv[1] === "/restore") {
				callback(new Error("icacls restore error"), "", "")
			} else if (argv[1] === undefined) {
				callback(null, `${argv[0]} ${os.userInfo().username}:(F)`, "")
			} else {
				callback(null, "", "")
			}
			return fakeChild
		})
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})

		await expect(
			safeWriteText(targetPath, "data", {
				platform: "win32",
				onWarning: async () => {
					throw new Error("async sink down")
				},
			}),
		).resolves.toBeUndefined()

		expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"), targetPath)
		// The rejection is reported through the fallback sink rather than surfacing as an
		// unhandled rejection.
		expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining("onWarning callback rejected"))
		consoleWarn.mockRestore()
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
	})

	// ── Test 4: backup:true keeps old safeWriteJson semantics, copy-based ──

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

		it("a backup copy that fails part-way is removed, not left as a usable-looking backup", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			// Distinct fds so the seed descriptor can be told apart from the backup's fsync
			// handle and the staging temp: the seed is the first open of the backup path.
			let backupOpens = 0
			vi.mocked(fsSync.openSync).mockImplementation((target: unknown) => {
				return String(target).includes("safeWriteText.bak_") ? (backupOpens++ === 0 ? 7 : 8) : 1
			})
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

			// The seed descriptor was released successfully before the copy failed, so the failure
			// handler must not close it a second time: another open may already own that number, and
			// closing it here would pull a live handle out from under its new owner.
			expect(vi.mocked(fsSync.closeSync).mock.calls.filter((call) => Number(call[0]) === 7)).toHaveLength(1)
		})

		it("a failing seed-descriptor close is reported once and does not fail the backup", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			// The backup destination is seeded with openSync("wx") and released immediately. Give
			// every open its own fd so the closes can be matched to the opens, and make the
			// seed's close fail: at that moment the descriptor is still owned by this call, while
			// the error this write ends up reporting is the backup failure.
			let backupOpens = 0
			let otherFd = 100
			const openedFds: number[] = []
			vi.mocked(fsSync.openSync).mockImplementation((target: unknown) => {
				// Distinct numbers per open, so "no descriptor is closed twice" can be checked
				// against the numbers themselves.
				const fd = String(target).includes("safeWriteText.bak_") ? (backupOpens++ === 0 ? 7 : 8) : otherFd++
				openedFds.push(fd)
				return fd
			})
			const seedFd = 7
			const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
			vi.mocked(fsSync.closeSync).mockImplementation((fd: unknown) => {
				if (Number(fd) === seedFd) {
					throw Object.assign(new Error("EBADF"), { code: "EBADF" })
				}
			})

			// A close that has been attempted is never attempted again: the first close(2) may have
			// released the descriptor even while reporting EBADF, and a second close could then
			// release a descriptor a concurrent open has meanwhile been handed. The failure is
			// reported where it happened, and the backup - which is what this descriptor was for -
			// is complete, so the write itself is not failed by it.
			await expect(
				safeWriteText(targetPath, "new data", { backup: true, platform: "linux" }),
			).resolves.toBeUndefined()

			const seedAttempts = vi
				.mocked(fsSync.closeSync)
				.mock.calls.filter((call) => Number(call[0]) === seedFd).length
			expect(seedAttempts).toBe(1)
			expect(consoleError).toHaveBeenCalledWith(
				expect.stringContaining("backup seed descriptor for"),
				expect.anything(),
			)
			expect(consoleError).toHaveBeenCalledWith(
				expect.stringContaining("backup seed descriptor"),
				expect.anything(),
			)
			// Every descriptor this write opened was handed to closeSync: no handle outlives the
			// failed backup.
			for (const fd of openedFds) {
				expect(vi.mocked(fsSync.closeSync).mock.calls.some((call) => Number(call[0]) === fd)).toBe(true)
			}
			// The backup itself is complete - the seed descriptor was only ever a mode-fixed
			// placeholder - so the write goes on to commit and then discards the backup it no longer
			// needs.
			const closedFds = vi.mocked(fsSync.closeSync).mock.calls.map((call) => Number(call[0]))
			expect(new Set(closedFds).size).toBe(closedFds.length)
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), targetPath)
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.bak_"))
			consoleError.mockRestore()
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

		it("win32: an existing target whose DACL could not be captured is not committed over", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// icacls dump fails — the callback-based mock must invoke cb with an error.
			vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
				if (typeof cb === "function") cb(new Error("icacls error"), "", "")
				return fakeChild
			})

			// Contract change, stated explicitly: this test pinned the warn-and-publish behavior
			// the review row calls a security defect. Publishing over a target whose access rights
			// are unknown hands the file whatever the destination directory grants, decided by a
			// helper that failed. The write is now refused before the commit rename.
			await expect(safeWriteText(targetPath, "data", { platform: "win32" })).rejects.toThrow(DaclCaptureError)

			// Nothing was committed, and no restore was attempted from a dump that never saved.
			expect(fs.rename).not.toHaveBeenCalled()
			expect(execFile).toHaveBeenCalledTimes(1)
		})

		it("win32: refuses the write without an onWarning notice when the DACL cannot be saved", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
				if (typeof cb === "function") cb(new Error("icacls error"), "", "")
				return fakeChild
			})
			const warnings: string[] = []

			// The refusal carries what the warning used to say: the caller learns why the save did
			// not happen, and the target keeps the ACL it already had.
			await expect(
				safeWriteText(targetPath, "data", { platform: "win32", onWarning: (m) => warnings.push(m) }),
			).rejects.toThrow(DaclCaptureError)
			expect(fs.rename).not.toHaveBeenCalled()
			expect(warnings).toHaveLength(0)
		})

		it("win32: reports when the target cannot be checked for DACL preservation", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// The target exists but is not readable: that is not "absent", and skipping DACL
			// preservation has to be visible.
			vi.mocked(fs.access).mockImplementation(async (p) => {
				if (String(p) === targetPath) {
					throw Object.assign(new Error("EACCES"), { code: "EACCES" })
				}
			})
			const warnings: string[] = []

			await safeWriteText(targetPath, "data", { platform: "win32", onWarning: (m) => warnings.push(m) })

			expect(execFile).not.toHaveBeenCalled()
			expect(warnings.filter((m) => m.includes("Could not check"))).toHaveLength(1)
		})

		// Warning delivery is advisory: it must not be able to fail the save it is reporting on.
		it("win32: a throwing onWarning does not abort the write", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// Only the restore fails, so a warning is delivered and the restrictive fallback
			// (drop inheritance, grant the current user, read the DACL back) verifies.
			vi.mocked(execFile).mockImplementation((_cmd, args, _opts, cb) => {
				const argv = args as unknown as string[]
				const callback = cb as unknown as (err: unknown, stdout: string, stderr: string) => void
				if (argv[1] === "/restore") {
					callback(new Error("icacls restore error"), "", "")
				} else if (argv[1] === undefined) {
					callback(null, `${argv[0]} ${os.userInfo().username}:(F)`, "")
				} else {
					callback(null, "", "")
				}
				return fakeChild
			})

			await expect(
				safeWriteText(targetPath, "data", {
					platform: "win32",
					onWarning: () => {
						throw new Error("callback down")
					},
				}),
			).resolves.toBeUndefined()

			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"), targetPath)
		})

		it("win32 DACL: a partial dump left by a failed save is removed and never restored", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// icacls save fails — a real icacls may have written a partial dump
			// before erroring, so the dump path must be cleaned up and must never
			// be used for a restore.
			vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
				if (typeof cb === "function") cb(new Error("icacls save error"), "", "")
				return fakeChild
			})

			// Contract change (see the capture test above): the write is refused, not committed.
			await expect(safeWriteText(targetPath, "data", { platform: "win32" })).rejects.toThrow(DaclCaptureError)

			// Nothing was committed and no restore was attempted from a failed dump.
			expect(fs.rename).not.toHaveBeenCalled()
			expect(execFile).toHaveBeenCalledTimes(1)
			const saveArgs = vi.mocked(execFile).mock.calls[0]?.[1]
			expect(saveArgs?.[1]).toBe("/save")
			// the dump path (possibly partially created by icacls) was unlinked, and so was the
			// staging file this write had already created - a refused publish leaves nothing behind.
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.acl"))
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"))
		})

		// The row's second half: "If DACL restoration fails after commit, restore a restrictive
		// verified ACL before returning, or otherwise fail safely without exposing the committed
		// content." These three cases are the two branches and the verification step.
		it("win32 DACL: a failed restore narrows the committed file and reports the narrowing", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			const warnings: string[] = []
			vi.mocked(execFile).mockImplementation((_cmd, args, _opts, cb) => {
				const argv = args as unknown as string[]
				const callback = cb as unknown as (err: unknown, stdout: string, stderr: string) => void
				if (argv[1] === "/restore") {
					callback(new Error("icacls restore error"), "", "")
				} else if (argv[1] === undefined) {
					callback(null, `${argv[0]} ${os.userInfo().username}:(F)`, "")
				} else {
					callback(null, "", "")
				}
				return fakeChild
			})

			await expect(
				safeWriteText(targetPath, "data", { platform: "win32", onWarning: (m) => warnings.push(m) }),
			).resolves.toBeUndefined()

			// The narrowing was actually applied to the committed file, not just reported.
			const grant = vi
				.mocked(execFile)
				.mock.calls.find(([, a]) => (a as unknown as string[])[1] === "/inheritance:r")
			expect(grant).toBeDefined()
			expect((grant?.[1] as unknown as string[]) ?? []).toEqual([
				targetPath,
				"/inheritance:r",
				"/grant:r",
				`${os.userInfo().username}:F`,
			])
			expect(
				warnings.filter((m) => m.includes("narrowed to the current user's full control and verified")),
			).toHaveLength(1)
		})

		it("win32 DACL: a restore failure the narrowing cannot recover from rolls the commit back", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(execFile).mockImplementation((_cmd, args, _opts, cb) => {
				const argv = args as unknown as string[]
				const callback = cb as unknown as (err: unknown, stdout: string, stderr: string) => void
				if (argv[1] === "/restore" || argv[1] === "/inheritance:r") {
					callback(new Error("icacls failed"), "", "")
				} else {
					callback(null, "", "")
				}
				return fakeChild
			})

			await expect(safeWriteText(targetPath, "data", { backup: true, platform: "win32" })).rejects.toThrow(
				DaclRestoreError,
			)

			// The committed bytes do not stay at the target under an unknown ACL: the retained
			// backup is renamed back, so the second rename is the rollback.
			expect(fs.rename).toHaveBeenCalledTimes(2)
			expect(fs.rename).toHaveBeenLastCalledWith(expect.stringContaining("safeWriteText.bak"), targetPath)
		})

		it("win32 DACL: a narrowing that still shows an inherited ACE is not accepted as verified", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(execFile).mockImplementation((_cmd, args, _opts, cb) => {
				const argv = args as unknown as string[]
				const callback = cb as unknown as (err: unknown, stdout: string, stderr: string) => void
				if (argv[1] === "/restore") {
					callback(new Error("icacls restore error"), "", "")
				} else if (argv[1] === undefined) {
					// The grant "succeeded" but the DACL still carries an inherited entry.
					callback(null, `${argv[0]} ${os.userInfo().username}:(F) DESKTOP\\users:(I)(RX)`, "")
				} else {
					callback(null, "", "")
				}
				return fakeChild
			})

			// "Verified" is what the row asks for; a grant that leaves inherited access is not it.
			await expect(safeWriteText(targetPath, "data", { platform: "win32" })).rejects.toThrow(DaclRestoreError)
		})

		it("win32 DACL: a narrowing granted to a same-named account in another domain is not accepted", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(execFile).mockImplementation((_cmd, args, _opts, cb) => {
				const argv = args as unknown as string[]
				const callback = cb as unknown as (err: unknown, stdout: string, stderr: string) => void
				if (argv[1] === "/restore") {
					callback(new Error("icacls restore error"), "", "")
				} else if (argv[1] === undefined) {
					// The read-back names a different domain's account that happens to share the
					// local account's name. It is not the principal this process granted.
					callback(null, `${argv[0]} OTHERDOMAIN\\${os.userInfo().username}:(F)`, "")
				} else {
					callback(null, "", "")
				}
				return fakeChild
			})

			// Accepting a principal on its account name alone would call this a verified narrowing
			// and publish under a DACL that grants someone else.
			await expect(safeWriteText(targetPath, "data", { platform: "win32" })).rejects.toThrow(DaclRestoreError)
		})

		it("win32 DACL: a narrowing reported under the machine name is accepted", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			// The machine name is fixed here rather than read from the host, so the assertion says
			// which authority the report is qualified against.
			const savedMachine = process.env.COMPUTERNAME
			const savedDomain = process.env.USERDOMAIN
			process.env.COMPUTERNAME = "TESTMACHINE"
			delete process.env.USERDOMAIN
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(execFile).mockImplementation((_cmd, args, _opts, cb) => {
				const argv = args as unknown as string[]
				const callback = cb as unknown as (err: unknown, stdout: string, stderr: string) => void
				if (argv[1] === "/restore") {
					callback(new Error("icacls restore error"), "", "")
				} else if (argv[1] === undefined) {
					// What icacls really prints for a local account: the machine-qualified name,
					// in its own casing. The grant used the bare account name.
					callback(null, `${argv[0]} testmachine\\${os.userInfo().username}:(F)`, "")
				} else {
					callback(null, "", "")
				}
				return fakeChild
			})

			// The qualified report has to satisfy the verification, or every real narrowing on a
			// local account would be reported as a failure.
			try {
				await expect(safeWriteText(targetPath, "data", { platform: "win32" })).resolves.toBeUndefined()
			} finally {
				if (savedMachine === undefined) {
					delete process.env.COMPUTERNAME
				} else {
					process.env.COMPUTERNAME = savedMachine
				}
				if (savedDomain !== undefined) {
					process.env.USERDOMAIN = savedDomain
				}
			}
		})

		it("win32 DACL: a host without COMPUTERNAME is left without it afterwards", async () => {
			// Canary for the case above: it restores the machine name through the rule below, so on a
			// host that had no COMPUTERNAME a regression there reaches this test as the string
			// "undefined" rather than as an absent variable.
			expect(process.env.COMPUTERNAME).not.toBe("undefined")
			// Node turns any value assigned to process.env into a string, so restoring an unset
			// variable by assignment writes the literal "undefined". Every later case then builds its
			// expected principals from an environment this test invented: on a Linux or macOS
			// host, where COMPUTERNAME is never set, each one silently accepts undefined\<user> as
			// an authority. USERDOMAIN already restored this way; this is the same rule for the
			// machine name, asserted rather than assumed.
			const savedMachine = process.env.COMPUTERNAME
			delete process.env.COMPUTERNAME
			process.env.COMPUTERNAME = "TESTMACHINE"
			try {
				expect(process.env.COMPUTERNAME).toBe("TESTMACHINE")
			} finally {
				// The rule the case above now follows, held to on its own: an unset host variable comes
				// back unset, never as the string "undefined".
				if (savedMachine === undefined) {
					delete process.env.COMPUTERNAME
				} else {
					process.env.COMPUTERNAME = savedMachine
				}
				expect(process.env.COMPUTERNAME).toBe(savedMachine)
			}
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

		it("win32 DACL save runs before the backup copy, not after it", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			// The title is about order, so assert the order the mocks were actually
			// called in. If the save ran after the backup copy the dump could describe a
			// file that a concurrent publish had already replaced.
			await safeWriteText(targetPath, "data", { backup: true, platform: "win32" })

			const callOrder = vi.mocked(execFile).mock.invocationCallOrder
			const copyOrder = vi.mocked(fs.copyFile).mock.invocationCallOrder
			const renameOrder = vi.mocked(fs.rename).mock.invocationCallOrder
			const saveCall = callOrder[0]
			const restoreCall = callOrder[1]
			const backupCopy = copyOrder[0]
			const commitRename = renameOrder[0]

			expect(saveCall).toBeLessThan(backupCopy)
			expect(backupCopy).toBeLessThan(commitRename)
			expect(commitRename).toBeLessThan(restoreCall)
		})

		it("win32 DACL: a failed restore is reported and the dump is still unlinked", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			// icacls save succeeds, restore fails
			// Only the restore fails. The restrictive fallback - drop the inherited ACEs, grant
			// the current user sole full control, read the DACL back - succeeds, which is the
			// alternative to failing the publish that the review row asks for.
			vi.mocked(execFile).mockImplementation((_cmd, args, _opts, cb) => {
				const argv = args as unknown as string[]
				const callback = cb as unknown as (err: unknown, stdout: string, stderr: string) => void
				if (argv[1] === "/restore") {
					callback(new Error("icacls restore error"), "", "")
				} else if (argv[1] === undefined) {
					// The verification read-back: an explicit grant and no (I) inherited marker.
					callback(null, `${argv[0]} ${os.userInfo().username}:(F)`, "")
				} else {
					callback(null, "", "")
				}
				return fakeChild
			})

			await safeWriteText(targetPath, "data", { platform: "win32" })

			// The content did commit: failing here would break every publish on a machine
			// where icacls cannot reapply the saved ACEs.
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), targetPath)
			expect(fs.rename).toHaveBeenCalledTimes(1)

			// The changed access rights are reported instead of being swallowed.
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("could not be restored"))
			warnSpy.mockRestore()

			// dump file was still unlinked in finally
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.acl"))
		})

		it("win32 DACL: a failed restore reaches a caller-supplied onWarning", async () => {
			// Watching console.warn cannot tell the routed warning from the default sink - the
			// default sink also prints - so this case supplies its own sink and requires that the
			// message lands there and NOT on console.warn.
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			const onWarning = vi.fn()

			// icacls save succeeds, restore fails - the same shape as the default-sink case.
			// Only the restore fails. The restrictive fallback - drop the inherited ACEs, grant
			// the current user sole full control, read the DACL back - succeeds, which is the
			// alternative to failing the publish that the review row asks for.
			vi.mocked(execFile).mockImplementation((_cmd, args, _opts, cb) => {
				const argv = args as unknown as string[]
				const callback = cb as unknown as (err: unknown, stdout: string, stderr: string) => void
				if (argv[1] === "/restore") {
					callback(new Error("icacls restore error"), "", "")
				} else if (argv[1] === undefined) {
					// The verification read-back: an explicit grant and no (I) inherited marker.
					callback(null, `${argv[0]} ${os.userInfo().username}:(F)`, "")
				} else {
					callback(null, "", "")
				}
				return fakeChild
			})

			await safeWriteText(targetPath, "data", { platform: "win32", onWarning })

			expect(onWarning).toHaveBeenCalledTimes(1)
			expect(onWarning.mock.calls[0][0]).toContain("could not be restored")
			expect(warnSpy).not.toHaveBeenCalled()
			warnSpy.mockRestore()
		})

		it("win32 DACL: a warning sink that throws does not fail the committed write", async () => {
			// The notice describes a publish that already committed. A caller whose sink throws
			// (a UI sink, a logger mid-restart) must not turn that into a failed save, and the
			// delivery failure itself has to be reported rather than swallowed.
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			const onWarning = vi.fn(() => {
				throw new Error("sink failed")
			})

			// icacls save succeeds, restore fails - the same shape as the other two cases.
			// Only the restore fails. The restrictive fallback - drop the inherited ACEs, grant
			// the current user sole full control, read the DACL back - succeeds, which is the
			// alternative to failing the publish that the review row asks for.
			vi.mocked(execFile).mockImplementation((_cmd, args, _opts, cb) => {
				const argv = args as unknown as string[]
				const callback = cb as unknown as (err: unknown, stdout: string, stderr: string) => void
				if (argv[1] === "/restore") {
					callback(new Error("icacls restore error"), "", "")
				} else if (argv[1] === undefined) {
					// The verification read-back: an explicit grant and no (I) inherited marker.
					callback(null, `${argv[0]} ${os.userInfo().username}:(F)`, "")
				} else {
					callback(null, "", "")
				}
				return fakeChild
			})

			await safeWriteText(targetPath, "data", { platform: "win32", onWarning })

			// The write still committed.
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), targetPath)
			expect(fs.rename).toHaveBeenCalledTimes(1)
			// The sink was tried once, and its failure is reported through the fallback.
			expect(onWarning).toHaveBeenCalledTimes(1)
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("onWarning callback failed: sink failed"))
			warnSpy.mockRestore()
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
		// Only the link path is read, so a single answer is enough and keeps the mock's
		// return type matching fs.promises.readlink.
		vi.mocked(fs.readlink).mockResolvedValue("referent.json")

		// Mid-commit a peer writer renames the referent away and back, so the key
		// must still be computable while the link dangles.
		await expect(resolveLockKey("/tmp/linkdir/file.json")).resolves.toBe(
			path.resolve(path.join("/tmp/linkdir", "referent.json")),
		)
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
		const stats = _fileStatsWithIdentity(42n, 7n)
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
		const stagingStats = _fileStatsWithIdentity(42n, 7n)
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

describe("cleanup when a backed-up write fails before commit", () => {
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

// The backup seed descriptor already goes through _closeDescriptor: a close that fails is
// retried once, the second failure is logged rather than allowed to replace the operation's
// own error, and the descriptor is not abandoned. The four descriptors below are the ones the
// review row names as not doing that yet - one test per descriptor.
describe("descriptor release is attempted once and reported", () => {
	const targetPath = "/tmp/test-dir/target.txt"
	const dirPath = path.resolve("/tmp/test-dir")
	const closeErr = () => Object.assign(new Error("EBADF close"), { code: "EBADF" })

	beforeEach(() => {
		mockDefaults()
		// The staging write reports every requested byte as written.
		vi.mocked(fsSync.writeSync).mockImplementation((...args: unknown[]) =>
			typeof args[3] === "number" ? args[3] : 0,
		)
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
	})

	it("a close failure on the staging descriptor is attempted once and logged", async () => {
		let nextFd = 20
		vi.mocked(fsSync.openSync).mockImplementation(() => nextFd++)
		vi.mocked(fsSync.closeSync).mockImplementation(() => {
			throw closeErr()
		})
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		// The content was staged and fsynced before the close, so a close that fails is a leak to
		// report, not a reason to fail the write.
		await expect(safeWriteText(targetPath, "data", { platform: "linux" })).resolves.toBeUndefined()

		// The invariant is that no descriptor number is closed twice, whatever else this write
		// opened with the same number.
		const closedFds = vi.mocked(fsSync.closeSync).mock.calls.map((c) => Number(c[0]))
		expect(new Set(closedFds).size).toBe(closedFds.length)
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("staging descriptor for"), expect.anything())
		errSpy.mockRestore()
	})

	it("a close failure on a caller-supplied temp descriptor is attempted once and logged", async () => {
		const callerTemp = path.join(dirPath, "caller-staged.tmp")
		let nextFd = 30
		vi.mocked(fsSync.openSync).mockImplementation(() => nextFd++)
		vi.mocked(fsSync.closeSync).mockImplementation(() => {
			throw closeErr()
		})
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		await expect(
			safeWriteText(targetPath, "data", { platform: "linux", tempPath: callerTemp }),
		).resolves.toBeUndefined()

		const closedFds = vi.mocked(fsSync.closeSync).mock.calls.map((c) => Number(c[0]))
		expect(new Set(closedFds).size).toBe(closedFds.length)
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("staged temp descriptor for"), expect.anything())
		errSpy.mockRestore()
	})

	it("a close failure on the backup fsync descriptor is attempted once and logged", async () => {
		// The seed and the fsync handle open the same backup path, so the flags tell them
		// apart: only the fsync handle (r+) gets the descriptor whose close fails.
		vi.mocked(fsSync.openSync).mockImplementation((target, flags) =>
			String(target).includes("safeWriteText.bak") && String(flags) === "r+" ? 5 : 3,
		)
		vi.mocked(fsSync.closeSync).mockImplementation((fd) => {
			if (fd === 5) {
				throw closeErr()
			}
		})
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		await expect(safeWriteText(targetPath, "data", { platform: "linux", backup: true })).resolves.toBeUndefined()

		expect(vi.mocked(fsSync.closeSync).mock.calls.filter((c) => c[0] === 5)).toHaveLength(1)
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("backup fsync descriptor for"), expect.anything())
		errSpy.mockRestore()
	})

	it("a close failure on the parent directory descriptor is logged without failing the durable write", async () => {
		// The parent directory is the only descriptor opened read-only.
		vi.mocked(fsSync.openSync).mockImplementation((_target, flags) => (String(flags) === "r" ? 7 : 3))
		vi.mocked(fsSync.closeSync).mockImplementation((fd) => {
			if (fd === 7) {
				throw closeErr()
			}
		})
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		// The durability question this block answers belongs to the fsync, which succeeded. A close
		// that fails afterwards is a leak to report: turning it into PostCommitDurabilityError would
		// tell the caller its directory entry may not be durable when the evidence says it is.
		await expect(safeWriteText(targetPath, "data", { platform: "linux" })).resolves.toBeUndefined()

		expect(vi.mocked(fsSync.closeSync).mock.calls.filter((c) => c[0] === 7)).toHaveLength(1)
		expect(errSpy).toHaveBeenCalledWith(
			expect.stringContaining("parent directory descriptor for"),
			expect.anything(),
		)
		errSpy.mockRestore()
	})
})

describe("windows ACL failure leaves no unauthorized content", () => {
	const targetPath = "/tmp/test-dir/target.txt"

	beforeEach(() => {
		mockDefaults()
		vi.mocked(fsSync.writeSync).mockImplementation((...args: unknown[]) =>
			typeof args[3] === "number" ? args[3] : 0,
		)
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
		vi.mocked(fsSync.openSync).mockReturnValue(3)
	})

	// icacls is dispatched by its arguments so only the operation under test can be made to fail.
	const icacls = (handler: (argv: string[]) => { error?: unknown; stdout?: string }) =>
		vi.mocked(execFile).mockImplementation(((
			_cmd: string,
			argv: string[],
			_opts: unknown,
			cb: (err: unknown, stdout?: string) => void,
		) => {
			const outcome = handler(argv)
			return void cb(outcome.error ?? null, outcome.stdout ?? "")
		}) as never)

	it("rolls the previous content back even when the caller asked for no backup", async () => {
		// Without a copy to roll back onto, a DACL that can be neither restored nor narrowed would
		// leave the new bytes at the target under an inherited ACL - content published under access
		// rights nobody authorized, reported as a failed save. So a publish that captures a DACL also
		// retains the pre-write content privately, whatever the caller asked for.
		const grants: string[][] = []
		icacls((argv) => {
			grants.push(argv)
			if (argv.includes("/save")) {
				return { stdout: "" }
			}
			if (argv.includes("/restore")) {
				return { error: Object.assign(new Error("icacls 1300"), { code: 1300 }) }
			}
			if (argv.includes("/grant:r")) {
				return { error: Object.assign(new Error("icacls 5"), { code: 5 }) }
			}
			return { stdout: "no access-control entries in this report" }
		})

		await expect(safeWriteText(targetPath, "new data", { platform: "win32" })).rejects.toThrow(DaclRestoreError)

		// The pre-write content is renamed back over the target, and the copy that made it possible
		// exists even though this caller passed no backup option.
		expect(fs.copyFile).toHaveBeenCalledWith(targetPath, expect.stringContaining("safeWriteText.bak_"))
		expect(
			vi
				.mocked(fs.rename)
				.mock.calls.some((call) => String(call[0]).includes("safeWriteText.bak_") && call[1] === targetPath),
		).toBe(true)
		// The rolled-back file is the backup, whose access rights came from its directory rather than
		// from the original target, so the verified narrowing runs on it too.
		expect(
			grants.filter((argv) => argv[0] === targetPath && argv.includes("/grant:r")).length,
		).toBeGreaterThanOrEqual(2)
	})

	it("keeps the retained backup when the rollback rename itself fails", async () => {
		// Once the commit has replaced the target, the backup is the only copy of the pre-write
		// content. A cleanup that unlinks it because the write is failing turns a failed save into
		// lost data - the same shape as a finally block swallowing the error it follows.
		icacls((argv) => {
			if (argv.includes("/save")) {
				return { stdout: "" }
			}
			if (argv.includes("/restore")) {
				return { error: Object.assign(new Error("icacls 1300"), { code: 1300 }) }
			}
			if (argv.includes("/grant:r")) {
				return { error: Object.assign(new Error("icacls 5"), { code: 5 }) }
			}
			return { stdout: "no access-control entries in this report" }
		})
		vi.mocked(fs.rename).mockImplementation((async (from: unknown) => {
			if (String(from).includes("safeWriteText.bak_")) {
				throw Object.assign(new Error("EPERM rollback"), { code: "EPERM" })
			}
		}) as never)
		const warn = vi.fn()

		await expect(safeWriteText(targetPath, "new data", { platform: "win32", onWarning: warn })).rejects.toThrow(
			DaclRestoreError,
		)

		expect(fs.unlink).not.toHaveBeenCalledWith(expect.stringContaining("safeWriteText.bak_"))
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("retained at"))
	})

	it("refuses a read-back whose only mention of the user is the file path", async () => {
		// icacls prints the path first, and a workspace path normally contains the user name
		// (C:\Users\<user>\...), so a substring match would accept a file that grants that user
		// nothing at all.
		icacls((argv) => {
			if (argv.includes("/save")) {
				return { stdout: "" }
			}
			if (argv.includes("/restore")) {
				return { error: Object.assign(new Error("icacls 1300"), { code: 1300 }) }
			}
			if (argv.includes("/grant:r")) {
				return { stdout: "" }
			}
			return { stdout: "C:\\Users\\eason\\Documents\\target.txt NT AUTHORITY\\SYSTEM:(F)" }
		})

		await expect(safeWriteText(targetPath, "new data", { platform: "win32" })).rejects.toThrow(DaclRestoreError)
	})
})
