import * as fs from "fs/promises"
import * as fsSync from "fs"
import { execFile } from "child_process"
import type { ChildProcess, ExecFileException } from "child_process"
import * as path from "path"

import { PostCommitDurabilityError, resolveLockKey, safeWriteText, StagingPathError } from "../safeWriteText"

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
	// readSync answers EOF by default: a row that does not stage backup bytes still
	// finishes the copy loop instead of spinning on an undefined read.
	readSync: vi.fn(() => 0),
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
	// The staging-directory comparison and canonicalDirKey both go through realpath.
	// Identity is the honest default - it says "no component of this path is a symlink",
	// which is what every row that does not stage an alias assumes. A row that models a
	// symlinked ancestor overrides it.
	vi.mocked(fs.realpath).mockImplementation(async (target) => String(target))
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
			// The staging-directory grant names the account it grants from the process
			// environment, so this row pins the account rather than inheriting whatever the host
			// happens to carry: with neither USERNAME nor USER, _grantPrivateDaclWindows takes its
			// skip path and one of the three icacls calls never happens, which is a state a runner
			// can reach and this row cannot.
			vi.stubEnv("USERNAME", "staging-acl-user")
			vi.stubEnv("USER", "")

			// options is undefined: the self-staged check and the optional-chained
			// DACL runner lookup must not dereference it
			await expect(safeWriteText(targetPath, "hello")).resolves.toBeUndefined()

			expect(fs.rmdir).toHaveBeenCalledTimes(1)
			expect(fs.rmdir).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"))
			if (process.platform === "win32") {
				// default platform is win32: the staging hardening grant, the target DACL save
				// and the post-commit restore all ran through the default icacls path
				// (options?.execFileRunner must not throw when options is undefined). Named by
				// argument rather than by a bare count, so a missing step reports which step.
				const icaclsCalls = vi.mocked(execFile).mock.calls.map(function (call) {
					return (call[1] ?? []).map(String)
				})
				const grants = icaclsCalls.filter(function (args) {
					return args.includes("/inheritance:r")
				})
				const saves = icaclsCalls.filter(function (args) {
					return args.includes("/save")
				})
				const restores = icaclsCalls.filter(function (args) {
					return args.includes("/restore")
				})
				expect(grants).toHaveLength(1)
				expect(saves).toHaveLength(1)
				expect(restores).toHaveLength(1)
				expect(icaclsCalls).toHaveLength(3)
				expect(grants[0]?.[3]).toBe("staging-acl-user:(OI)(CI)F")
				expect(vi.mocked(fs.unlink)).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.acl"))
			}
			vi.unstubAllEnvs()
		})
		it.skipIf(process.platform !== "win32")(
			"skips the staging-directory grant and reports the leftover exposure when no account name resolves",
			async () => {
				const targetPath = "/tmp/test-dir/target.txt"
				const warnings: string[] = []
				vi.mocked(fs.realpath).mockResolvedValue(targetPath)
				vi.mocked(fsSync.openSync).mockReturnValue(1)
				// Both account sources cleared: the state a host reaches when its environment
				// carries neither USERNAME nor USER. The grant never runs, so the two calls left
				// are the target DACL save and the post-commit restore, named by argument.
				vi.stubEnv("USERNAME", "")
				vi.stubEnv("USER", "")

				await expect(
					safeWriteText(targetPath, "hello", {
						platform: "win32",
						onWarning: (message: string) => warnings.push(message),
					}),
				).resolves.toBeUndefined()

				const icaclsCalls = vi.mocked(execFile).mock.calls.map(function (call) {
					return (call[1] ?? []).map(String)
				})
				expect(icaclsCalls).toHaveLength(2)
				expect(
					icaclsCalls.filter(function (args) {
						return args.includes("/inheritance:r")
					}),
				).toEqual([])
				expect(
					icaclsCalls.filter(function (args) {
						return args.includes("/save")
					}),
				).toHaveLength(1)
				expect(
					icaclsCalls.filter(function (args) {
						return args.includes("/restore")
					}),
				).toHaveLength(1)
				expect(
					warnings.some(function (message) {
						return message.includes("may be readable by other accounts")
					}),
				).toBe(true)
				vi.unstubAllEnvs()
			},
		)

		it("does not remove the staging directory when the caller supplies its own tempPath", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			const callerTemp = "/tmp/test-dir/caller-staged.txt"
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
			// The copy went through descriptors this code opened: the destination seeded
			// private, the target opened read-only as the source, then the copy reopened for
			// its flush - and never through fs.copyFile, which takes its destination mode
			// from the source.
			const backupOpens = vi.mocked(fsSync.openSync).mock.calls.filter(function (call) {
				return String(call[0]).includes("safeWriteText.bak_")
			})
			expect(
				backupOpens.map(function (call) {
					return call[1]
				}),
			).toEqual(["wx", "r+"])
			expect(fsSync.openSync).toHaveBeenCalledWith(targetPath, "r")
			expect(fs.copyFile).not.toHaveBeenCalled()
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
			// The reported path is exactly the copy that was made - the private descriptor
			// this code opened and filled - so a caller can open it.
			const seededBackups = vi
				.mocked(fsSync.openSync)
				.mock.calls.filter(function (call) {
					return String(call[0]).includes("safeWriteText.bak_") && call[1] === "wx"
				})
				.map(function (call) {
					return String(call[0])
				})
			expect(seededBackups).toContain(retained)
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
			// It is copied into a descriptor this code opened privately and read out of the
			// target, so the copy never carries the target's own permissions.
			expect(fsSync.openSync).toHaveBeenCalledWith(targetPath, "r")
			expect(fsSync.openSync).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.bak_"), "wx", 0o600)
			expect(fs.copyFile).not.toHaveBeenCalled()
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
			// pre-write content is still what a reader sees at targetPath - it was only ever
			// read, through the descriptor the backup copy filled.
			expect(fs.rename).toHaveBeenCalledTimes(1)
			expect(fsSync.openSync).toHaveBeenCalledWith(targetPath, "r")
			expect(fsSync.openSync).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.bak_"), "wx", 0o600)
			expect(fs.copyFile).not.toHaveBeenCalled()

			// Both the backup copy and the staging temp are cleaned up on failure.
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.bak_"))
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"))
		})

		it("creates the backup privately before its content exists, then fsyncs it", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			// Distinct descriptors: 7 is this write's backup copy, 9 is the target it is
			// copied from, so each assertion can say which file the call touched.
			vi.mocked(fsSync.openSync).mockImplementation((p: unknown) =>
				String(p).includes("safeWriteText.bak_") ? 7 : 9,
			)
			// One 6-byte chunk, then EOF: the copy must drain the source and hand every byte
			// to the descriptor it opened.
			vi.mocked(fsSync.readSync).mockReturnValueOnce(6).mockReturnValue(0)

			await safeWriteText(targetPath, "new data", { backup: true })

			// The destination must exist with the private mode fixed at open time BEFORE any
			// byte of the copy exists at it. "wx" also means a pre-existing path is never
			// silently reused.
			const seedOpen = vi.mocked(fsSync.openSync).mock.calls.find(function (call) {
				return String(call[0]).includes("safeWriteText.bak_") && call[1] === "wx"
			})
			expect(seedOpen).toBeDefined()
			expect(seedOpen?.[2]).toBe(0o600)
			const seedOrder = vi.mocked(fsSync.openSync).mock.invocationCallOrder[
				vi.mocked(fsSync.openSync).mock.calls.indexOf(seedOpen!)
			]
			expect(seedOrder).toBeLessThan(vi.mocked(fsSync.readSync).mock.invocationCallOrder[0])

			// Every byte went into the descriptor opened above, read out of the target.
			expect(fsSync.readSync).toHaveBeenCalledWith(9, expect.any(Buffer), 0, expect.any(Number), 0)
			expect(fsSync.writeSync).toHaveBeenCalledWith(7, expect.any(Buffer), 0, 6)

			// fs.copyFile picks its own destination mode and, on POSIX, re-applies the source's
			// mode to the file it writes, so a copy through it would widen this private seed to
			// the target's permissions for the whole copy window. Nothing has to be chmodded
			// afterwards, because the mode this code chose never moved.
			expect(fs.copyFile).not.toHaveBeenCalled()
			expect(fs.chmod).not.toHaveBeenCalled()

			// The copy is then reopened for fsync with the writable flag, on the private mode
			// it has held since the first byte.
			const backupOpen = vi.mocked(fsSync.openSync).mock.calls.find(function (call) {
				return String(call[0]).includes("safeWriteText.bak_") && call[1] === "r+"
			})
			expect(backupOpen).toBeDefined()
			expect(fsSync.fsyncSync).toHaveBeenCalledWith(7)
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
			vi.mocked(fsSync.readSync).mockImplementation(() => {
				throw Object.assign(new Error("EIO"), { code: "EIO" })
			})

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
		it("keeps a multi-chunk backup complete when the destination write comes up short", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			// More than one 64 KiB chunk of distinct bytes, so a wrong source position or a
			// wrong destination offset lands bytes that differ from the right ones. The period
			// 251 does not divide the chunk size, which is what makes an offset error visible.
			const source = Buffer.alloc(70 * 1024)
			for (let i = 0; i < source.length; i++) {
				source[i] = i % 251
			}
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fs.copyFile).mockResolvedValue(undefined)
			// The descriptor the copy writes into is the seeded backup (7); the target is read
			// through 9 and the staged temp through 1, so an assertion can name who got which
			// byte instead of trusting the call order alone.
			vi.mocked(fsSync.openSync).mockImplementation((...args: unknown[]) => {
				const openedPath = String(args[0])
				if (openedPath.includes("safeWriteText.bak_")) {
					return 7
				}
				if (openedPath === targetPath) {
					return 9
				}
				return 1
			})
			// readSync answers from the recorded source instead of the default immediate EOF,
			// so the production copy loop runs for two chunks rather than being short-circuited.
			vi.mocked(fsSync.readSync).mockImplementation((...args: unknown[]) => {
				const buffer = args[1]
				if (!Buffer.isBuffer(buffer)) {
					return 0
				}
				const position = typeof args[4] === "number" ? args[4] : 0
				const offset = typeof args[2] === "number" ? args[2] : 0
				const length = typeof args[3] === "number" ? args[3] : 0
				const bytes = Math.min(length, Math.max(0, source.length - position))
				if (bytes === 0) {
					return 0
				}
				source.copy(buffer, offset, position, position + bytes)
				return bytes
			})
			const copiedChunks: Buffer[] = []
			let shortWriteLeft = 1
			// The seeded backup descriptor reports one short write, 40000 of the 65536 bytes
			// asked for, and every other call reports the full request.
			vi.mocked(fsSync.writeSync).mockImplementation((...args: unknown[]) => {
				const fd = args[0]
				const buffer = args[1]
				const offset = typeof args[2] === "number" ? args[2] : 0
				const length = typeof args[3] === "number" ? args[3] : 0
				if (!Buffer.isBuffer(buffer) || fd !== 7) {
					return length
				}
				const granted = shortWriteLeft > 0 && length > 40000 ? 40000 : length
				if (granted < length) {
					shortWriteLeft = 0
				}
				copiedChunks.push(Buffer.from(buffer.subarray(offset, offset + granted)))
				return granted
			})

			await expect(safeWriteText(targetPath, "new content", { backup: true })).resolves.toBeUndefined()

			const seedOpen = vi.mocked(fsSync.openSync).mock.calls.find(function (call) {
				return String(call[0]).includes("safeWriteText.bak_") && call[1] === "wx"
			})
			expect(seedOpen?.[2]).toBe(0o600)
			// The first chunk went in at offset 0 and the short write forced a second call at
			// the offset the destination actually reached, with only the remainder asked for.
			expect(fsSync.writeSync).toHaveBeenCalledWith(7, expect.any(Buffer), 0, 65536)
			expect(fsSync.writeSync).toHaveBeenCalledWith(7, expect.any(Buffer), 40000, 65536 - 40000)
			// The tail chunk landed in one call at offset 0 of a fresh buffer.
			expect(fsSync.writeSync).toHaveBeenCalledWith(7, expect.any(Buffer), 0, 70 * 1024 - 65536)
			const copied = Buffer.concat(copiedChunks)
			expect(copied.length).toBe(source.length)
			expect(copied.equals(source)).toBe(true)
			expect(fsSync.closeSync).toHaveBeenCalledWith(7)
			expect(fsSync.closeSync).toHaveBeenCalledWith(9)
			// The loop under test is this code's own, not fs.copyFile's.
			expect(fs.copyFile).not.toHaveBeenCalled()
		})
	})

	// ── Test 5: win32 DACL path ──────────────────────────────────────────────

	describe("win32 DACL", () => {
		beforeEach(() => {
			// The staging-directory hardening grants the private DACL to the account named in
			// the process environment. Pin it so these rows ask for the same grant on a runner
			// that reaches the win32 branch through the platform override as on a Windows host.
			vi.stubEnv("USERNAME", "staging-acl-user")
		})
		afterEach(() => {
			vi.unstubAllEnvs()
		})
		it.skipIf(process.platform !== "win32")(
			"copies target DACL onto staging file via icacls before rename on Windows",
			async () => {
				const targetPath = "/tmp/test-dir/target.txt"
				vi.mocked(fs.realpath).mockResolvedValue(targetPath)
				await safeWriteText(targetPath, "data", { platform: "win32" })

				// staging grant + DACL dump + DACL restore (execFile is the callback mock)
				expect(execFile).toHaveBeenCalledTimes(3)
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
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"), targetPath)
			// Only the save was attempted: a failed DACL apply must not try to restore. The
			// staging-directory grant is a separate call and is not part of this claim.
			const attempts = vi
				.mocked(execFile)
				.mock.calls.filter(function (call) {
					const args = (call[1] ?? []).map(String)
					return args.includes("/save") || args.includes("/restore")
				})
				.map(function (call) {
					return String((call[1] ?? [])[1])
				})
			expect(attempts).toEqual(["/save"])
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

			// No save and no restore: the target could not be checked, so there was no DACL to
			// carry over. (The staging-directory grant answers a different question.)
			const daclCalls = vi.mocked(execFile).mock.calls.filter(function (call) {
				const args = (call[1] ?? []).map(String)
				return args.includes("/save") || args.includes("/restore")
			})
			expect(daclCalls).toEqual([])
			expect(warnings.filter((m) => m.includes("Could not check"))).toHaveLength(1)
		})

		// Warning delivery is advisory: it must not be able to fail the save it is reporting on.
		it("win32: a throwing onWarning does not abort the write", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
				if (typeof cb === "function") cb(new Error("icacls error"), "", "")
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

			await safeWriteText(targetPath, "data", { platform: "win32" })

			// write committed; only the save was attempted (no restore from a failed dump)
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), targetPath)
			expect(fs.rename).toHaveBeenCalledTimes(1)
			const saveCalls = vi.mocked(execFile).mock.calls.filter(function (call) {
				return (call[1] ?? []).map(String).includes("/save")
			})
			const restoreCalls = vi.mocked(execFile).mock.calls.filter(function (call) {
				return (call[1] ?? []).map(String).includes("/restore")
			})
			expect(saveCalls).toHaveLength(1)
			// Nothing is restored from a dump whose save failed.
			expect(restoreCalls).toEqual([])
			// the dump path (possibly partially created by icacls) was unlinked
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.acl"))
		})

		it("win32 DACL save args are [targetPath, /save, dumpPath, /T] before backup rename", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			await safeWriteText(targetPath, "data", { backup: true, platform: "win32" })

			// three icacls runs: the staging-directory grant, then the save, then the restore
			expect(execFile).toHaveBeenCalledTimes(3)

			// The save: DACL taken from the target before the backup copy
			const firstCall = vi.mocked(execFile).mock.calls.find(function (call) {
				return (call[1] ?? []).map(String).includes("/save")
			})!
			expect(firstCall[0]).toBe("icacls")
			expect(firstCall[1]).toEqual([targetPath, "/save", expect.stringContaining("safeWriteText.acl"), "/T"])

			// The restore: DACL put back onto the directory after the commit rename
			const secondCall = vi.mocked(execFile).mock.calls.find(function (call) {
				return (call[1] ?? []).map(String).includes("/restore")
			})!
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

			const execOrders = vi.mocked(execFile).mock.invocationCallOrder
			const orderOfDacl = function (operation: string): number {
				return execOrders[
					vi.mocked(execFile).mock.calls.findIndex(function (call) {
						return (call[1] ?? []).map(String).includes(operation)
					})
				]
			}
			const saveCall = orderOfDacl("/save")
			const restoreCall = orderOfDacl("/restore")
			// The backup copy is the private descriptor this code opened and filled.
			const backupOpens = vi.mocked(fsSync.openSync).mock.calls
			const backupCopy = vi.mocked(fsSync.openSync).mock.invocationCallOrder[
				backupOpens.findIndex(function (call) {
					return String(call[0]).includes("safeWriteText.bak_") && call[1] === "wx"
				})
			]
			const commitRename = vi.mocked(fs.rename).mock.invocationCallOrder[0]

			expect(saveCall).toBeLessThan(backupCopy)
			expect(backupCopy).toBeLessThan(commitRename)
			expect(commitRename).toBeLessThan(restoreCall)
		})

		it("win32 DACL: a failed restore is reported and the dump is still unlinked", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			// Every icacls succeeds except the restore.
			vi.mocked(execFile).mockImplementation((_cmd, args, _opts, cb) => {
				const restoring = Array.isArray(args) && args.map(String).includes("/restore")
				if (typeof cb === "function") {
					cb(restoring ? new Error("icacls restore error") : null, "", "")
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

			// no save, no restore, no dump: the target was absent, so there was no DACL to
			// carry over. The staging-directory grant answers a different question.
			const daclCalls = vi.mocked(execFile).mock.calls.filter(function (call) {
				const args = (call[1] ?? []).map(String)
				return args.includes("/save") || args.includes("/restore")
			})
			expect(daclCalls).toEqual([])

			// no dump file created or unlinked
			expect(fs.unlink).not.toHaveBeenCalled()
		})

		it("win32: holds the staging write until the staging-directory grant has returned", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// Held as an array entry rather than a bare function value, because expect() on a
			// function value in this suite only offers call matchers.
			const held: Array<(error: ExecFileException | null, stdout: string, stderr: string) => void> = []
			vi.mocked(execFile).mockImplementation((_cmd, args, _opts, cb) => {
				// Only the grant is held, so this row is about the privacy barrier rather than
				// about icacls in general: the dump and the restore complete as soon as asked.
				if ((args ?? []).map(String).includes("/inheritance:r")) {
					if (typeof cb === "function") {
						held.push(cb)
					}
					return fakeChild
				}
				if (typeof cb === "function") cb(null, "", "")
				return fakeChild
			})

			const write = safeWriteText(targetPath, "data", { platform: "win32" })
			await new Promise((resolve) => setTimeout(resolve, 0))

			// The grant is the only icacls call attempted and no descriptor has been opened
			// for staged bytes yet: the hardening is awaited, not merely ordered before them.
			expect(vi.mocked(execFile).mock.calls).toHaveLength(1)
			expect(vi.mocked(fsSync.openSync).mock.calls).toHaveLength(0)
			expect(held.length).toBe(1)

			held[0]?.(null, "", "")
			await expect(write).resolves.toBeUndefined()

			expect(vi.mocked(fs.rename)).toHaveBeenCalledTimes(1)
			const calls = vi.mocked(execFile).mock.calls.map(function (call) {
				return (call[1] ?? []).map(String)
			})
			expect(
				calls.filter(function (args) {
					return args.includes("/save")
				}),
			).toHaveLength(1)
			expect(
				calls.filter(function (args) {
					return args.includes("/restore")
				}),
			).toHaveLength(1)
			const grantOrder =
				vi.mocked(execFile).mock.invocationCallOrder[
					calls.findIndex(function (args) {
						return args.includes("/inheritance:r")
					})
				]
			const firstOpenOrder = vi.mocked(fsSync.openSync).mock.invocationCallOrder[0]
			expect(grantOrder).toBeLessThan(firstOpenOrder!)
		})

		it("win32: strips inherited ACEs from the staging directory before staging content", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
				if (typeof cb === "function") cb(null, "", "")
				return fakeChild
			})

			await safeWriteText(targetPath, "data", { platform: "win32" })

			// mkdirSync's mode is ignored by Windows directory creation and chmodSync does not
			// establish a DACL, so the privacy of the staged bytes has to come from an explicit
			// grant. This is the incantation a measured icacls run on a Windows host showed to
			// leave a single explicit ACE, which the files created inside then inherit.
			const grants = vi.mocked(execFile).mock.calls.filter(function (call) {
				return (call[1] ?? []).map(String).includes("/inheritance:r")
			})
			expect(grants).toHaveLength(1)
			const grantArgs = (grants[0]?.[1] ?? []).map(String)
			expect(grantArgs[0]).toContain(".file-safety-staging")
			expect(grantArgs[1]).toBe("/inheritance:r")
			expect(grantArgs[2]).toBe("/grant:r")
			expect(grantArgs[3]).toBe("staging-acl-user:(OI)(CI)F")

			// Order is the finding: the grant has to precede the first open of the staging
			// file, or the content sits in the inherited directory readable to whoever the
			// parent admitted until the step-5 restore.
			expect(vi.mocked(execFile).mock.invocationCallOrder[0]).toBeLessThan(
				vi.mocked(fsSync.openSync).mock.invocationCallOrder[0],
			)
		})

		it("win32: a staging directory that cannot be made private is reported and the write still saves", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
				if (typeof cb === "function") cb(new Error("icacls unavailable"), "", "")
				return fakeChild
			})
			const warnings: string[] = []

			// A host where icacls is missing or refuses the grant must not lose the ability to
			// save: the write proceeds and the leftover exposure is reported.
			await expect(
				safeWriteText(targetPath, "data", { platform: "win32", onWarning: (m) => warnings.push(m) }),
			).resolves.toBeUndefined()
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"), targetPath)
			expect(warnings.filter((m) => m.includes("readable by other accounts"))).toHaveLength(1)
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

		it("fsyncs the entry naming each parent directory it created, deepest first", async () => {
			// path.resolve keeps the mock's spellings and the SUT's identical: on Windows the
			// SUT prefixes a drive letter where a bare path.join does not.
			const createdFrom = path.resolve("/tmp/test-dir", "a")
			const dirPath = path.join(createdFrom, "b")
			const targetPath = path.join(dirPath, "target.txt")
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// fs.mkdir reports the shallowest directory it had to create: here that is "a", so
			// both "a" and "b" are new entries living inside directories that were there.
			vi.mocked(fs.mkdir).mockResolvedValue(createdFrom)

			await safeWriteText(targetPath, "data", { platform: "linux" })

			const syncedDirs = vi
				.mocked(fsSync.openSync)
				.mock.calls.filter(function (call) {
					return call[1] === "r"
				})
				.map(function (call) {
					return String(call[0])
				})
			// The directory the commit rename changed an entry in, then each containing
			// directory up to the nearest one that already existed. Synchronizing a created
			// directory's own inode does not synchronize the entry that names it.
			expect(syncedDirs).toEqual([dirPath, createdFrom, path.dirname(createdFrom)])
			expect(fsSync.fsyncSync).toHaveBeenCalledTimes(syncedDirs.length + 1)
		})

		it("does not walk ancestor directories when mkdir had nothing to create", async () => {
			const dirPath = path.resolve("/tmp/test-dir", "deep")
			const targetPath = path.join(dirPath, "target.txt")
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// An undefined return says every component already existed, so no ancestor entry
			// changed and there is nothing beyond the commit rename's own directory to sync.
			vi.mocked(fs.mkdir).mockResolvedValue(undefined)

			await safeWriteText(targetPath, "data", { platform: "linux" })

			const dirOpens = vi.mocked(fsSync.openSync).mock.calls.filter(function (call) {
				return call[1] === "r"
			})
			expect(
				dirOpens.map(function (call) {
					return String(call[0])
				}),
			).toEqual([dirPath])
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
		// The bound is MAX_SYMLINK_HOPS - 40 links, the longest chain Node resolves at all -
		// so a cycle terminates at the bound and a chain the operating system could follow is
		// never cut off short of its referent.
		expect(fs.readlink).toHaveBeenCalledTimes(40)
	})
})

