import * as fs from "fs/promises"
import * as fsSync from "fs"
import { execFile } from "child_process"
import type { ChildProcess } from "child_process"
import * as path from "path"

import {
	AncestorReplacedError,
	DaclPreservationError,
	PostCommitDurabilityError,
	resolveLockKey,
	safeWriteText,
	StagingPathError,
	createStagingFile,
	StagingHandle,
	TargetMovedError,
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
	stat: vi.fn(),
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
	// Directory default: it exists, so this write creates no parent directories and
	// pins no ancestor identities unless a test asks for either.
	vi.mocked(fs.stat).mockResolvedValue(_fileStats(false) as unknown as fsSync.BigIntStats)
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
			// A caller-supplied staging file must live in one of this module's private staging
			// directories beside the target; an ordinary file that happens to sit there does not
			// qualify (it could be any pre-existing content, with any access rights).
			const callerTemp = "/tmp/test-dir/.file-safety-staging_peer/caller-staged.txt"
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
			// A caller-supplied staging file must live in one of this module's private staging
			// directories beside the target; an ordinary file that happens to sit there does not
			// qualify (it could be any pre-existing content, with any access rights).
			const callerTemp = "/tmp/test-dir/.file-safety-staging_peer/caller-staged.txt"
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
		// The capture succeeds and only the restore after the commit rename fails, which stays an
		// advisory notice because the content is already committed.
		let icaclsCalls = 0
		vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
			icaclsCalls++
			if (typeof cb === "function") {
				cb(icaclsCalls === 2 ? new Error("icacls restore error") : null, "", "")
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
			// The caller's staging file now lives in a private staging directory beside the target.
			const suppliedTemp = path.join(dirPath, ".file-safety-staging_peer", "caller.new_data.json")
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

		it("win32: an existing target whose DACL cannot be captured is not replaced", async () => {
			// A failed icacls /save used to warn and commit anyway, so a secret file with a
			// restrictive explicit DACL could be replaced by one that inherits the directory's
			// broader rights. Without the capture the guard has no evidence it can reproduce the
			// access boundary, so it publishes nothing.
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// icacls dump fails — the callback-based mock must invoke cb with an error.
			vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
				if (typeof cb === "function") cb(new Error("icacls error"), "", "")
				return fakeChild
			})

			await expect(safeWriteText(targetPath, "data", { platform: "win32" })).rejects.toThrow(
				DaclPreservationError,
			)

			// Nothing was committed, and no restore was attempted from a dump that does not exist.
			expect(fs.rename).not.toHaveBeenCalled()
			expect(execFile).toHaveBeenCalledTimes(1)
			// A partial dump left behind by the failed save is still cleaned up.
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.acl"))
		})

		it("win32: a failed DACL capture is an error, not an advisory warning", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
				if (typeof cb === "function") cb(new Error("icacls error"), "", "")
				return fakeChild
			})
			const warnings: string[] = []

			await expect(
				safeWriteText(targetPath, "data", { platform: "win32", onWarning: (m) => warnings.push(m) }),
			).rejects.toThrow(/could not be captured/)

			// The access boundary is a precondition, not a notice: the caller gets a failure it cannot
			// ignore instead of a line in a log it may never read.
			expect(warnings).toHaveLength(0)
			expect(fs.rename).not.toHaveBeenCalled()
		})

		it("win32: a target that cannot be checked for DACL preservation is not replaced", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// The target exists but is not readable: that is not "absent", so this write cannot show
			// that the target has no access rights to preserve.
			vi.mocked(fs.access).mockImplementation(async (p) => {
				if (String(p) === targetPath) {
					throw Object.assign(new Error("EACCES"), { code: "EACCES" })
				}
			})
			const warnings: string[] = []

			await expect(
				safeWriteText(targetPath, "data", { platform: "win32", onWarning: (m) => warnings.push(m) }),
			).rejects.toThrow(DaclPreservationError)

			expect(execFile).not.toHaveBeenCalled()
			expect(warnings).toHaveLength(0)
			expect(fs.rename).not.toHaveBeenCalled()
		})

		it("win32: reports through onWarning when the saved DACL cannot be restored after the commit", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// The dump succeeds and the restore fails: icacls /restore commonly fails without the
			// required privileges, and the committed file may then carry a different ACL.
			let icaclsCalls = 0
			vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
				icaclsCalls++
				if (typeof cb === "function") {
					if (icaclsCalls === 1) {
						cb(null, "", "")
					} else {
						cb(new Error("icacls restore error"), "", "")
					}
				}
				return fakeChild
			})
			const warnings: string[] = []

			await safeWriteText(targetPath, "data", { platform: "win32", onWarning: (m) => warnings.push(m) })

			// The content is committed and the caller is told about the access-rights change. Failing
			// here would discard a write that already succeeded; the boundary gate is the capture
			// before the commit, which is fatal.
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"), targetPath)
			expect(icaclsCalls).toBe(2)
			expect(warnings.filter((m) => m.includes("could not be restored"))).toHaveLength(1)
		})

		// Warning delivery is advisory: it must not be able to fail the save it is reporting on.
		it("win32: a throwing onWarning does not abort the write", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// Only the post-commit restore fails: that notice is the advisory path that is left, and
			// a throwing sink must not un-commit a published file.
			let icaclsCalls = 0
			vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
				icaclsCalls++
				if (typeof cb === "function") {
					cb(icaclsCalls === 2 ? new Error("icacls restore error") : null, "", "")
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

			await expect(safeWriteText(targetPath, "data", { platform: "win32" })).rejects.toThrow(
				DaclPreservationError,
			)

			// Nothing was committed; only the save was attempted (no restore from a failed dump).
			expect(fs.rename).not.toHaveBeenCalled()
			expect(execFile).toHaveBeenCalledTimes(1)
			const saveArgs = vi.mocked(execFile).mock.calls[0]?.[1]
			expect(saveArgs?.[1]).toBe("/save")
			// the dump path (possibly partially created by icacls) was unlinked
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
			const restoreCall = vi.mocked(execFile).mock.calls[1]
			expect(restoreCall[0]).toBe("icacls")
			expect(restoreCall[1]).toEqual([
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

			// icacls save succeeds, the post-commit restore fails
			let callCount = 0
			vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
				callCount++
				if (typeof cb === "function") {
					cb(callCount === 2 ? new Error("icacls restore error") : null, "", "")
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

			const customTempPath = "/tmp/test-dir/.file-safety-staging_peer/custom-temp.tmp"

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

			const customTempPath = "/tmp/test-dir/.file-safety-staging_peer/custom-temp.tmp"

			await safeWriteText(targetPath, "", { tempPath: customTempPath, platform: "linux" })

			// the caller-staged temp is fchmod'd to the restrictive target mode so
			// the atomic rename cannot widen a 0o600 target (CWE-732 regression)
			expect(fsSync.fchmodSync).toHaveBeenCalledWith(2, 0o600)
			expect(fsSync.openSync).toHaveBeenCalledWith(customTempPath, "r+")
			expect(fs.rename).toHaveBeenCalledWith(customTempPath, targetPath)
		})

		it("applies the fresh-file default mode masked by the process umask when the target does not exist yet (ENOENT)", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
			vi.mocked(fsSync.statSync).mockImplementation(() => {
				throw enoent
			})
			vi.mocked(fsSync.openSync).mockReturnValue(2)
			// fchmodSync does not apply the umask the way openSync's creation mode does, so the
			// production default must mask it explicitly. A fixed umask keeps the expected mode
			// deterministic on every lane.
			const umaskSpy = vi.spyOn(process, "umask").mockReturnValue(0o027)

			const customTempPath = "/tmp/test-dir/.file-safety-staging_peer/custom-temp.tmp"

			try {
				await safeWriteText(targetPath, "", { tempPath: customTempPath, platform: "linux" })
			} finally {
				umaskSpy.mockRestore()
			}

			// No existing target means nothing to preserve, but the published file still gets the
			// documented default for a fresh file, narrowed by the umask: 0o644 & ~0o027 = 0o640.
			// The staging file is created 0600 so unpublished content is private, and publishing
			// that mode unchanged would make every new file owner-only. Contract change: this test
			// used to assert no fchmod at all, then an unmasked 0o644.
			const freshModeCalls = vi
				.mocked(fsSync.fchmodSync)
				.mock.calls.filter(([fd, mode]) => fd === 2 && mode === 0o640)
			expect(freshModeCalls).toHaveLength(1)
			expect(vi.mocked(fsSync.fchmodSync).mock.calls.filter(([, mode]) => mode === 0o644)).toEqual([])
			expect(fs.rename).toHaveBeenCalledWith(customTempPath, targetPath)
		})

		it("honors a restrictive umask for the fresh-target default mode (caller-staged)", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
			vi.mocked(fsSync.statSync).mockImplementation(() => {
				throw enoent
			})
			vi.mocked(fsSync.openSync).mockReturnValue(2)
			// The trigger from the review: umask 0o077. A self-staged new file is created through
			// openSync(..., 0o644), which the umask narrows to 0o600; the staging-handle branch
			// must not publish 0o644 past a restrictive umask, or the same process gets two
			// different fresh-file modes decided by a staging detail.
			const umaskSpy = vi.spyOn(process, "umask").mockReturnValue(0o077)

			const customTempPath = "/tmp/test-dir/.file-safety-staging_peer/custom-temp.tmp"

			try {
				await safeWriteText(targetPath, "", { tempPath: customTempPath, platform: "linux" })
			} finally {
				umaskSpy.mockRestore()
			}

			const freshModeCalls = vi
				.mocked(fsSync.fchmodSync)
				.mock.calls.filter(([fd, mode]) => fd === 2 && mode === 0o600)
			expect(freshModeCalls).toHaveLength(1)
			expect(vi.mocked(fsSync.fchmodSync).mock.calls.filter(([, mode]) => mode === 0o644)).toEqual([])
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

			const customTempPath = "/tmp/test-dir/.file-safety-staging_peer/custom-temp.tmp"

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

			const customTempPath = "/tmp/test-dir/.file-safety-staging_peer/custom-temp.tmp"

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

	it("keeps the key canonical while the parent directory is also missing", async () => {
		const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
		vi.mocked(fs.realpath).mockImplementation(async (target: unknown) => {
			const key = String(target)
			if (key === "/tmp/aliasdir") return "/tmp/realdir"
			throw enoent
		})
		// Two writers creating the same new file under a directory that does not exist yet
		// must take ONE lock. Falling back to the lexical parent keeps the alias component,
		// so the key would change the moment the directory appears.
		await expect(resolveLockKey("/tmp/aliasdir/newdir/file.json")).resolves.toBe(
			path.join("/tmp/realdir", "newdir", "file.json"),
		)
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
		// The staging path has to sit in a private staging directory, or the location rule
		// refuses it before the symlink check runs and this test proves nothing about symlinks.
		await expect(
			safeWriteText(targetPath, "data", {
				tempPath: "/tmp/test-dir/.file-safety-staging_peer/x.tmp",
				platform: "linux",
			}),
		).rejects.toThrow(/symlink/i)
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

		await expect(
			// An alias of the target, spelled as a file in a private staging directory: the
			// location check passes and the identity check is what must refuse it.
			safeWriteText(targetPath, "data", {
				tempPath: "/tmp/test-dir/.file-safety-staging_alias/alias.txt",
				platform: "linux",
			}),
		).rejects.toThrow(StagingPathError)
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
			safeWriteText(targetPath, "data", {
				tempPath: "/tmp/test-dir/.file-safety-staging_hard/hardlink.txt",
				platform: "linux",
			}),
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

// ── The pin a confined caller hands down: same target, same directories ──────

describe("authorized-target pin (confinement TOCTOU)", () => {
	beforeEach(() => mockDefaults())

	it("refuses to publish when the path no longer resolves to the authorized target", async () => {
		const dir = path.resolve("/tmp/test-dir")
		const authorized = path.join(dir, "target.txt")
		// The caller checked confinement while the name pointed inside its scope; by the
		// time this primitive resolves it, a local process has repointed the link. The
		// decision was never made about the file now reachable, so nothing is published.
		vi.mocked(fs.realpath).mockResolvedValue(path.join(path.resolve("/outside"), "the-victim.txt"))

		const error = await safeWriteText(authorized, "data", {
			expectedResolvedPath: authorized,
			platform: "linux",
		}).catch((caught: unknown) => caught)

		expect(error).toBeInstanceOf(TargetMovedError)
		expect((error as TargetMovedError).authorizedPath).toBe(authorized)
		expect((error as TargetMovedError).resolvedPath).toBe(path.join(path.resolve("/outside"), "the-victim.txt"))
		expect(fs.rename).not.toHaveBeenCalled()
		// Nothing was prepared either: the pin is checked before any directory is made.
		expect(fs.mkdir).not.toHaveBeenCalled()
	})

	it("refuses to publish when an authorized parent directory was replaced after the check", async () => {
		// expectedResolvedPath pins the NAME being published; it cannot notice the
		// directory the name lives in being swapped for another one. The recorded
		// ancestor identities are what catch it.
		const dir = path.resolve("/tmp/test-dir")
		const targetPath = path.join(dir, "target.txt")
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
		vi.mocked(fsSync.openSync).mockReturnValue(1)
		vi.mocked(fs.stat).mockResolvedValue(_fileStatsWithIdentity(999n, 1n)) // was ino 100n

		const error = await safeWriteText(targetPath, "data", {
			expectedResolvedPath: targetPath,
			expectedAncestorIdentities: [{ dir, dev: 1n, ino: 100n }],
			platform: "linux",
		}).catch((caught: unknown) => caught)

		expect(error).toBeInstanceOf(AncestorReplacedError)
		expect((error as AncestorReplacedError).directory).toBe(dir)
		expect((error as AncestorReplacedError).message).toContain("no longer the directory that was authorized")
		expect(fs.rename).not.toHaveBeenCalled()
		// The staged copy is cleaned up rather than left beside the target.
		expect(vi.mocked(fs.unlink).mock.calls.some((call) => String(call[0]).includes("safeWriteText_"))).toBe(true)
	})

	it("publishes when the recorded ancestor identities are unchanged", async () => {
		// The pin must not turn every confined write into a false rejection.
		const dir = path.resolve("/tmp/test-dir")
		const targetPath = path.join(dir, "target.txt")
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
		vi.mocked(fsSync.openSync).mockReturnValue(1)
		vi.mocked(fs.stat).mockResolvedValue(_fileStatsWithIdentity(100n, 1n))

		await safeWriteText(targetPath, "data", {
			expectedResolvedPath: targetPath,
			expectedAncestorIdentities: [{ dir, dev: 1n, ino: 100n }],
			platform: "linux",
		})

		expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), targetPath)
	})

	it("refuses the publish when an authorized ancestor disappears before the commit", async () => {
		const dir = path.resolve("/tmp/test-dir")
		const targetPath = path.join(dir, "target.txt")
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
		vi.mocked(fsSync.openSync).mockReturnValue(1)
		vi.mocked(fs.stat).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

		const error = await safeWriteText(targetPath, "data", {
			expectedResolvedPath: targetPath,
			expectedAncestorIdentities: [{ dir, dev: 1n, ino: 100n }],
			platform: "linux",
		}).catch((caught: unknown) => caught)

		expect(error).toBeInstanceOf(AncestorReplacedError)
		expect((error as AncestorReplacedError).message).toContain("no longer exists")
		expect(fs.rename).not.toHaveBeenCalled()
	})

	it("refuses the publish when a parent this write created is swapped for a link", async () => {
		// The caller could only pin the directories that existed when it authorized the target,
		// and a recursive mkdir does not report what it made, so the components this write
		// creates had no recorded identity: the re-check walked a list that was missing exactly
		// the directories most likely to appear between the check and the commit. A local process
		// that replaces one of them with a link to outside the scope sends the commit somewhere
		// the confinement decision never made, while every recorded identity still matches - the
		// names are unchanged. So the primitive, which measures the missing tail before creating
		// it, has to pin what it created and hand that to the same re-check.
		const dir = path.resolve("/tmp/test-dir")
		const created = path.join(dir, "new-parent")
		const targetPath = path.join(created, "target.txt")
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
		vi.mocked(fsSync.openSync).mockReturnValue(1)
		const probes = new Map<string, number>()
		vi.mocked(fs.stat).mockImplementation(async (probe) => {
			const key = String(probe)
			const seen = (probes.get(key) ?? 0) + 1
			probes.set(key, seen)
			if (key === dir) {
				return _fileStatsWithIdentity(100n, 1n)
			}
			if (key === created) {
				// 1: measuring the missing tail, before anything is created.
				if (seen === 1) {
					throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
				}
				// 2: the identity of the directory this write has just created.
				if (seen === 2) {
					return _fileStatsWithIdentity(200n, 1n)
				}
				// 3: at the re-check it is a different directory - the swap.
				return _fileStatsWithIdentity(999n, 1n)
			}
			return _fileStatsWithIdentity(1n, 1n)
		})

		const error = await safeWriteText(targetPath, "data", {
			expectedResolvedPath: targetPath,
			expectedAncestorIdentities: [{ dir, dev: 1n, ino: 100n }],
			platform: "linux",
		}).catch((caught: unknown) => caught)

		expect(error).toBeInstanceOf(AncestorReplacedError)
		expect((error as AncestorReplacedError).directory).toBe(created)
		expect(fs.rename).not.toHaveBeenCalled()
	})

	it("publishes when a parent this write created keeps the identity it was given", async () => {
		// Pinning what was created must not reject the ordinary case: a confined write into a
		// directory tree it had to make itself is the common shape, not an attack.
		const dir = path.resolve("/tmp/test-dir")
		const created = path.join(dir, "new-parent")
		const targetPath = path.join(created, "target.txt")
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
		vi.mocked(fsSync.openSync).mockReturnValue(1)
		const probes = new Map<string, number>()
		vi.mocked(fs.stat).mockImplementation(async (probe) => {
			const key = String(probe)
			const seen = (probes.get(key) ?? 0) + 1
			probes.set(key, seen)
			if (key === dir) {
				return _fileStatsWithIdentity(100n, 1n)
			}
			if (key === created) {
				if (seen === 1) {
					throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
				}
				return _fileStatsWithIdentity(200n, 1n)
			}
			return _fileStatsWithIdentity(1n, 1n)
		})

		await safeWriteText(targetPath, "data", {
			expectedResolvedPath: targetPath,
			expectedAncestorIdentities: [{ dir, dev: 1n, ino: 100n }],
			platform: "linux",
		})

		expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), targetPath)
	})
})

// ── Parent directories this write creates must not outlive a failed write ────

describe("parent directories created by safeWriteText", () => {
	beforeEach(() => mockDefaults())

	it("does not create them when a caller-supplied staging path is rejected", async () => {
		// The staging-path checks used to run after the recursive mkdir, so a rejected
		// staging path still left a freshly created parent tree beside a target that was
		// never written.
		const dir = path.resolve("/tmp/deep/new-parent")
		const targetPath = path.join(dir, "target.txt")
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)

		await expect(
			safeWriteText(targetPath, "data", {
				tempPath: path.join(path.resolve("/elsewhere"), "staged.txt"),
				platform: "linux",
			}),
		).rejects.toBeInstanceOf(StagingPathError)

		expect(fs.mkdir).not.toHaveBeenCalled()
		expect(fs.rename).not.toHaveBeenCalled()
	})

	it("removes the directories it created, innermost first, when the write fails before the commit", async () => {
		const parent = path.resolve("/tmp/test-parent")
		const dir = path.join(parent, "created-by-this-write")
		const targetPath = path.join(dir, "target.txt")
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
		vi.mocked(fsSync.openSync).mockReturnValue(1)
		// Both tail directories are missing before the mkdir; the ancestor exists.
		vi.mocked(fs.stat).mockImplementation(async (p) => {
			const s = String(p)
			if (s === dir || s === parent) {
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
			}
			return _fileStatsWithIdentity(1n, 1n)
		})
		// The commit is the failure point.
		vi.mocked(fs.rename).mockRejectedValue(Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }))

		await expect(safeWriteText(targetPath, "data", { platform: "linux" })).rejects.toThrow("ENOSPC")

		const removed = vi.mocked(fs.rmdir).mock.calls.map((call) => String(call[0]))
		expect(removed).toContain(dir)
		expect(removed).toContain(parent)
		// Innermost outward: a parent may only be removed once its child is gone.
		expect(removed.indexOf(dir)).toBeLessThan(removed.indexOf(parent))
	})
})
// The staging capability: a file this API created, in a directory it owns, bound to the commit
// by identity. These are the Security Boundaries row's requirements - "Create and exclusively
// open the staging file inside a private staging directory owned by this write" and "bind the
// handle to the exact staging inode before the rename".
describe("staging capability", () => {
	const targetPath = "/tmp/test-dir/target.txt"
	const dirPath = path.resolve("/tmp/test-dir")

	beforeEach(() => {
		mockDefaults()
		vi.mocked(fsSync.writeSync).mockImplementation((...args: unknown[]) =>
			typeof args[3] === "number" ? args[3] : 0,
		)
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
	})

	it("creates the staging file exclusively inside a private staging directory", async () => {
		vi.mocked(fsSync.openSync).mockReturnValue(3)
		vi.mocked(fs.lstat).mockResolvedValue(_fileStatsWithIdentity(42n, 7n))

		const handle = await createStagingFile(targetPath)

		// Private directory, private mode, and an exclusive create: an existing name is an error
		// rather than a file this write adopts with somebody else's content and access rights.
		expect(fsSync.mkdirSync).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"), {
			recursive: true,
			mode: 0o700,
		})
		expect(fsSync.openSync).toHaveBeenCalledWith(expect.stringContaining("safeWriteText"), "wx", 0o600)
		const parent = path.dirname(handle.tempPath)
		expect(path.dirname(parent)).toBe(dirPath)
		expect(path.basename(parent).startsWith(".file-safety-staging")).toBe(true)
		// The identity the commit will be bound to is the one read at create time.
		expect(handle.ino).toBe(42n)
		expect(handle.dev).toBe(7n)
	})

	it("publishes a handle whose identity still matches the file it created", async () => {
		vi.mocked(fsSync.openSync).mockReturnValue(3)
		vi.mocked(fs.lstat).mockResolvedValue(_fileStatsWithIdentity(42n, 7n))
		const stagingDir = path.join(dirPath, ".file-safety-staging_1")
		const staging = new StagingHandle(path.join(stagingDir, "safeWriteText_1_a.tmp"), stagingDir, 7n, 42n)

		await safeWriteText(targetPath, "data", { platform: "linux", staging })

		// The supplied content is fsynced through the handle's own file and renamed from it.
		expect(fsSync.openSync).toHaveBeenCalledWith(staging.tempPath, "r+")
		expect(fs.rename).toHaveBeenCalledWith(staging.tempPath, targetPath)
		// The staging directory the handle created is this write's to remove.
		expect(fs.rmdir).toHaveBeenCalledWith(stagingDir)
	})

	it("refuses a handle whose name now files a different inode, before committing", async () => {
		vi.mocked(fsSync.openSync).mockReturnValue(3)
		// Somebody replaced the file under the same name between the create and the commit.
		vi.mocked(fs.lstat).mockResolvedValue(_fileStatsWithIdentity(4242n, 7n))
		const stagingDir = path.join(dirPath, ".file-safety-staging_1")
		const staging = new StagingHandle(path.join(stagingDir, "safeWriteText_1_a.tmp"), stagingDir, 7n, 42n)

		await expect(safeWriteText(targetPath, "data", { platform: "linux", staging })).rejects.toThrow(
			StagingPathError,
		)

		expect(fsSync.openSync).not.toHaveBeenCalled()
		expect(fs.rename).not.toHaveBeenCalled()
	})

	it("rejects a bare staging path that is not inside a private staging directory", async () => {
		vi.mocked(fs.lstat).mockResolvedValue(_fileStatsWithIdentity(42n, 7n))

		// The row's concrete hazard: any existing file beside the target could be published onto
		// it - content nobody staged, with access rights nobody captured.
		await expect(
			safeWriteText(targetPath, "data", {
				platform: "linux",
				tempPath: path.join(dirPath, "someones-secret.txt"),
			}),
		).rejects.toThrow("private staging directory")

		expect(fsSync.openSync).not.toHaveBeenCalled()
		expect(fs.rename).not.toHaveBeenCalled()
	})
})

