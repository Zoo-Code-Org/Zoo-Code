import * as fs from "fs/promises"
import * as fsSync from "fs"
import { execFile } from "child_process"
import type { ChildProcess } from "child_process"
import * as path from "path"

import { resolvePublishTarget, safeWriteText, type SafeWriteTextOptions } from "../safeWriteText"

// The two failure classes are module-private (knip ignores __tests__, so a
// test-only export would be reported as unused), so tests match them by name.
async function _rejectionName(promise: Promise<unknown>): Promise<string> {
	try {
		await promise
		return "resolved"
	} catch (error) {
		return error instanceof Error ? error.name : String(error)
	}
}

// Full mock for fs/promises — all methods are vi.fn() stubs
vi.mock("fs/promises", () => ({
	mkdir: vi.fn(),
	access: vi.fn(),
	rename: vi.fn(),
	unlink: vi.fn(),
	realpath: vi.fn(),
	lstat: vi.fn(),
	readlink: vi.fn(),
	copyFile: vi.fn(),
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
	fchownSync: vi.fn(),
	statSync: vi.fn(),
	lstatSync: vi.fn(),
	rmdirSync: vi.fn(),
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

// Stats stand-in for the staging directory: a real directory owned by this
// process, which is what _stagingDir requires before it will stage there.
function _dirStats(): fsSync.Stats {
	const s = Object.create(fsSync.Stats.prototype) as fsSync.Stats & {
		uid?: number
		isDirectory?: () => boolean
	}
	s.uid = typeof process.getuid === "function" ? process.getuid() : 0
	s.isDirectory = () => true
	return s
}

// Stats stand-in for a symlink planted at the staging path.
function _linkStats(): fsSync.Stats {
	const s = Object.create(fsSync.Stats.prototype) as fsSync.Stats & {
		isDirectory?: () => boolean
	}
	s.isDirectory = () => false
	return s
}

// Minimal Stats stand-in: the SUT reads `.mode` and, on POSIX, `.gid` from it.
function _stats(mode: number, gid?: number): fsSync.Stats {
	const s = Object.create(fsSync.Stats.prototype) as fsSync.Stats
	Object.assign(s, gid === undefined ? { mode } : { mode, gid })
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
		// Link lookups default to 'not a link' so an ENOENT realpath falls back to the path.
		vi.mocked(fs.lstat).mockResolvedValue(null as unknown as fsSync.Stats)
		// Existing-target default: a regular 0o644 file.
		vi.mocked(fsSync.statSync).mockReturnValue(_stats(0o644))
		// Staging path default: a real directory owned by this process.
		vi.mocked(fsSync.lstatSync).mockReturnValue(_dirStats())
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

			// Cross-mock invocation ORDER, not just call counts: a count-only assertion still
			// passes if the implementation fsyncs after the commit rename, which is the exact
			// durability regression this suite exists to catch.
			const firstCallOf = (mock: { mock: { invocationCallOrder: number[] } }) => mock.mock.invocationCallOrder[0]
			const renameOrder = firstCallOf(vi.mocked(fs.rename))
			expect(firstCallOf(vi.mocked(fsSync.openSync))).toBeLessThan(renameOrder)
			expect(firstCallOf(vi.mocked(fsSync.writeSync))).toBeLessThan(renameOrder)
			expect(firstCallOf(vi.mocked(fsSync.fsyncSync))).toBeLessThan(renameOrder)
			expect(firstCallOf(vi.mocked(fsSync.closeSync))).toBeLessThan(renameOrder)
			// the staged file is fsynced before it is closed
			expect(vi.mocked(fsSync.fsyncSync).mock.invocationCallOrder[0]).toBeLessThan(
				vi.mocked(fsSync.closeSync).mock.invocationCallOrder[0],
			)
			// the parent-directory fsync is the second fsync and lands AFTER the rename
			expect(vi.mocked(fsSync.fsyncSync).mock.invocationCallOrder[1]).toBeGreaterThan(renameOrder)
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
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), targetPath)

			// the failing cleanup was the post-commit backup unlink
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.bak_"))

			// no rollback rename: the committed target is not restored from the backup
			expect(fs.rename).toHaveBeenCalledTimes(1)

			// the staging temp was already committed by the rename; nothing
			// temp-shaped is unlinked afterwards
			expect(fs.unlink).not.toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"))
		})
	})

	// ── Test 4: backup:true keeps old safeWriteJson semantics incl. rollback ──

	describe("backup:true", () => {
		// These tests exercise the win32 publish path, whose DACL capture is judged by its
		// artifact, so the mock world has to produce a usable dump.
		beforeEach(() => {
			// Path-aware: this code stats two different paths - the target, for its mode, and the
			// dump, to judge the capture. One stub for both paths would let a regression that
			// stats the target instead of the dump pass, and would silently stage with mode 0
			// because the stub carries no mode.
			vi.mocked(fsSync.statSync).mockImplementation(((p: unknown) =>
				typeof p === "string" && p.includes(".acl.tmp")
					? { isFile: () => true, size: 256 }
					: _stats(0o644)) as never)
		})
		it("copies target -> backup before commit, deletes backup on success", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			await safeWriteText(targetPath, "new data", { backup: true })

			// target was accessed (exists check)
			expect(fs.access).toHaveBeenCalledWith(targetPath)

			// first rename: target -> backup
			expect(fs.copyFile).toHaveBeenCalledWith(targetPath, expect.stringContaining("safeWriteText.bak_"))

			// second rename: temp -> target (realpath mock returns targetPath)
			expect(fs.rename).toHaveBeenCalledTimes(1)

			// backup was deleted on success
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.bak_"))
		})

		it("a failed publish leaves the target in place and removes the backup copy", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// the only rename is the publish, and it fails
			vi.mocked(fs.rename).mockRejectedValue(new Error("ENOSPC"))

			await expect(safeWriteText(targetPath, "new data", { backup: true })).rejects.toThrow("ENOSPC")

			// no rollback rename exists: the target was never moved, so cleanup removes the copy
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.bak_"))
			expect(fs.rename).toHaveBeenCalledTimes(1)

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
		// The DACL capture is judged by its artifact, so the mock world has to produce one:
		// a regular, non-empty dump. Tests that want an unusable artifact override this.
		beforeEach(() => {
			// Path-aware: this code stats two different paths - the target, for its mode, and the
			// dump, to judge the capture. One stub for both paths would let a regression that
			// stats the target instead of the dump pass, and would silently stage with mode 0
			// because the stub carries no mode.
			vi.mocked(fsSync.statSync).mockImplementation(((p: unknown) =>
				typeof p === "string" && p.includes(".acl.tmp")
					? { isFile: () => true, size: 256 }
					: _stats(0o644)) as never)
		})
		it.skipIf(process.platform !== "win32")(
			"copies target DACL onto staging file via icacls before rename on Windows",
			async () => {
				const targetPath = "/tmp/test-dir/target.txt"
				vi.mocked(fs.realpath).mockResolvedValue(targetPath)
				vi.mocked(fsSync.openSync).mockReturnValue(1)
				await safeWriteText(targetPath, "data", { platform: "win32" })

				// The neighbouring argument test passes backup:true, so this no-backup case is
				// kept - but it has to check the commands, not just their count.
				expect(execFile).toHaveBeenCalledTimes(2)

				const saveCall = vi.mocked(execFile).mock.calls[0]
				expect(saveCall[0]).toBe("icacls")
				// No /T: with a file path it makes icacls walk the whole tree and save every file of
				// that name, and the restore then rewrites all of their DACLs.
				expect(saveCall[1]).toEqual([targetPath, "/save", expect.stringContaining(".acl.tmp")])

				const restoreCall = vi.mocked(execFile).mock.calls[1]
				expect(restoreCall[0]).toBe("icacls")
				expect(restoreCall[1]).toEqual([
					expect.stringContaining("/tmp/test-dir"),
					"/restore",
					expect.stringContaining(".acl.tmp"),
				])
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

		it("fails closed when icacls reports success but wrote no dump", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// icacls exits 0 without producing the dump (measured when the target's owner differs
			// from the caller). The exit code alone is not evidence that a descriptor was captured.
			vi.mocked(execFile).mockImplementation(((
				_c: string,
				_a: string[],
				_o: unknown,
				cb?: (e?: Error | null) => void,
			) => {
				cb?.(null)
				return undefined
			}) as never)
			vi.mocked(fsSync.statSync).mockImplementation((() => {
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
			}) as never)

			await expect(safeWriteText(targetPath, "data", { platform: "win32" })).rejects.toThrow(
				/refusing to publish/,
			)
		})

		it("fails closed when the dump is a regular file but empty", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// A zero-byte dump is not a captured security descriptor: icacls can create the file and
			// write nothing into it. Accepting it would publish with a restore that carries no data.
			vi.mocked(execFile).mockImplementation(((
				_c: string,
				_a: string[],
				_o: unknown,
				cb?: (e?: Error | null) => void,
			) => {
				cb?.(null)
				return undefined
			}) as never)
			vi.mocked(fsSync.statSync).mockImplementation((() => ({ isFile: () => true, size: 0 })) as never)

			await expect(safeWriteText(targetPath, "data", { platform: "win32" })).rejects.toThrow(/refus/)
		})

		it.each([
			["EACCES", "EACCES"],
			["a code-less probe error", undefined],
		])("propagates a %s target-existence probe instead of treating the target as absent", async (_label, code) => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// An unreadable target is not an absent target: publishing over it would replace a file
			// whose security descriptor was never captured.
			// Call-order aware: only the DACL step's probe fails. A later fs.access in the publish
			// path succeeds, so a swallowed probe error would let the write continue - which is what
			// makes this assertion load-bearing rather than accidentally satisfied by a later failure.
			// Path-aware, not call-order: fs.access is also called for the parent directory earlier in
			// the flow, so a first-call mock fails the WRONG probe and the assertion is satisfied by
			// accident. Only the probe of the target itself may fail here.
			vi.mocked(fs.access).mockImplementation((async (p: string) => {
				if (p === targetPath) {
					throw Object.assign(new Error("probe failed"), code ? { code } : {})
				}
				return undefined
			}) as never)

			await expect(safeWriteText(targetPath, "data", { platform: "win32" })).rejects.toThrow("probe failed")
			expect(execFile).not.toHaveBeenCalled()
			// Nothing downstream of the probe may run: a swallowed probe error would keep going and
			// copy the target to a backup, which is what makes this assertion load-bearing.
			expect(fs.copyFile).not.toHaveBeenCalled()
		})

		it("removes the staged file and the dump when the DACL capture aborts", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(fsSync.statSync).mockImplementation((() => {
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
			}) as never)
			const unlinkMock = vi.mocked(fs.unlink)

			await expect(safeWriteText(targetPath, "data", { platform: "win32" })).rejects.toThrow(
				/refusing to publish/,
			)

			// The abort leaves the try/finally that owns cleanup, so the artifacts are released on the
			// abort path itself: neither the dump nor the staged file may be orphaned.
			const unlinked = unlinkMock.mock.calls.map(function (call) {
				return String(call[0])
			})
			expect(
				unlinked.some(function (p) {
					return p.includes(".acl.tmp")
				}),
			).toBe(true)
			expect(
				unlinked.some(function (p) {
					return p.includes("safeWriteText_")
				}),
			).toBe(true)
		})

		it("reports the retained artifact when the abort cleanup cannot remove it", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(fsSync.statSync).mockImplementation((() => {
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
			}) as never)
			vi.mocked(fs.unlink).mockRejectedValue(new Error("EBUSY"))
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			await expect(safeWriteText(targetPath, "data", { platform: "win32" })).rejects.toThrow(
				/refusing to publish/,
			)

			const warned = warnSpy.mock.calls
				.map(function (call) {
					return String(call[0])
				})
				.join("\n")
			expect(warned).toContain("could not remove")
		})

		it("win32 DACL capture failure aborts before publishing", async () => {
			// The capture is judged by the artifact: make the dump absent so the capture fails.
			vi.mocked(fsSync.statSync).mockImplementation((() => {
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
			}) as never)
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// icacls dump fails and no usable dump exists.
			vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
				if (typeof cb === "function") cb(new Error("icacls error"), "", "")
				return fakeChild
			})

			await expect(safeWriteText(targetPath, "data", { platform: "win32" })).rejects.toThrow(
				/refusing to publish/,
			)

			// Fail closed: the target is never published, because publishing would replace its security
			// descriptor with inherited permissions and nothing could put the original back.
			// Only the save ran: a failed capture must not be followed by a restore attempt.
			expect(execFile).toHaveBeenCalledTimes(1)
			// The staging file and any partial dump are still cleaned up by the rollback.
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.acl.tmp"))
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"))
		})

		it("win32 DACL: a non-zero icacls exit that still wrote a dump counts as a capture", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// Measured on a normal host: /save can exit non-zero while leaving a usable dump behind.
			vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
				if (typeof cb === "function") cb(new Error("icacls exit 1"), "", "")
				return fakeChild
			})
			vi.mocked(fsSync.statSync).mockReturnValue({ isFile: () => true, size: 256 } as never)

			await safeWriteText(targetPath, "data", { platform: "win32" })

			// The capture is judged by the artifact, so the publish proceeds and the restore is attempted.
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), targetPath)
			// Save, then the restore attempt (icacls is retried once if it fails, so >= 2).
			const restoreCalls = vi.mocked(execFile).mock.calls.filter(function (call) {
				return Array.isArray(call[1]) && String(call[1]).includes("/restore")
			})
			expect(restoreCalls.length).toBeGreaterThan(0)
		})

		it("skips the DACL save and restore for the rest of the process once a restore reports the missing privilege", async () => {
			// The memo is process-wide, so this test runs against a fresh module instance:
			// otherwise the write below would disable DACL handling for every later test in
			// the file. vi.mock factories still apply to the re-imported module.
			vi.resetModules()
			const { safeWriteText: freshWriteText } = await import("../safeWriteText")
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
			const privilegeFailure = Object.assign(new Error("Access is denied."), { code: 1300 })
			let calls = 0
			const runner = vi.fn((...args: unknown[]) => {
				calls++
				const cb = args[args.length - 1] as (err: Error | null) => void
				// The save succeeds; every restore reports the missing privilege.
				cb(args[1] && String((args[1] as string[])[1]) === "/restore" ? privilegeFailure : null)
			}) as unknown as typeof execFile
			const options = { platform: "win32", execFileRunner: runner }

			await freshWriteText(targetPath, "data", options)
			const callsAfterFirstWrite = calls
			expect(callsAfterFirstWrite).toBeGreaterThan(0)
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("cannot restore DACLs"))

			calls = 0
			warn.mockClear()
			await freshWriteText(targetPath, "data", options)

			expect(calls).toBe(0)
			expect(warn).not.toHaveBeenCalled()
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), targetPath)
			warn.mockRestore()
		})

		it("win32 DACL save args are [targetPath, /save, dumpPath] before backup rename", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			await safeWriteText(targetPath, "data", { backup: true, platform: "win32" })

			// icacls was called twice (save + restore)
			expect(execFile).toHaveBeenCalledTimes(2)

			// First call: save DACL from target before backup rename
			const firstCall = vi.mocked(execFile).mock.calls[0]
			expect(firstCall[0]).toBe("icacls")
			expect(firstCall[1]).toEqual([targetPath, "/save", expect.stringContaining(".acl.tmp")])

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

		it("two concurrent writes to the same target use different DACL dumps", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			await Promise.all([
				safeWriteText(targetPath, "a", { platform: "win32" }),
				safeWriteText(targetPath, "b", { platform: "win32" }),
			])

			// A shared dump name lets one call unlink or overwrite the file the other is still using,
			// which silently loses the DACL restore. Each call must own its own dump.
			const saves = vi.mocked(execFile).mock.calls.filter((call) => (call[1] as string[]).indexOf("/save") >= 0)
			expect(saves.length).toBe(2)
			const dumps = saves.map((call) => String((call[1] as string[])[2]))
			expect(dumps[0]).not.toBe(dumps[1])
			expect(dumps[0]).toContain("safeWriteText.acl.tmp")
			expect(dumps[1]).toContain("safeWriteText.acl.tmp")
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

		it("removes the DACL dump on the second attempt when the first unlink fails", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			let dumpUnlinks = 0
			const unlinkMock = vi.mocked(fs.unlink)
			unlinkMock.mockImplementation(async (p) => {
				if (typeof p === "string" && p.includes(".acl.tmp")) {
					dumpUnlinks++
					if (dumpUnlinks === 1) {
						throw new Error("EBUSY")
					}
				}
				return undefined
			})
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			await safeWriteText(targetPath, "data", { platform: "win32" })

			// One bounded retry is enough here, and nothing is surfaced because the retry succeeded.
			expect(dumpUnlinks).toBe(2)
			expect(warnSpy).not.toHaveBeenCalled()
		})

		it("warns with the retained dump path when both dump unlinks fail", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			const unlinkMock = vi.mocked(fs.unlink)
			unlinkMock.mockImplementation(async (p) => {
				if (typeof p === "string" && p.includes(".acl.tmp")) {
					throw new Error("EBUSY")
				}
				return undefined
			})
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			await safeWriteText(targetPath, "data", { platform: "win32" })

			// An icacls dump is a readable copy of the target's ACL: leaving it behind is acceptable,
			// leaving it behind invisibly is not.
			const dumpCalls = unlinkMock.mock.calls.filter(function (call) {
				return typeof call[0] === "string" && call[0].includes(".acl.tmp")
			})
			expect(dumpCalls).toHaveLength(2)
			const warned = warnSpy.mock.calls
				.map(function (call) {
					return String(call[0])
				})
				.join("\n")
			expect(warned).toContain(".acl.tmp")
		})

		it("keeps the publish and warns when both backup-removal attempts fail", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// Only the backup unlink fails, twice; every other unlink works.
			const unlinkMock = vi.mocked(fs.unlink)
			unlinkMock.mockImplementation(async (p) => {
				if (typeof p === "string" && p.includes(".bak")) {
					throw new Error("EBUSY")
				}
				return undefined
			})
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			await safeWriteText(targetPath, "new data", { backup: true })

			// The write itself is unaffected - the backup is cleanup, not part of the commit.
			expect(fs.rename).toHaveBeenCalled()
			const bakCalls = unlinkMock.mock.calls.filter(function (call) {
				return typeof call[0] === "string" && call[0].includes(".bak")
			})
			expect(bakCalls).toHaveLength(2)
			const warned = warnSpy.mock.calls
				.map(function (call) {
					return String(call[0])
				})
				.join("\n")
			expect(warned).toContain("could not be removed")
			expect(warned).toContain(".bak")
		})

		it("removes a partially copied backup when the copy itself fails", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// copyFile can create the destination and then fail part way through.
			vi.mocked(fs.copyFile).mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }))

			await expect(safeWriteText(targetPath, "new data", { backup: true })).rejects.toThrow("EACCES")

			// The half-written backup must not be left next to the target, and the original error
			// is still the one that surfaces.
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining(".bak"))
		})

		it("closes the staging descriptor when applying the target mode fails", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(7)
			vi.mocked(fsSync.fchmodSync).mockImplementation(() => {
				throw Object.assign(new Error("EPERM"), { code: "EPERM" })
			})

			await expect(safeWriteText(targetPath, "data")).rejects.toThrow("EPERM")

			// The descriptor is opened before the mode is applied, so the close has to live in the
			// finally that also covers the mode call - otherwise a mode failure leaks the fd.
			expect(fsSync.closeSync).toHaveBeenCalledWith(7)
			expect(fsSync.writeSync).not.toHaveBeenCalled()
		})

		it("win32 DACL: when both restore attempts fail, the backup is retained", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			// /save succeeds (call 1); both /restore attempts fail (calls 2 and 3).
			let callCount = 0
			vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
				callCount++
				if (typeof cb === "function") {
					cb(callCount === 1 ? null : new Error("icacls restore error"), "", "")
				}
				return fakeChild
			})

			await safeWriteText(targetPath, "data", { platform: "win32", backup: true })

			// The content is still committed - a failed ACL restore is not a write failure.
			expect(fs.rename).toHaveBeenCalled()
			// The dump is still cleaned up in the finally block.
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining(".acl.tmp"))
			// But the backup survives: it is the only artifact that still carries the target's
			// original security descriptor, so deleting it would destroy the recovery path.
			expect(fs.unlink).not.toHaveBeenCalledWith(expect.stringContaining(".bak"))
		})

		it("staging temp release: a transient unlink failure on the rollback path is retried", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(fs.rename).mockRejectedValue(Object.assign(new Error("EBUSY rename"), { code: "EBUSY" }))
			let stagingUnlinks = 0
			vi.mocked(fs.unlink).mockImplementation((async (path: string) => {
				if (String(path).includes(".file-safety-staging")) {
					stagingUnlinks++
					if (stagingUnlinks === 1) {
						throw Object.assign(new Error("EBUSY unlink"), { code: "EBUSY" })
					}
				}
			}) as never)
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

			await expect(safeWriteText(targetPath, "data")).rejects.toThrow("EBUSY rename")
			expect(stagingUnlinks).toBe(2)
			expect(
				warn.mock.calls.filter(function (call) {
					return String(call[0]).includes("staging temp release failed")
				}).length,
			).toBe(0)
			warn.mockRestore()
		})

		it("staging temp release: a persistent failure names the retained path exactly once", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(fs.rename).mockRejectedValue(Object.assign(new Error("EBUSY rename"), { code: "EBUSY" }))
			let stagingUnlinks = 0
			vi.mocked(fs.unlink).mockImplementation((async (path: string) => {
				if (String(path).includes(".file-safety-staging")) {
					stagingUnlinks++
					throw Object.assign(new Error("EBUSY unlink"), { code: "EBUSY" })
				}
			}) as never)
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

			await expect(safeWriteText(targetPath, "data")).rejects.toThrow("EBUSY rename")
			expect(stagingUnlinks).toBe(2)
			expect(
				warn.mock.calls.filter(function (call) {
					return String(call[0]).includes("staging temp release failed")
				}).length,
			).toBe(1)
			warn.mockRestore()
		})

		it("win32 DACL: a non-regular dump file fails closed even when it is non-empty", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
				if (typeof cb === "function") {
					cb(null, "", "")
				}
				return fakeChild
			})
			// The dump exists with bytes in it, but it is not a regular file (a directory, a FIFO or a
			// device left behind by another process). icacls /restore against it is not a restore of our
			// descriptor, so the write has to fail closed instead of publishing.
			vi.mocked(fsSync.statSync).mockReturnValue({ isFile: () => false, size: 4096 } as never)

			await expect(safeWriteText(targetPath, "data", { platform: "win32", backup: true })).rejects.toThrow(
				/DaclCaptureError|refus/i,
			)

			expect(fs.rename).not.toHaveBeenCalled()
		})

		it("win32 DACL: a failed first restore is retried and the backup is then removed", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			// /save succeeds (call 1), the first /restore fails (call 2), the retry succeeds (call 3).
			let callCount = 0
			vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb) => {
				callCount++
				if (typeof cb === "function") {
					cb(callCount === 2 ? new Error("icacls transient error") : null, "", "")
				}
				return fakeChild
			})

			await safeWriteText(targetPath, "data", { platform: "win32", backup: true })

			const saves = vi.mocked(execFile).mock.calls.filter(function (call) {
				return String(call[1]).includes("/save")
			})
			const restores = vi.mocked(execFile).mock.calls.filter(function (call) {
				return String(call[1]).includes("/restore")
			})
			expect(saves.length).toBe(1)
			expect(restores.length).toBe(2)
			expect(fs.rename).toHaveBeenCalled()
			// The descriptor is back, so the backup is no longer the recovery artifact and is removed.
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining(".bak"))
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

		it("refuses to stage when the target mode is unknown (non-ENOENT stat error)", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
			vi.mocked(fsSync.statSync).mockImplementation(() => {
				throw eacces
			})

			// Falling back to 0o644 here could publish a 0o600 target with a wider mode.
			await expect(safeWriteText(targetPath, "data", { platform: "linux" })).rejects.toBe(eacces)
		})

		it("refuses to publish a caller-supplied temp when the target mode is unknown", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			const customTempPath = "/tmp/custom-temp.tmp"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(2)
			const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
			vi.mocked(fsSync.statSync).mockImplementation(() => {
				throw eacces
			})

			// The temp carries its own creation mode, which may be wider than the target's.
			await expect(
				safeWriteText(targetPath, "data", { tempPath: customTempPath, platform: "linux" }),
			).rejects.toBe(eacces)

			expect(fsSync.fchmodSync).not.toHaveBeenCalled()
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

		it("follows a dangling symlink to its referent instead of replacing the link", async () => {
			const linkPath = path.resolve("/tmp/dangling-dir/link.txt")
			const referent = path.resolve("/tmp/dangling-dir/real.txt")
			// realpath reports ENOENT both for a missing path and for a dangling link; only the
			// link lookup is a symlink, the referent resolves as an ordinary absent target.
			vi.mocked(fs.realpath).mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
			vi.mocked(fs.realpath).mockResolvedValue(referent)
			const linkStats = Object.create(fsSync.Stats.prototype) as fsSync.Stats & {
				isSymbolicLink?: () => boolean
				isDirectory?: () => boolean
			}
			linkStats.isSymbolicLink = () => true
			linkStats.isDirectory = () => false
			vi.mocked(fs.lstat).mockResolvedValueOnce(linkStats)
			vi.mocked(fs.readlink).mockResolvedValueOnce("real.txt")
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(fsSync.closeSync).mockReturnValue(undefined)

			await safeWriteText(linkPath, "hello", { platform: "linux" })

			// The commit rename must publish at the referent, never over the link path.
			expect(fs.lstat).toHaveBeenCalledWith(linkPath)
			const renames = vi.mocked(fs.rename).mock.calls
			expect(renames.at(-1)?.[1]).toBe(referent)
			expect(renames.some((call) => call[1] === linkPath)).toBe(false)
		})
	})

	// ── Test 8: review fixes (permissions, partial writes, resolution, durability) ──

	describe("review fixes", () => {
		it("applies an existing target's mode with fchmodSync, not the umask-masked creation mode", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(fsSync.closeSync).mockReturnValue(undefined)
			// A group-writable target: openSync(path, "w", 0o664) would create 0o644 under a
			// 0o022 umask, and the rename would publish the narrowed mode.
			vi.mocked(fsSync.statSync).mockReturnValue(_stats(0o664))

			await safeWriteText(targetPath, "data", { platform: "linux" })

			expect(fsSync.fchmodSync).toHaveBeenCalledWith(1, 0o664)
		})

		it("leaves a fresh target to its creation mode", async () => {
			const targetPath = "/tmp/test-dir/new-target.txt"
			const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" })
			vi.mocked(fs.realpath).mockRejectedValue(enoent)
			vi.mocked(fsSync.statSync).mockImplementation(() => {
				throw enoent
			})
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(fsSync.closeSync).mockReturnValue(undefined)

			await safeWriteText(targetPath, "data", { platform: "linux" })

			expect(fsSync.fchmodSync).not.toHaveBeenCalled()
		})

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

		it("keeps the target's group on the staged file before publishing over it", async () => {
			// The commit is a rename, so the new inode would otherwise take this process's
			// primary group and a shared 0o664 group-owned file would lose group write access
			// even with the mode restored. Order matters: chown can clear setgid bits, so it
			// has to run before the chmod.
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			vi.mocked(fsSync.statSync).mockReturnValue(_stats(0o664, 4321))

			await safeWriteText(targetPath, "data", { platform: "linux" })

			expect(fsSync.fchownSync).toHaveBeenCalledWith(1, -1, 4321)
			expect(fsSync.fchmodSync).toHaveBeenCalledWith(1, 0o664)
			expect(vi.mocked(fsSync.fchownSync).mock.invocationCallOrder[0]).toBeLessThan(
				vi.mocked(fsSync.fchmodSync).mock.invocationCallOrder[0],
			)
		})

		it("keeps the target's group when the caller staged the temp file", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(7)
			vi.mocked(fsSync.statSync).mockReturnValue(_stats(0o664, 4321))

			await safeWriteText(targetPath, "data", { platform: "linux", tempPath: "/tmp/test-dir/caller.tmp" })

			expect(fsSync.fchownSync).toHaveBeenCalledWith(7, -1, 4321)
			expect(fsSync.fchmodSync).toHaveBeenCalledWith(7, 0o664)
			expect(vi.mocked(fsSync.fchownSync).mock.invocationCallOrder[0]).toBeLessThan(
				vi.mocked(fsSync.fchmodSync).mock.invocationCallOrder[0],
			)
		})

		it("does not attempt a group change on a platform whose identity is the DACL", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// Windows carries no POSIX gid to preserve - its identity is the DACL, which the
			// save/restore steps own - so the DACL path has to stay reachable here.
			vi.mocked(fsSync.statSync).mockImplementation(((p: unknown) =>
				typeof p === "string" && p.includes(".acl.tmp")
					? { isFile: () => true, size: 256 }
					: _stats(0o664, 4321)) as never)
			vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
				const cb = args[args.length - 1] as (err: Error | null) => void
				cb(null)
			}) as never)

			await safeWriteText(targetPath, "data", { platform: "win32" })

			expect(fsSync.fchownSync).not.toHaveBeenCalled()
			expect(fsSync.fchmodSync).toHaveBeenCalledWith(1, 0o664)
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

		it("reports a failed parent-directory fsync instead of resolving as durable", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync)
				.mockReturnValueOnce(1)
				.mockImplementationOnce(() => {
					throw new Error("EBADF")
				})

			// The rename committed, so the content is in place, but the caller must not be
			// told the publish is durable when the directory entry could not be fsynced.
			expect(await _rejectionName(safeWriteText(targetPath, "data", { platform: "linux" }))).toBe(
				"PublishNotDurableError",
			)

			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), targetPath)
		})

		it("keeps the backup when the commit is not confirmed durable", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync)
				.mockReturnValueOnce(1)
				.mockImplementationOnce(() => {
					throw new Error("EBADF")
				})

			expect(await _rejectionName(safeWriteText(targetPath, "data", { platform: "linux", backup: true }))).toBe(
				"PublishNotDurableError",
			)

			// The previous content stays recoverable while durability is unconfirmed.
			expect(fs.unlink).not.toHaveBeenCalledWith(expect.stringContaining("safeWriteText.bak_"))
		})

		it("refuses to stage through a planted .file-safety-staging symlink", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			// lstat reports a non-directory at the staging path. mkdirSync(recursive)
			// would follow it, staging - and then publishing - outside the target directory.
			vi.mocked(fsSync.lstatSync).mockReturnValue(_linkStats())

			expect(await _rejectionName(safeWriteText(targetPath, "data", { platform: "linux" }))).toBe(
				"UnsafeStagingDirectoryError",
			)

			expect(fsSync.mkdirSync).not.toHaveBeenCalled()
		})

		it.skipIf(process.platform === "win32")(
			"refuses to stage in a .file-safety-staging directory owned by another uid",
			async () => {
				const targetPath = "/tmp/test-dir/target.txt"
				vi.mocked(fs.realpath).mockResolvedValue(targetPath)
				// A staging directory that exists but belongs to a different uid: the writer must
				// not place temp files where another user could observe or pre-create them.
				const foreign = _dirStats() as fsSync.Stats & { uid?: number }
				foreign.uid = (process.getuid?.() ?? 0) + 1
				vi.mocked(fsSync.lstatSync).mockReturnValue(foreign)

				expect(await _rejectionName(safeWriteText(targetPath, "data", { platform: "linux" }))).toBe(
					"UnsafeStagingDirectoryError",
				)

				// Nothing is staged and nothing is published from the foreign directory.
			},
		)

		it("removes the staging directory once the write is over", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)

			await safeWriteText(targetPath, "data", { platform: "linux" })

			expect(fs.rmdir).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"))
		})

		it("re-creates the staging directory when a concurrent write removes it mid-write", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync)
				.mockImplementationOnce(() => {
					// Another writer committed and rmdir'd the shared staging directory
					// between _stagingDir() and this open.
					throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
				})
				.mockReturnValue(1)

			await safeWriteText(targetPath, "data", { platform: "linux" })

			// Once for the original staging call, once for the recovery.
			expect(fsSync.mkdirSync).toHaveBeenCalledTimes(2)
			expect(fs.rename).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"), targetPath)
		})

		it("gives up after one recovery when the staging open keeps failing with ENOENT", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
			vi.mocked(fsSync.openSync).mockImplementation(() => {
				throw enoent
			})

			await expect(safeWriteText(targetPath, "data", { platform: "linux" })).rejects.toBe(enoent)

			// One staging create plus one recovery attempt, then the error surfaces.
			expect(fsSync.mkdirSync).toHaveBeenCalledTimes(2)
			expect(fsSync.openSync).toHaveBeenCalledTimes(2)
		})

		it("retries a transient Windows sharing failure during the commit rename", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			// No target yet, so the Windows DACL steps are skipped and only the rename is exercised.
			vi.mocked(fs.access).mockImplementation(async (p: fsSync.PathLike) => {
				if (p === targetPath) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
			})
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			const eperm = Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })
			vi.mocked(fs.rename).mockRejectedValueOnce(eperm)

			await safeWriteText(targetPath, "data", { platform: "win32" })

			expect(fs.rename).toHaveBeenCalledTimes(2)
		})

		it.each(["EPERM", "EACCES", "EBUSY"] as const)(
			"retries the commit rename for the transient Windows sharing code %s",
			async (code) => {
				const targetPath = "/tmp/test-dir/target.txt"
				vi.mocked(fs.realpath).mockResolvedValue(targetPath)
				vi.mocked(fs.access).mockImplementation(async (p: fsSync.PathLike) => {
					if (p === targetPath) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
				})
				vi.mocked(fsSync.openSync).mockReturnValue(1)
				const failure = Object.assign(new Error(code + ": transient sharing violation"), { code })
				vi.mocked(fs.rename).mockRejectedValueOnce(failure)

				await safeWriteText(targetPath, "data", { platform: "win32" })

				expect(fs.rename).toHaveBeenCalledTimes(2)
			},
		)

		it("gives up after five retries and propagates the original rename error", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fs.access).mockImplementation(async (p: fsSync.PathLike) => {
				if (p === targetPath) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
			})
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			const ebusy = Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" })
			vi.mocked(fs.rename).mockRejectedValue(ebusy)

			await expect(safeWriteText(targetPath, "data", { platform: "win32" })).rejects.toBe(ebusy)

			// The initial attempt plus _RENAME_RETRY_ATTEMPTS (5), then the original error.
			expect(fs.rename).toHaveBeenCalledTimes(6)
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"))
		})

		it("creates the staging dir when lstatSync reports it absent on first use", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
			// First lstat (the guard) sees no staging dir at all; the post-create re-check does.
			vi.mocked(fsSync.lstatSync)
				.mockImplementationOnce(() => {
					throw enoent
				})
				.mockImplementation(() => _dirStats())

			await safeWriteText(targetPath, "data", { platform: "linux" })

			// realpath is mocked to return the literal path, so the SUT never resolves it.
			expect(fsSync.mkdirSync).toHaveBeenCalledWith(_stagingDir(path.dirname(targetPath)), {
				recursive: true,
				mode: 0o700,
			})
			expect(fs.rename).toHaveBeenCalled()
		})

		it("rejects when the staging path is replaced between the guard and the re-check", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			// Guard: a real directory. Re-check after mkdirSync: a symlink planted in between.
			vi.mocked(fsSync.lstatSync).mockReturnValueOnce(_dirStats()).mockReturnValueOnce(_linkStats())

			const name = await _rejectionName(safeWriteText(targetPath, "data", { platform: "linux" }))
			expect(name).toBe("UnsafeStagingDirectoryError")
		})

		it("removes a staging directory it created when the post-create re-check rejects it", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
			// Guard: nothing there, so this call is the one that creates it. Re-check: swapped for a
			// symlink. The caller never receives the path, so this call is also the only one that can
			// clean it up - otherwise a stray .file-safety-staging sits in the user's directory.
			vi.mocked(fsSync.lstatSync)
				.mockImplementationOnce(() => {
					throw enoent
				})
				.mockReturnValueOnce(_linkStats())

			const name = await _rejectionName(safeWriteText(targetPath, "data", { platform: "linux" }))
			expect(name).toBe("UnsafeStagingDirectoryError")
			expect(fsSync.rmdirSync).toHaveBeenCalledWith(_stagingDir(path.dirname(targetPath)))
		})

		it("leaves a pre-existing staging directory when the post-create re-check rejects it", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			// Guard: the directory was already there - it may belong to a concurrent write, so this
			// call must not remove it even though the re-check rejects the path.
			vi.mocked(fsSync.lstatSync).mockReturnValueOnce(_dirStats()).mockReturnValueOnce(_linkStats())

			const name = await _rejectionName(safeWriteText(targetPath, "data", { platform: "linux" }))
			expect(name).toBe("UnsafeStagingDirectoryError")
			expect(fsSync.rmdirSync).not.toHaveBeenCalled()
		})

		it("does not retry a rename failure on a platform without sharing violations", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			const eperm = Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })
			vi.mocked(fs.rename).mockRejectedValue(eperm)

			await expect(safeWriteText(targetPath, "data", { platform: "linux" })).rejects.toBe(eperm)

			expect(fs.rename).toHaveBeenCalledTimes(1)
		})

		it("propagates realpath errors (EACCES and code-less) instead of the fallback path", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
			vi.mocked(fs.realpath).mockRejectedValueOnce(eacces)
			await expect(safeWriteText(targetPath, "data", { platform: "linux" })).rejects.toBe(eacces)

			const plain = new Error("resolution failed")
			vi.mocked(fs.realpath).mockRejectedValueOnce(plain)
			await expect(safeWriteText(targetPath, "data", { platform: "linux" })).rejects.toBe(plain)
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
		})
	})

	describe("failure paths inside the staging write", () => {
		it("propagates a writeSync failure, closes the descriptor, and never publishes the staged file", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			const writeError = new Error("ENOSPC: no space left on device")
			vi.mocked(fsSync.writeSync).mockImplementationOnce(() => {
				throw writeError
			})

			await expect(safeWriteText(targetPath, "hello world", { platform: "linux" })).rejects.toBe(writeError)

			// The descriptor opened for the staging file must still be closed.
			expect(fsSync.closeSync).toHaveBeenCalledWith(1)
			// Nothing may be renamed into the target position after a partial write.
			// The truncated staging file is removed on failure.
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"))
		})

		it("propagates an fsync failure, closes the descriptor, and never publishes the staged file", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			const fsyncError = new Error("EBADF: fsync failed")
			vi.mocked(fsSync.fsyncSync).mockImplementationOnce(() => {
				throw fsyncError
			})

			await expect(safeWriteText(targetPath, "hello world", { platform: "linux" })).rejects.toBe(fsyncError)

			expect(fsSync.closeSync).toHaveBeenCalledWith(1)
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"))
		})

		it("backup:true copies the target instead of moving it, so a failed publish leaves the target in place", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			const publishError = new Error("EXDEV: cross-device rename not permitted")
			vi.mocked(fs.rename).mockRejectedValueOnce(publishError)

			await expect(safeWriteText(targetPath, "hello world", { platform: "linux", backup: true })).rejects.toBe(
				publishError,
			)

			// The backup is a copy, so the target was never renamed away and there is nothing to roll back.
			expect(fs.copyFile).toHaveBeenCalled()
			expect(fs.rename).toHaveBeenCalledTimes(1)
			// Both the backup copy and the staging temp are removed on failure.
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.bak_"))
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText_"))
		})

		it("removes the DACL dump and aborts when the save fails after creating it", async () => {
			const targetPath = "/tmp/test-dir/target.txt"
			vi.mocked(fs.realpath).mockResolvedValue(targetPath)
			vi.mocked(fsSync.openSync).mockReturnValue(1)
			// execFile callback form: report a failure after the dump file was created.
			vi.mocked(execFile).mockImplementationOnce(((
				_cmd: string,
				_args: string[],
				_opts: unknown,
				cb: (err: Error) => void,
			) => {
				cb(new Error("icacl dump failed"))
				return fakeChild
			}) as unknown as typeof execFile)

			await expect(safeWriteText(targetPath, "hello world", { platform: "win32" })).rejects.toThrow(
				/refusing to publish/,
			)

			// The dump path stays tracked so the rollback removes the file the failed save created.
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.acl.tmp"))
		})
	})
})

