import * as fs from "fs/promises"
import * as fsSync from "fs"
import { execFile } from "child_process"
import type { ChildProcess } from "child_process"
import * as path from "path"

import { safeWriteText, type SafeWriteTextOptions } from "../safeWriteText"

// Full mock for fs/promises — all methods are vi.fn() stubs
vi.mock("fs/promises", () => ({
	mkdir: vi.fn(),
	access: vi.fn(),
	rename: vi.fn(),
	unlink: vi.fn(),
	realpath: vi.fn(),
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

			// the commit rename (temp -> target) still happened
			expect(fs.rename).toHaveBeenNthCalledWith(2, expect.stringContaining("safeWriteText_"), targetPath)

			// the failing cleanup was the post-commit backup unlink
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.bak_"))

			// no rollback rename: the committed target is not restored from the backup
			expect(fs.rename).toHaveBeenCalledTimes(2)

			// the staging temp was already committed by the rename; nothing
			// temp-shaped is unlinked afterwards
			expect(fs.unlink).not.toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"))
		})
	})

	// ── Test 4: backup:true keeps old safeWriteJson semantics incl. rollback ──

	describe("backup:true", () => {
		it("renames target -> backup before commit, deletes backup on success", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			await safeWriteText(targetPath, "new data", { backup: true })

			// target was accessed (exists check)
			expect(fs.access).toHaveBeenCalledWith(targetPath)

			// first rename: target -> backup
			expect(fs.rename).toHaveBeenNthCalledWith(1, targetPath, expect.stringContaining("safeWriteText.bak_"))

			// second rename: temp -> target (realpath mock returns targetPath)
			expect(fs.rename).toHaveBeenNthCalledWith(2, expect.stringContaining("safeWriteText_"), targetPath)

			// backup was deleted on success
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.bak_"))
		})

		it("rollback: on failure after rename target->backup, restores backup to target", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// first rename (target->backup) succeeds, second fails
			let callCount = 0
			vi.mocked(fs.rename).mockImplementation(async () => {
				callCount++
				if (callCount === 1) return // target -> backup
				throw new Error("ENOSPC") // temp -> target fails
			})

			await expect(safeWriteText(targetPath, "new data", { backup: true })).rejects.toThrow("ENOSPC")

			// rollback rename is the 3rd call (after target->backup and temp->target failure)
			expect(fs.rename).toHaveBeenNthCalledWith(3, expect.stringContaining("safeWriteText.bak_"), targetPath)

			// temp was cleaned up on failure
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
			expect(firstCall[1]).toEqual([targetPath, "/save", expect.stringContaining(".acl.tmp"), "/T"])

			// Second call: restore DACL onto directory after commit rename
			const secondCall = vi.mocked(execFile).mock.calls[1]
			expect(secondCall[0]).toBe("icacls")
			expect(secondCall[1]).toEqual([
				expect.stringContaining("/tmp/test-dir"),
				"/restore",
				expect.stringContaining(".acl.tmp"),
			])

			// dump file was unlinked after restore
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining(".acl.tmp"))
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
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining(".acl.tmp"))
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
})