describe("caller-supplied staging path", () => {
	beforeEach(() => {
		mockDefaults()
		// The location check compares canonical directories. A stub that answers every path
		// with the target spells both sides from the same string and cannot tell an outside
		// directory from the target's own, so these rows resolve identity: no component is a
		// link, which is what each of them assumes unless it says otherwise.
		vi.mocked(fs.realpath).mockImplementation(async (target) => String(target))
	})

	it("rejects a staging file outside the target's directory before writing anything", async () => {
		const targetPath = "/tmp/test-dir/target.txt"

		// A rename across filesystems fails with EXDEV, and a path elsewhere lets
		// a caller publish an unrelated file onto the target.
		await expect(
			safeWriteText(targetPath, "data", { tempPath: "/tmp/other-dir/x.tmp", platform: "linux" }),
		).rejects.toThrow(StagingPathError)
		expect(fsSync.openSync).not.toHaveBeenCalled()
		expect(fs.rename).not.toHaveBeenCalled()
	})

	it("accepts a staging file whose directory is an alias of the target's directory", async () => {
		vi.mocked(fsSync.openSync).mockReturnValue(1)
		// Both spellings reach one directory through a symlinked ancestor: realpath resolves
		// each alias to the canonical directory, and that is the only comparison that says
		// whether the commit rename would cross a filesystem.
		vi.mocked(fs.realpath).mockImplementation(async (p: unknown) =>
			String(p).includes("alias-dir") ? String(p).replace("alias-dir", "canonical-dir") : String(p),
		)

		await safeWriteText(path.join("/tmp/alias-dir", "target.txt"), "data", {
			tempPath: path.join("/tmp/alias-dir", "caller-staged.txt"),
			platform: "linux",
		})

		expect(fs.rename).toHaveBeenCalledWith(
			expect.stringContaining("caller-staged.txt"),
			expect.stringContaining(path.join("canonical-dir", "target.txt")),
		)
		expect(fsSync.openSync).toHaveBeenCalledWith(expect.stringContaining("caller-staged.txt"), "r+")
	})

	it("rejects a staging path that is a symlink", async () => {
		const targetPath = "/tmp/test-dir/target.txt"
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
		// A hard-linked staging file shares the target's inode, so the identity comparison is the only thing
		// between this write and a rename onto the very file the guard protects. An EACCES from the target
		// lstat must not be mistaken for "there is no target".
		const stagingStats = _fileStatsWithIdentity(42n, 7n)
		// The guard reads the target under its resolved spelling, which on Windows carries a
		// drive letter the literal here does not.
		const resolvedTarget = path.resolve(targetPath)
		vi.mocked(fs.lstat).mockImplementation(async (p) => {
			if (String(p) === targetPath || String(p) === resolvedTarget) {
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

// ── Lock key with a missing parent: one file, one lock ──────────────────────

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