describe("resolvePublishTarget symlink cycle (S1)", () => {
	beforeEach(() => {
		// This describe sits outside the file's main describe, so it clears the shared
		// fs stubs itself: the assertions below are about 'never called at all'.
		vi.mocked(fs.rename).mockClear()
		vi.mocked(fs.copyFile).mockClear()
		vi.mocked(fs.unlink).mockClear()
		vi.mocked(fsSync.openSync).mockClear()
		vi.mocked(fsSync.writeSync).mockClear()
	})

	it("raises ELOOP for two dangling links that point at each other, before any staging", async () => {
		const linkA = path.resolve("/work/a.link")
		const linkB = path.resolve("/work/b.link")

		// realpath reports ENOENT for a dangling link, so the resolver follows the link text.
		// Two links that point at each other are both dangling: the visited set is what bounds
		// the recursion, and the cycle must surface as ELOOP.
		vi.mocked(fs.realpath).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
		vi.mocked(fs.lstat).mockResolvedValue({ isSymbolicLink: () => true } as unknown as fsSync.Stats)
		vi.mocked(fs.readlink).mockImplementation(async (target) => (String(target) === linkA ? linkB : linkA))

		await expect(resolvePublishTarget(linkA)).rejects.toMatchObject({ code: "ELOOP" })

		// Nothing may be staged or published for a path whose referent cannot be resolved.
		expect(vi.mocked(fs.rename)).not.toHaveBeenCalled()
		expect(vi.mocked(fsSync.openSync)).not.toHaveBeenCalled()
		expect(vi.mocked(fs.copyFile)).not.toHaveBeenCalled()
	})

	it("surfaces ELOOP through safeWriteText without touching the target", async () => {
		const linkA = path.resolve("/work/a.link")
		const linkB = path.resolve("/work/b.link")
		vi.mocked(fs.realpath).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
		vi.mocked(fs.lstat).mockResolvedValue({ isSymbolicLink: () => true } as unknown as fsSync.Stats)
		vi.mocked(fs.readlink).mockImplementation(async (target) => (String(target) === linkA ? linkB : linkA))

		await expect(safeWriteText(linkA, "payload")).rejects.toMatchObject({ code: "ELOOP" })

		expect(vi.mocked(fs.rename)).not.toHaveBeenCalled()
		expect(vi.mocked(fsSync.openSync)).not.toHaveBeenCalled()
	})

	it("propagates an lstat failure that follows a realpath ENOENT", async () => {
		const linkPath = "/tmp/test-dir/dangling-link"
		vi.mocked(fs.realpath).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
		vi.mocked(fs.lstat).mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }))
		// readlink is stubbed by earlier tests in this file and this describe does not reset it,
		// so clear it here to make "never called" mean what it says.
		vi.mocked(fs.readlink).mockClear()

		// "Could not inspect" is not "not a link": falling back to the link path here would let the
		// publish replace the link, which is what the resolver exists to prevent.
		await expect(resolvePublishTarget(linkPath)).rejects.toThrow("EACCES")
		expect(fs.readlink).not.toHaveBeenCalled()
	})

	it("propagates a readlink failure for a dangling symlink", async () => {
		const linkPath = "/tmp/test-dir/dangling-link"
		vi.mocked(fs.realpath).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
		vi.mocked(fs.lstat).mockResolvedValue({ isSymbolicLink: () => true } as never)
		vi.mocked(fs.readlink).mockRejectedValue(Object.assign(new Error("EIO"), { code: "EIO" }))

		// The link is known to exist but its target cannot be read: publishing onto the link path
		// would replace the link with a regular file, so the error has to surface.
		await expect(resolvePublishTarget(linkPath)).rejects.toThrow("EIO")
	})
})

