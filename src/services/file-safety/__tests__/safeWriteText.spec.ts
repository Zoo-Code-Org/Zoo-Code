import * as fs from "fs/promises"
import * as fsSync from "fs"
import { execFile } from "child_process"
import type { ChildProcess } from "child_process"
import * as path from "path"

import {
	LockKeyWalkIncompleteError,
	PostCommitDurabilityError,
	resolveLockKey,
	safeWriteText,
	StagingPathError,
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
	// Production reads the two directories through fs.stat (bigint) when the caller's directory spelling
	// differs from the target's, so the mock has to carry the method. The default reports "not there", which
	// is what a mocked path outside the target's directory already meant for these rows.
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
	fstatSync: vi.fn(),
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

// The writer takes the account name for its Windows grant from os.userInfo(), which on a hosted lane
// is whichever user that lane runs as. This file mocks os.userInfo() with a plain stand-in - a spy on
// an ES module namespace is refused at runtime - so the account named in the grant below is named
// here instead of being inherited from the host, and every row in the file sees the same one.
const ACL_TEST_ACCOUNT = "acl-test-account"
let aclAccountName = ACL_TEST_ACCOUNT

vi.mock("os", async () => {
	const actual = await vi.importActual<typeof import("os")>("os")
	return {
		...actual,
		userInfo: () => ({ uid: 0, gid: 0, username: aclAccountName, homedir: "", shell: "" }),
	}
})

function _useAccount(name: string): void {
	aclAccountName = name
}

// The icacls verbs one write asked for, in the order it asked for them. A win32 self-staged write
// asks for "narrow" (the staging directory, before any content goes into it), then "save" and
// "restore" for the target's DACL, and "reset" only when a narrowing left this process no right to
// stage into the directory at all.
function _icaclsVerb(call: readonly unknown[]): string {
	const parts = call
		.slice(1)
		.flatMap((part: unknown) => (Array.isArray(part) ? part.map((item: unknown) => String(item)) : [String(part)]))
	if (parts.includes("/inheritance:r")) {
		return "narrow"
	}
	if (parts.includes("/save")) {
		return "save"
	}
	if (parts.includes("/restore")) {
		return "restore"
	}
	return parts.includes("/reset") ? "reset" : "other"
}

function _icaclsVerbs(calls: readonly (readonly unknown[])[]): string[] {
	return calls.map(_icaclsVerb)
}

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
	// The caller-staged branch re-confirms the file its fd landed on through fs.fstatSync. The
	// default carries no bigint identity, which is the shape production never hands this compare
	// (it asks for { bigint: true }), so the guard declines to read it as a swap and the rows below
	// keep the meaning they had before the re-confirm existed. Rows that care about identity say so
	// by handing both sides one.
	vi.mocked(fsSync.fstatSync).mockReturnValue(_fileStats(false))
	vi.mocked(fs.stat).mockRejectedValue(Object.assign(new Error("no such directory"), { code: "ENOENT" }))
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
		// The staging directory is private, and it must stay the only thing that is. Created inside
		// a parent that does not exist yet, the recursive mkdirSync that makes it also makes that
		// parent -- with the staging mode -- so the target ends up published into an owner-only
		// directory it never asked for. What matters is the order of the two creations and the
		// mode each one carries, recorded across both filesystem APIs this write uses.
		it("creates the target's parent directory before the private staging directory", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			const parentDir = path.dirname(targetPath)
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			const creations: Array<{ path: string; mode?: number }> = []
			try {
				vi.mocked(fs.mkdir).mockImplementation(async (p: Parameters<typeof fs.mkdir>[0]) => {
					creations.push({ path: String(p) })
					return undefined
				})
				const syncMkdir = vi.mocked(fsSync.mkdirSync)
				syncMkdir.mockImplementation(((p: string | Buffer | URL, options?: unknown) => {
					creations.push({
						path: String(p),
						mode: (options as { mode?: number }).mode,
					})
				}) as unknown as typeof fsSync.mkdirSync)

				await safeWriteText(targetPath, "hello world", { platform: "linux" })

				const parent = creations.findIndex((c) => c.path === parentDir)
				const staging = creations.findIndex((c) => c.path.includes(".file-safety-staging"))
				expect(parent).toBeGreaterThanOrEqual(0)
				expect(staging).toBeGreaterThanOrEqual(0)
				// The parent is made first, by the plain recursive mkdir, which carries no mode of
				// its own and therefore gets the directory default.
				expect(staging).toBeGreaterThan(parent)
				expect(creations[parent].mode).toBeUndefined()
				// The private mode is still applied -- to the staging directory alone.
				expect(creations[staging].mode).toBe(0o700)
			} finally {
				vi.mocked(fs.mkdir).mockReset()
				vi.mocked(fs.mkdir).mockResolvedValue(undefined)
				vi.mocked(fsSync.mkdirSync).mockReset()
			}
		})

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
				// default platform is win32: the staging narrowing + the DACL save + restore still ran
				// through the default icacls path (options?.execFileRunner must not throw when options is
				// undefined)
				expect(_icaclsVerbs(vi.mocked(execFile).mock.calls)).toEqual(["narrow", "save", "restore"])
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
		vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
			if (typeof cb === "function") cb(new Error("icacls error"), "", "")
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

			// The durability failure is reported, not swallowed. The backup is NOT deleted:
			// after the commit the target holds the NEW content, and this copy is the only
			// one known to hold the previous content - the recovery copy the contract
			// promises for exactly this path.
			const backupUnlinks = vi.mocked(fs.unlink).mock.calls.filter(function (call: unknown[]) {
				return String(call[0]).includes("safeWriteText.bak_")
			})
			expect(backupUnlinks).toEqual([])
			// The staged temp is still cleaned up.
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"))
		})

		it("reports the retained backup path on a post-commit durability failure", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			const dirPath = path.dirname(targetPath)
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockImplementation((target) => {
				if (String(target) === dirPath) {
					throw new Error("EBADF")
				}
				return 1
			})

			const error = await safeWriteText(targetPath, "new data", {
				backup: true,
				platform: "linux",
			}).catch(function (caught: unknown) {
				return caught
			})

			// The backup is kept on this path, and its name is a hidden random string. Without
			// the field the caller is told a recovery copy exists and given no way to find it.
			expect(error).toBeInstanceOf(PostCommitDurabilityError)
			const retained = (error as PostCommitDurabilityError).backupPath
			expect(typeof retained).toBe("string")
			expect(String(retained)).toContain("safeWriteText.bak_")
			// The reported path is exactly the copy that was made, so a caller can open it.
			const copiedBackups = vi
				.mocked(fs.copyFile)
				.mock.calls.map(function (call: unknown[]) {
					return String(call[1])
				})
				.filter(function (p: string) {
					return p.includes("safeWriteText.bak_")
				})
			expect(copiedBackups).toContain(retained)
		})

		it("reports a null backup path when no backup was taken", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			const dirPath = path.dirname(targetPath)
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockImplementation((target) => {
				if (String(target) === dirPath) {
					throw new Error("EBADF")
				}
				return 1
			})

			const error = await safeWriteText(targetPath, "new data", {
				platform: "linux",
			}).catch(function (caught: unknown) {
				return caught
			})

			expect(error).toBeInstanceOf(PostCommitDurabilityError)
			expect((error as PostCommitDurabilityError).backupPath).toBeNull()
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
		// The case hands in the platform it wants the writer to believe, so it does not need a
		// Windows host: the neighbouring cases in this describe already run on every lane.
		it("copies target DACL onto staging file via icacls before rename on Windows", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			await safeWriteText(targetPath, "data", { platform: "win32" })

			// the staging directory was narrowed, then the target DACL was dumped and restored onto
			// the published file (execFile is a callback-based mock)
			expect(_icaclsVerbs(vi.mocked(execFile).mock.calls)).toEqual(["narrow", "save", "restore"])
		})

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
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"), targetPath)
			// the staging narrowing ran, and then the dump failed: a failed DACL apply must not try to
			// restore, so two calls is the whole story here
			expect(_icaclsVerbs(vi.mocked(execFile).mock.calls)).toEqual(["narrow", "save"])
		})

		it("win32: reports that access rights may change when the DACL cannot be saved", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
				if (typeof cb === "function") cb(new Error("icacls error"), "", "")
				return fakeChild
			})
			const warnings: string[] = []

			await safeWriteText(targetPath, "data", { platform: "win32", onWarning: (m) => warnings.push(m) })

			// The write still commits - a failing icacls must not leave the user unable to save -
			// but the caller is told the replacement may not carry the old ACL.
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"), targetPath)
			expect(warnings.filter((m) => m.includes("different access rights"))).toHaveLength(1)
		})

		// The platform here is an argument, not the host: this asserts what every icacls call is
		// bounded by while the write is open, and the neighbouring cases below hand in the same
		// option and already run on every lane, so skipping it off Windows only hid coverage.
		it("bounds every icacls call with a finite timeout under the lock staleness window", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			await safeWriteText(targetPath, "data", { platform: "win32" })

			const calls = vi.mocked(execFile).mock.calls
			expect(_icaclsVerbs(calls)).toEqual(["narrow", "save", "restore"])
			for (const call of calls) {
				expect(call[0]).toBe("icacls")
				// An execFile without a timeout waits for its child forever. While it waits,
				// this write is open and - for a safeWriteJson caller - the per-file advisory
				// lock is held while every other writer of the same file burns its retries.
				const timeout = Number((call[2] as { timeout?: number } | undefined)?.timeout)
				expect(Number.isFinite(timeout)).toBe(true)
				expect(timeout).toBeGreaterThan(0)
				// Below LOCK_STALE_MS (src/utils/fileLock.ts) so a hung helper cannot outlive
				// the staleness window the lock protocol is written around.
				expect(timeout).toBeLessThan(31_000)
			}
		})

		it("win32: a timed-out icacls degrades to the designed skip-DACL path and still commits", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// What execFile hands back when its timeout fires: an error whose code is ETIMEDOUT.
			vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
				if (typeof cb === "function") {
					cb(Object.assign(new Error("spawnSync icacls ETIMEDOUT"), { code: "ETIMEDOUT" }), "", "")
				}
				return fakeChild
			})
			const warnings: string[] = []

			await expect(
				safeWriteText(targetPath, "data", { platform: "win32", onWarning: (m) => warnings.push(m) }),
			).resolves.toBeUndefined()

			// both attempts timed out, and neither is fatal: two bounded calls and no restore.
			expect(_icaclsVerbs(vi.mocked(execFile).mock.calls)).toEqual(["narrow", "save"])
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"), targetPath)
			expect(warnings.filter((m) => m.includes("different access rights"))).toHaveLength(1)
			expect(warnings.filter((m) => m.includes("Could not narrow"))).toHaveLength(1)
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

			// The target could not be checked, so nothing was dumped and nothing was restored. The
			// staging narrowing answers a different question and still ran.
			expect(_icaclsVerbs(vi.mocked(execFile).mock.calls)).toEqual(["narrow"])
			expect(warnings.filter((m) => m.includes("Could not check"))).toHaveLength(1)
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

			await safeWriteText(targetPath, "data", { platform: "win32" })

			// write committed; only the narrowing and the save were attempted (no restore from a
			// failed dump)
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), targetPath)
			expect(fs.rename).toHaveBeenCalledTimes(1)
			expect(_icaclsVerbs(vi.mocked(execFile).mock.calls)).toEqual(["narrow", "save"])
			const saveArgs = vi.mocked(execFile).mock.calls[1]?.[1]
			expect(saveArgs?.[1]).toBe("/save")
			// the dump path (possibly partially created by icacls) was unlinked
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.acl"))
		})

		it("win32 DACL save args are [targetPath, /save, dumpPath, /T] before backup rename", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			await safeWriteText(targetPath, "data", { backup: true, platform: "win32" })

			// The staging directory is narrowed first, then the target DACL is dumped and restored
			expect(_icaclsVerbs(vi.mocked(execFile).mock.calls)).toEqual(["narrow", "save", "restore"])

			// The dump: save DACL from the target before the backup rename
			const dumpCall = vi.mocked(execFile).mock.calls[1]
			expect(dumpCall[0]).toBe("icacls")
			expect(dumpCall[1]).toEqual([targetPath, "/save", expect.stringContaining("safeWriteText.acl"), "/T"])

			// The restore: DACL onto the directory after the commit rename
			const restoreCall = vi.mocked(execFile).mock.calls[2]
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
			const verbs = _icaclsVerbs(vi.mocked(execFile).mock.calls)
			const copyOrder = vi.mocked(fs.copyFile).mock.invocationCallOrder
			const renameOrder = vi.mocked(fs.rename).mock.invocationCallOrder
			const narrowCall = callOrder[verbs.indexOf("narrow")]
			const saveCall = callOrder[verbs.indexOf("save")]
			const restoreCall = callOrder[verbs.indexOf("restore")]
			const backupCopy = copyOrder[0]
			const commitRename = renameOrder[0]

			// The staging directory is narrowed before anything is staged in it, and the dump is taken
			// before the copy that could race a concurrent publish.
			expect(narrowCall).toBeLessThan(saveCall)
			expect(saveCall).toBeLessThan(backupCopy)
			expect(backupCopy).toBeLessThan(commitRename)
			expect(commitRename).toBeLessThan(restoreCall)
		})

		it("win32 DACL: a failed restore is reported and the dump is still unlinked", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			// icacls narrows the staging directory and dumps the target DACL; only the restore fails.
			vi.mocked(execFile).mockImplementation((_cmd, args, _opts, cb) => {
				const failing = String(args).includes("/restore")
				if (typeof cb === "function") {
					cb(failing ? new Error("icacls restore error") : null, "", "")
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

			// The target was absent, so there was no DACL to save and nothing to restore. Only the
			// staging narrowing ran.
			expect(_icaclsVerbs(vi.mocked(execFile).mock.calls)).toEqual(["narrow"])

			// no dump file created or unlinked
			expect(fs.unlink).not.toHaveBeenCalled()
		})
	})

	// ── Test 5b: win32 staging-directory access rights ───────────────────────

	describe("win32 staging DACL", () => {
		// The platform here is an argument, not the host, so these rows run on every lane and assert
		// the order the staging narrowing keeps against the staged write. The row that runs the real
		// icacls against a real NTFS volume lives beside this file as
		// safeWriteText.stagingDacl.spec.ts.
		it("win32: narrows the staging directory before any content is staged in it", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			const narrowCalls: string[] = []
			const openSyncCallsAtNarrow: number[] = []
			vi.mocked(execFile).mockImplementation((_cmd, args, _opts, cb) => {
				if (String(args).includes("/inheritance:r")) {
					// Nothing may have been opened in staging yet: the narrowing has to beat the staged
					// open, because Windows hands a new file the rights its directory holds at the
					// moment the file is created.
					narrowCalls.push(String(args))
					openSyncCallsAtNarrow.push(vi.mocked(fsSync.openSync).mock.calls.length)
				}
				if (typeof cb === "function") {
					cb(null, "", "")
				}
				return fakeChild
			})
			const warnings: string[] = []
			const account = ACL_TEST_ACCOUNT

			await safeWriteText(targetPath, "data", { platform: "win32", onWarning: (m) => warnings.push(m) })

			expect(_icaclsVerbs(vi.mocked(execFile).mock.calls)).toEqual(["narrow", "save", "restore"])
			expect(narrowCalls).toHaveLength(1)
			expect(narrowCalls[0]).toContain(".file-safety-staging")
			expect(narrowCalls[0]).toContain("/inheritance:r")
			expect(narrowCalls[0]).toMatch(/:\(OI\)\(CI\)\(F\)$/)
			expect(narrowCalls[0]).toContain(account)
			expect(openSyncCallsAtNarrow).toEqual([0])
			expect(warnings).toEqual([])
		})

		it("win32: an icacls that cannot map the principal is named by its exit code and does not stop the write", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// Measured on this machine: a name that maps to no SID makes icacls exit 1332 with that
			// message, and an empty principal makes it exit 87 printing its usage text. Neither applies
			// an access right, so the write proceeds on the rights the directory already had.
			const unmapped = Object.assign(new Error("No mapping between account names and security IDs was done."), {
				code: 1332,
			})
			vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
				if (typeof cb === "function") {
					cb(unmapped, "", "")
				}
				return fakeChild
			})
			const warnings: string[] = []

			await expect(
				safeWriteText(targetPath, "data", { platform: "win32", onWarning: (m) => warnings.push(m) }),
			).resolves.toBeUndefined()

			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"), targetPath)
			expect(warnings.filter((m) => m.includes("Could not narrow"))).toHaveLength(1)
			expect(String(warnings[0])).toContain("1332")
			expect(_icaclsVerbs(vi.mocked(execFile).mock.calls)).toEqual(["narrow", "save"])
		})

		it("win32: with no account name to grant to, no child is started and the write still commits", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			_useAccount("")
			const savedUsername = process.env.USERNAME
			const savedLogname = process.env.LOGNAME
			process.env.USERNAME = ""
			process.env.LOGNAME = ""
			const warnings: string[] = []
			try {
				await expect(
					safeWriteText(targetPath, "data", { platform: "win32", onWarning: (m) => warnings.push(m) }),
				).resolves.toBeUndefined()
			} finally {
				process.env.USERNAME = savedUsername
				process.env.LOGNAME = savedLogname
				_useAccount(ACL_TEST_ACCOUNT)
			}

			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"), targetPath)
			expect(_icaclsVerbs(vi.mocked(execFile).mock.calls)).toEqual(["save", "restore"])
			expect(warnings.filter((m) => m.includes("no account name"))).toHaveLength(1)
		})

		it("win32: a narrowing that leaves no right for this process resets the directory and still stages", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			const resetCalls: string[] = []
			// Measured on this machine: with the grant addressed to an account this process does not
			// carry, listing, opening and writing inside the staging directory each answered EPERM. The
			// staged open is where that shows up, so the first open fails and the open after the reset
			// succeeds.
			let firstOpenFailed = false
			vi.mocked(fsSync.openSync).mockImplementation((target: unknown) => {
				if (String(target).includes(".file-safety-staging") && !firstOpenFailed) {
					firstOpenFailed = true
					throw Object.assign(new Error("EPERM: operation not permitted, open"), { code: "EPERM" })
				}
				return 1
			})
			vi.mocked(execFile).mockImplementation((_cmd, args, _opts, cb) => {
				if (String(args).includes("/reset")) {
					resetCalls.push(String(args))
				}
				if (typeof cb === "function") {
					cb(null, "", "")
				}
				return fakeChild
			})
			const warnings: string[] = []

			await expect(
				safeWriteText(targetPath, "data", { platform: "win32", onWarning: (m) => warnings.push(m) }),
			).resolves.toBeUndefined()

			expect(resetCalls).toHaveLength(1)
			expect(resetCalls[0]).toContain(".file-safety-staging")
			expect(_icaclsVerbs(vi.mocked(execFile).mock.calls)).toEqual(["narrow", "reset", "save", "restore"])
			expect(warnings.filter((m) => m.includes("inherited rights were restored"))).toHaveLength(1)
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"), targetPath)
		})

		it("win32: an EPERM on the staged open still fails the write when this write never narrowed the directory", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			const resetCalls: string[] = []
			vi.mocked(fsSync.openSync).mockImplementation(() => {
				throw Object.assign(new Error("EPERM: operation not permitted, open"), { code: "EPERM" })
			})
			vi.mocked(execFile).mockImplementation((_cmd, args, _opts, cb) => {
				if (String(args).includes("/reset")) {
					resetCalls.push(String(args))
				}
				if (typeof cb === "function") {
					cb(new Error("icacls error"), "", "")
				}
				return fakeChild
			})
			const warnings: string[] = []

			await expect(
				safeWriteText(targetPath, "data", { platform: "win32", onWarning: (m) => warnings.push(m) }),
			).rejects.toThrow("EPERM")

			// The narrowing was attempted and failed, so a lockout is not this write's to undo: no
			// reset, no retry, and the original failure reaches the caller.
			expect(resetCalls).toEqual([])
			expect(_icaclsVerbs(vi.mocked(execFile).mock.calls)).toEqual(["narrow"])
			expect(fs.rename).not.toHaveBeenCalled()
			expect(warnings.filter((m) => m.includes("inherited rights were restored"))).toHaveLength(0)
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
			// The distinct fds only show which fsync is which. The title promises the second one runs
			// after the commit rename, so compare the invocations too: a publisher that fsynced the
			// directory before the rename keeps two distinct descriptors and would pass every
			// assertion above while committing the directory entry before the file it names.
			const renameCall = vi.mocked(fs.rename).mock.invocationCallOrder[0]
			const directoryFsyncCall = vi.mocked(fsSync.fsyncSync).mock.invocationCallOrder[1]
			expect(directoryFsyncCall).toBeGreaterThan(renameCall)
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

		// Row 4507851715: the guidance this error gives - do not re-issue the write - is only
		// checkable against a version, so the error has to name the version it committed.
		it("carries the version the commit landed so the caller can say what is on disk", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync)
				.mockReturnValueOnce(1)
				.mockImplementationOnce(() => {
					throw new Error("EBADF")
				})
			// A BigIntStats stand-in carrying the five fields the version token renders.
			// Double assertion: the runtime value is the stand-in, the type is the bigint variant.
			const committed = Object.create(fsSync.Stats.prototype) as unknown as fsSync.BigIntStats
			committed.dev = 7n
			committed.ino = 8n
			committed.size = 4n
			committed.mtimeNs = 9n
			committed.ctimeNs = 10n
			vi.mocked(fs.stat).mockResolvedValue(committed)

			let thrown: unknown
			try {
				await safeWriteText(targetPath, "data", { platform: "linux" })
			} catch (error: unknown) {
				thrown = error
			}

			expect(thrown).toBeInstanceOf(PostCommitDurabilityError)
			const failure = thrown as PostCommitDurabilityError
			// dev:ino:size:mtimeNs:ctimeNs, the same derivation every guard compares against.
			expect(failure.committedVersion).toBe("7:8:4:9:10")
			expect(failure.message).toContain("version 7:8:4:9:10")
			expect(failure.message).toContain("committed, not durable")
			expect(failure.message).toContain("do not re-issue the write")
			expect(failure.targetPath).toBe(targetPath)
		})

		it("still says not to re-issue when the committed version cannot be read", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync)
				.mockReturnValueOnce(1)
				.mockImplementationOnce(() => {
					throw new Error("EBADF")
				})
			// fs.stat defaults to ENOENT here, which is the shape of a target that vanished
			// between the commit and the version read.

			let thrown: unknown
			try {
				await safeWriteText(targetPath, "data", { platform: "linux" })
			} catch (error: unknown) {
				thrown = error
			}

			expect(thrown).toBeInstanceOf(PostCommitDurabilityError)
			const failure = thrown as PostCommitDurabilityError
			expect(failure.committedVersion).toBeUndefined()
			expect(failure.message).toContain("committed, not durable: do not re-issue it")
			expect(failure.message).not.toContain("undefined")
			// The commit is not undone by the failed read: the content is still at the target.
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
		// Only the link path is a symlink: the referent it names is answered as the plain file it
		// is. Answering every readlink call - as a blanket mockResolvedValue did - made the walk
		// re-read its own resolved key as another link, so this test ran the bounded-cycle path
		// (eight readlink calls and the depth limit) instead of the dangling-link path it is named
		// for, and could not tell a correct walk from one that only stops because it gives up.
		const enotlink = Object.assign(new Error("EINVAL: invalid argument, not a symlink"), { code: "EINVAL" })
		vi.mocked(fs.readlink).mockImplementation(async (target) =>
			// Compared on separators, not through path.join: the argument is the caller's spelling,
			// which on Windows is "/tmp/linkdir/file.json" while path.join would render it with
			// backslashes - and a mock that never recognises the link answers every call as "not a
			// link", which is a different scenario from the one this test names.
			String(target).replace(/\\/g, "/") === "/tmp/linkdir/file.json"
				? "referent.json"
				: Promise.reject(enotlink),
		)

		// Mid-commit a peer writer renames the referent away and back, so the key
		// must still be computable while the link dangles.
		await expect(resolveLockKey("/tmp/linkdir/file.json")).resolves.toBe(
			path.resolve(path.join("/tmp/linkdir", "referent.json")),
		)
		// Two readlink calls, and that count is the proof of the normal exit: one from
		// resolvePublishTarget on the link, one from the fallback walk on the referent, which is
		// answered as "not a link" and ends the walk. The bounded walk would have asked eight times
		// - what the cycle test below asserts - so this test now fails if the walk ever mistakes the
		// referent for another link and runs to the depth limit instead.
		expect(fs.readlink).toHaveBeenCalledTimes(2)
	})

	it("refuses a two-link cycle instead of handing back the key the walk stopped at", async () => {
		const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
		vi.mocked(fs.realpath).mockRejectedValue(enoent)
		vi.mocked(fs.lstat).mockResolvedValue(_fileStats(true))
		// Every readlink answers with another link, so an unbounded walk would never end and the
		// bound is what stops it. What the bound must not do is hand back the spelling it stopped at
		// as if it were the answer: that key comes from the caller's own path after the filesystem
		// stopped answering about it, which is the divergence a lock key exists to remove.
		vi.mocked(fs.readlink).mockImplementation(async () => "a.json")

		const failure = await resolveLockKey("/tmp/linkdir/a.json").then(
			() => undefined,
			(error: unknown) => error as Error,
		)
		expect(failure).toBeInstanceOf(LockKeyWalkIncompleteError)
		if (!(failure instanceof LockKeyWalkIncompleteError)) {
			throw new Error("the cycle must reject with LockKeyWalkIncompleteError, not " + String(failure))
		}
		// The bound and the spelling the walk stopped at travel with the refusal, so a caller can
		// report which chain gave up without re-walking it.
		expect(failure.bound).toBe(8)
		expect(failure.absoluteFilePath).toBe("/tmp/linkdir/a.json")
		expect(failure.lastKey).toBe(path.resolve(path.join("/tmp/linkdir", "a.json")))
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

	it("accepts a staging file spelled through an alias of the target's directory", async () => {
		const aliasTarget = "/srv/alias/target.txt"
		// An alias root: canonicalDirKey canonicalizes through realpath, so the write resolves to
		// the referent while the caller still holds the alias spelling of the same directory.
		vi.mocked(fs.realpath).mockResolvedValue("/srv/referent/target.txt")
		vi.mocked(fsSync.openSync).mockReturnValue(1)
		const directoryStats = _fileStatsWithIdentity(1234n, 9n)
		vi.mocked(fs.stat).mockResolvedValue(directoryStats)

		await safeWriteText(aliasTarget, "data", { tempPath: "/srv/alias/x.tmp", platform: "linux" })

		// The staging file was published, not refused: containment is about which directory it
		// sits in, and these two spellings name one directory.
		expect(fs.rename).toHaveBeenCalledWith("/srv/alias/x.tmp", "/srv/referent/target.txt")
		// Both directories are read by identity, bigint for the same reason as the file stats.
		const directoryLookups = vi.mocked(fs.stat).mock.calls.filter((c) => c[1] !== undefined)
		expect(directoryLookups.length).toBe(2)
		for (const c of directoryLookups) {
			expect(c[1]).toEqual({ bigint: true })
		}
	})

	it("rejects when a staging directory stat fails for a reason other than it being absent", async () => {
		const targetPath = "/tmp/test-dir/target.txt"
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
		// The spelling comparison is the fallback for a directory that is not there. An EACCES says
		// nothing about containment, so it is reported instead of being read as a match or a
		// mismatch: a guard that decides from an error it could not interpret has stopped guarding.
		vi.mocked(fs.stat).mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }))

		await expect(
			safeWriteText(targetPath, "data", { tempPath: "/tmp/other-dir/x.tmp", platform: "linux" }),
		).rejects.toThrow(/could not be compared/)
		expect(fsSync.openSync).not.toHaveBeenCalled()
		expect(fs.rename).not.toHaveBeenCalled()
	})
	it("creates no directory when a supplied staging path is rejected", async () => {
		const targetPath = "/tmp/test-dir/nested-dir/target.txt"
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)

		// A rejected write has to leave the filesystem as it found it. mkdir -p ran ahead of
		// these checks, so a caller could create directories in the target's tree - and learn
		// about them only from a StagingPathError that never mentioned them.
		await expect(
			safeWriteText(targetPath, "data", { tempPath: "/tmp/other-dir/x.tmp", platform: "linux" }),
		).rejects.toThrow(StagingPathError)

		expect(fs.mkdir).not.toHaveBeenCalled()
		expect(fs.access).not.toHaveBeenCalled()
		expect(fsSync.mkdirSync).not.toHaveBeenCalled()
		expect(fsSync.openSync).not.toHaveBeenCalled()
		expect(fs.rename).not.toHaveBeenCalled()
	})

	it("still creates the parent directory for a staging path it accepts", async () => {
		const targetPath = "/tmp/test-dir/nested-dir/target.txt"
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
		vi.mocked(fsSync.openSync).mockReturnValue(1)

		await safeWriteText(targetPath, "data", { tempPath: "/tmp/test-dir/nested-dir/x.tmp", platform: "linux" })

		expect(fs.mkdir).toHaveBeenCalledWith(path.dirname(targetPath), { recursive: true })
		expect(fs.rename).toHaveBeenCalledWith("/tmp/test-dir/nested-dir/x.tmp", targetPath)
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
describe("caller-staged file protected through publication", () => {
	beforeEach(() => mockDefaults())

	// After validation the guard reads the staging path twice more: through the fd it just opened,
	// and immediately before the commit rename. Reporting a different identity at one of those
	// looks is how these rows say "the path was replaced after that check" - a real filesystem
	// offers no way to schedule a swap between two calls inside one function, and replacing the
	// whole call would not show which look the refusal came from.
	function _staged(
		customTempPath: string,
		targetPath: string,
		looks: { open?: fsSync.BigIntStats; commit?: fsSync.BigIntStats | Error },
	): void {
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
		vi.mocked(fsSync.openSync).mockReturnValue(5)
		const stagingIdentity = _fileStatsWithIdentity(8n, 3n)
		const targetIdentity = _fileStatsWithIdentity(11n, 3n)
		let stagingLooks = 0
		vi.mocked(fs.lstat).mockImplementation(async (p) => {
			const s = String(p)
			if (s.endsWith("target.txt")) {
				return targetIdentity
			}
			// The first look is the validation; the second is the one right before the rename. The
			// two arrive under different spellings (the resolved one and the caller's own), which is
			// why the match is on the basename and not on a path prefix.
			stagingLooks += 1
			if (stagingLooks === 1) {
				return stagingIdentity
			}
			const next = looks.commit
			if (next instanceof Error) {
				throw next
			}
			return next ?? stagingIdentity
		})
		vi.mocked(fsSync.fstatSync).mockReturnValue(looks.open ?? stagingIdentity)
	}

	it("refuses when the fd names a different file than the one validation checked", async () => {
		const targetPath = "/tmp/test-dir/target.txt"
		const customTempPath = "/tmp/test-dir/custom-temp.tmp"
		// Validation saw (8,3); the fd came back naming (9,3) - the path was swapped for a link or
		// another file in between. openSync on a link follows it, so the fchmod below would change
		// the permissions of a file this write never staged, and the rename would publish it.
		_staged(customTempPath, targetPath, { open: _fileStatsWithIdentity(9n, 3n) })
		vi.mocked(fsSync.statSync).mockReturnValue(_stats(0o600))

		await expect(
			safeWriteText(targetPath, "data", { tempPath: customTempPath, platform: "linux" }),
		).rejects.toThrow(/replaced between validation and open/)
		// The refusal came before fchmodSync, so no permission was changed on the substituted file.
		expect(fsSync.fchmodSync).not.toHaveBeenCalled()
		// Nothing was published.
		expect(fs.rename).not.toHaveBeenCalled()
		// The fd read asked for bigint stats: on NTFS/ReFS an identity can exceed
		// Number.MAX_SAFE_INTEGER and a rounded number makes two files look alike.
		const fdLooks = vi.mocked(fsSync.fstatSync).mock.calls
		expect(fdLooks).toHaveLength(1)
		expect(fdLooks[0]?.[1]).toEqual({ bigint: true })
	})

	it("accepts a staging file the open confirmed, and still publishes it", async () => {
		const targetPath = "/tmp/test-dir/target.txt"
		const customTempPath = "/tmp/test-dir/custom-temp.tmp"
		// The ordinary case: the same file at every look. A guard that refused this one would stop
		// every caller-staged write.
		_staged(customTempPath, targetPath, {})
		vi.mocked(fsSync.statSync).mockReturnValue(_stats(0o600))

		await safeWriteText(targetPath, "data", { tempPath: customTempPath, platform: "linux" })

		expect(fsSync.fchmodSync).toHaveBeenCalledWith(5, 0o600)
		expect(fs.rename).toHaveBeenCalledWith(customTempPath, targetPath)
		// Two bigint reads of the staging path: the validation and the one immediately before the
		// commit. The second is what this commit adds, so it is asserted as a call, not only as a
		// decision.
		const stagingLooks = vi
			.mocked(fs.lstat)
			.mock.calls.filter((c) => String(c[0]).endsWith("custom-temp.tmp") && c[1] !== undefined)
		expect(stagingLooks).toHaveLength(2)
		for (const c of stagingLooks) {
			expect(c[1]).toEqual({ bigint: true })
		}
	})

	it("refuses when the staging path was replaced after the file was opened", async () => {
		const targetPath = "/tmp/test-dir/target.txt"
		const customTempPath = "/tmp/test-dir/custom-temp.tmp"
		// The open confirmed (8,3); the look immediately before the rename reports (9,3). Without
		// that look the rename publishes whatever the path came to name, not the content staged
		// here.
		_staged(customTempPath, targetPath, { commit: _fileStatsWithIdentity(9n, 3n) })

		await expect(
			safeWriteText(targetPath, "data", { tempPath: customTempPath, platform: "linux" }),
		).rejects.toThrow(/replaced between validation and the commit/)
		expect(fs.rename).not.toHaveBeenCalled()
		// The failure handler still unlinks the path it was given. Whether that is the right
		// cleanup for a path someone else replaced is a separate question from publishing it, and
		// this commit does not change the answer.
		expect(fs.unlink).toHaveBeenCalledWith(customTempPath)
	})

	it("refuses when the pre-commit look fails with something other than the file being gone", async () => {
		const targetPath = "/tmp/test-dir/target.txt"
		const customTempPath = "/tmp/test-dir/custom-temp.tmp"
		_staged(customTempPath, targetPath, { commit: Object.assign(new Error("EACCES"), { code: "EACCES" }) })

		await expect(
			safeWriteText(targetPath, "data", { tempPath: customTempPath, platform: "linux" }),
		).rejects.toThrow(/could not be re-checked before the commit \(EACCES\)/)
		expect(fs.rename).not.toHaveBeenCalled()
	})

	it("refuses when the staging file is gone by the time the commit would run", async () => {
		const targetPath = "/tmp/test-dir/target.txt"
		const customTempPath = "/tmp/test-dir/custom-temp.tmp"
		// Missing is the one answer a stat can give that means "do not publish": there is nothing
		// at the path this write staged its content into. The spelling would be the fallback for a
		// directory comparison; here it would be a rename that cannot happen.
		_staged(customTempPath, targetPath, { commit: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) })

		await expect(
			safeWriteText(targetPath, "data", { tempPath: customTempPath, platform: "linux" }),
		).rejects.toThrow(/could not be re-checked before the commit \(ENOENT\)/)
		expect(fs.rename).not.toHaveBeenCalled()
	})
})