// The Regression Evidence row: parent-directory setup (fs.mkdir / fs.access of the target's
// directory) had no failure coverage. A filesystem error here must surface as itself, commit
// nothing, and leave neither a staging file, a staging directory, nor a parent tree behind.
describe("parent directory setup failures", () => {
	const targetPath = "/tmp/test-dir/target.txt"
	const dirPath = path.resolve("/tmp/test-dir")

	beforeEach(() => {
		mockDefaults()
		vi.mocked(fsSync.writeSync).mockImplementation((...args: unknown[]) =>
			typeof args[3] === "number" ? args[3] : 0,
		)
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
		vi.mocked(fsSync.openSync).mockReturnValue(3)
	})

	it("propagates a non-ENOENT fs.mkdir rejection without committing, and cleans up", async () => {
		const mkdirError = Object.assign(new Error("EACCES: permission denied, mkdir"), { code: "EACCES" })
		vi.mocked(fs.mkdir).mockRejectedValue(mkdirError)

		// The original error object, not a wrapper: the caller's own diagnosis is the code.
		await expect(safeWriteText(targetPath, "data", { platform: "linux" })).rejects.toBe(mkdirError)

		expect(fs.rename).not.toHaveBeenCalled()
		expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"))
		expect(fs.rmdir).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"))
	})

	it("propagates a non-ENOENT fs.access rejection without committing, and cleans up", async () => {
		const accessError = Object.assign(new Error("EACCES: permission denied, access"), { code: "EACCES" })
		vi.mocked(fs.access).mockRejectedValue(accessError)

		await expect(safeWriteText(targetPath, "data", { platform: "linux" })).rejects.toBe(accessError)

		expect(fs.rename).not.toHaveBeenCalled()
		expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"))
		expect(fs.rmdir).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"))
	})

	it("removes the parent directories it created when the write fails before the commit", async () => {
		// The parent does not exist yet, so this write is the one that makes it.
		vi.mocked(fs.stat).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
		vi.mocked(fs.rename).mockRejectedValue(Object.assign(new Error("EPERM: rename failed"), { code: "EPERM" }))

		await expect(safeWriteText(targetPath, "data", { platform: "linux" })).rejects.toThrow("EPERM")

		// Both the staging directory and the parent tree this write created are gone, innermost
		// outward (the parent is spelled as the write derived it, not as path.resolve would).
		expect(fs.rmdir).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"))
		expect(fs.rmdir).toHaveBeenCalledWith("/tmp/test-dir")
	})
})
describe("staging handle failures", () => {
	beforeEach(() => {
		mockDefaults()
	})

	it("removes the directory it created when the handle cannot be handed out", async () => {
		// createStagingFile makes the private staging directory before it can hand anything back,
		// so a failure after that point has no other owner: an empty .file-safety-staging_* beside
		// the target would otherwise be residue nothing ever cleans.
		const boom = Object.assign(new Error("EIO on lstat"), { code: "EIO" })
		vi.mocked(fs.lstat).mockRejectedValue(boom)

		await expect(createStagingFile("/tmp/test-dir/target.txt")).rejects.toBe(boom)

		expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"))
		expect(fs.rmdir).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"))
	})
})