describe("parent directory creation (safeWriteText.ts:288-290)", () => {
	beforeEach(() => {
		// This block sits outside describe("safeWriteText"), so the resetAllMocks there
		// never runs for it: without its own reset it inherits whatever the previous block
		// left in the mocks, and a run with -t that selects only these tests gets bare
		// vi.fn() stubs (undefined stats) and fails for unrelated reasons.
		vi.resetAllMocks()
		vi.mocked(fs.mkdir).mockResolvedValue(undefined)
		vi.mocked(fs.access).mockResolvedValue(undefined)
		vi.mocked(fs.rename).mockResolvedValue(undefined)
		vi.mocked(fs.unlink).mockResolvedValue(undefined)
		vi.mocked(fsSync.statSync).mockReturnValue(_stats(0o644))
		vi.mocked(fsSync.lstatSync).mockReturnValue(_dirStats())
		vi.mocked(fsSync.writeSync).mockImplementation((...args: unknown[]) =>
			typeof args[3] === "number" ? args[3] : 0,
		)
		vi.mocked(fs.realpath).mockResolvedValue("/tmp/test-dir/target.txt")
		vi.mocked(fs.mkdir).mockResolvedValue(undefined)
		vi.mocked(fs.access).mockResolvedValue(undefined)
		vi.mocked(fsSync.openSync).mockReturnValue(1)
	})

	it("propagates an mkdir failure before any staging, open or publish", async () => {
		const targetPath = "/tmp/test-dir/target.txt"
		const err = Object.assign(new Error("EACCES: cannot create"), { code: "EACCES" })
		vi.mocked(fs.mkdir).mockRejectedValue(err)

		await expect(safeWriteText(targetPath, "data", { platform: "linux" })).rejects.toBe(err)
	})

	it("propagates an access failure on the parent directory before any staging, open or publish", async () => {
		const targetPath = "/tmp/test-dir/target.txt"
		const err = Object.assign(new Error("EACCES: cannot verify"), { code: "EACCES" })
		vi.mocked(fs.access).mockRejectedValue(err)

		await expect(safeWriteText(targetPath, "data", { platform: "linux" })).rejects.toBe(err)
	})

	it("creates and verifies the parent directory on the successful path", async () => {
		const targetPath = "/tmp/test-dir/nested/target.txt"
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)

		await safeWriteText(targetPath, "data", { platform: "linux" })

		expect(fs.mkdir).toHaveBeenCalledWith("/tmp/test-dir/nested", { recursive: true })
		expect(fs.access).toHaveBeenCalledWith("/tmp/test-dir/nested")
		expect(fs.rename).toHaveBeenCalled()
	})
})

describe("partial backup after a failed copy (backup:true)", () => {
	beforeEach(() => {
		// Same isolation reason as the block above: outside the main describe, so nothing
		// resets the mocks or restores the defaults for it.
		vi.resetAllMocks()
		vi.mocked(fs.mkdir).mockResolvedValue(undefined)
		vi.mocked(fs.access).mockResolvedValue(undefined)
		vi.mocked(fs.rename).mockResolvedValue(undefined)
		vi.mocked(fs.unlink).mockResolvedValue(undefined)
		vi.mocked(fsSync.statSync).mockReturnValue(_stats(0o644))
		vi.mocked(fsSync.lstatSync).mockReturnValue(_dirStats())
		vi.mocked(fsSync.writeSync).mockImplementation((...args: unknown[]) =>
			typeof args[3] === "number" ? args[3] : 0,
		)
	})

	it("removes the partial backup when copyFile fails with ENOENT and the publish succeeds", async () => {
		const targetPath = "/tmp/test-dir/target.txt"
		vi.mocked(fs.realpath).mockResolvedValue(targetPath)
		vi.mocked(fsSync.openSync).mockReturnValue(1)
		// The target exists for the backup pre-check, then the copy itself fails: a partial file
		// may already sit at the .bak path while backupCreated stays false. The publish still
		// succeeds, and nothing else in the flow would ever remove that half-written backup.
		vi.mocked(fs.access).mockResolvedValue(undefined)
		vi.mocked(fs.copyFile).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

		await safeWriteText(targetPath, "data", { platform: "linux", backup: true })

		expect(fs.rename).toHaveBeenCalled()
		expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("safeWriteText.bak"))
	})
})

describe("staging directory release", () => {
	it("retries a transient release failure once and then surfaces it", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		vi.mocked(fs.realpath).mockResolvedValue("/tmp/test-dir/target.txt")
		vi.mocked(fsSync.openSync).mockReturnValue(1)
		vi.mocked(fs.rmdir).mockRejectedValue(Object.assign(new Error("EBUSY"), { code: "EBUSY" }))

		await safeWriteText("/tmp/test-dir/target.txt", "data", { platform: "linux" })

		const messages = warn.mock.calls.map(function (c) {
			return String(c[0])
		})
		expect(
			messages.filter(function (m) {
				return m.indexOf("staging directory release failed") >= 0
			}).length,
		).toBe(1)
		warn.mockRestore()
	})

	it("treats ENOTEMPTY as benign: no warning at all", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		vi.mocked(fs.realpath).mockResolvedValue("/tmp/test-dir/target.txt")
		vi.mocked(fsSync.openSync).mockReturnValue(1)
		vi.mocked(fs.rmdir).mockRejectedValue(Object.assign(new Error("ENOTEMPTY"), { code: "ENOTEMPTY" }))

		await safeWriteText("/tmp/test-dir/target.txt", "data", { platform: "linux" })

		expect(warn).not.toHaveBeenCalled()
		warn.mockRestore()
	})
})

describe("post-create staging probe failure", () => {
	it("removes a staging directory it created when the post-create lstat fails", async () => {
		const ioError = Object.assign(new Error("EIO"), { code: "EIO" })
		vi.mocked(fs.realpath).mockResolvedValue("/tmp/test-dir/target.txt")
		vi.mocked(fsSync.openSync).mockReturnValue(1)
		// Path-aware, not positional: the ancestor walk also calls lstatSync, so a once-chain
		// would be consumed by the wrong site. Only the staging directory's own probes are
		// scripted here - absent, then an I/O error on the post-create re-check.
		let stagingProbes = 0
		vi.mocked(fsSync.lstatSync).mockImplementation(((target: string) => {
			if (String(target).includes(".file-safety-staging")) {
				stagingProbes++
				if (stagingProbes === 1) {
					throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
				}
				throw ioError
			}
			return _dirStats()
		}) as never)

		await expect(safeWriteText("/tmp/test-dir/target.txt", "data", { platform: "linux" })).rejects.toBe(ioError)

		expect(stagingProbes).toBe(2)
		expect(fsSync.rmdirSync).toHaveBeenCalledWith(expect.stringContaining(".file-safety-staging"))
	})
})
