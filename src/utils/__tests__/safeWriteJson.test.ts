import * as fsSyncActual from "fs"
import { Writable } from "stream"
import * as path from "path"
import * as os from "os"

import { ConfinedPathEscapeError, safeWriteJson } from "../safeWriteJson"
import { TargetMovedError } from "../../services/file-safety/safeWriteText"
import * as lockfile from "proper-lockfile"

// Capture actual implementations before the vi.mock factory runs,
// so they are never wrapped by vi.fn() — avoids infinite recursion when
// test mockImplementation callbacks delegate to the real implementation.
const fsPromisesActuals = vi.hoisted(() => ({
	rename: undefined as (typeof import("fs/promises"))["rename"] | undefined,
	unlink: undefined as (typeof import("fs/promises"))["unlink"] | undefined,
	writeFile: undefined as (typeof import("fs/promises"))["writeFile"] | undefined,
}))

vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	fsPromisesActuals.rename = actual.rename
	fsPromisesActuals.unlink = actual.unlink
	fsPromisesActuals.writeFile = actual.writeFile
	// Start with all actual implementations.
	const mockedFs = { ...actual }
	// Selectively wrap functions with vi.fn() if they are spied on
	// or have their implementations changed in tests.
	// This ensures that other fs.promises functions used by the SUT
	// (like proper-lockfile's internals) will use their actual implementations.
	mockedFs.writeFile = vi.fn(actual.writeFile) as any
	mockedFs.readFile = vi.fn(actual.readFile) as any
	mockedFs.rename = vi.fn(actual.rename) as any
	mockedFs.unlink = vi.fn(actual.unlink) as any
	mockedFs.access = vi.fn(actual.access) as any
	mockedFs.mkdtemp = vi.fn(actual.mkdtemp) as any
	mockedFs.rm = vi.fn(actual.rm) as any
	mockedFs.readdir = vi.fn(actual.readdir) as any
	mockedFs.mkdir = vi.fn(actual.mkdir) as any
	// fs.stat and fs.lstat will be available via { ...actual }

	return mockedFs
})

// Mock the 'fs' module for fsSync.createWriteStream
vi.mock("fs", async () => {
	const actualFs = await vi.importActual<typeof import("fs")>("fs")
	return {
		...actualFs, // Spread actual implementations
		createWriteStream: vi.fn(actualFs.createWriteStream) as any, // Default to actual, but mockable
	}
})

import * as fs from "fs/promises" // This will now be the mocked version

describe("safeWriteJson", () => {
	let originalConsoleError: typeof console.error

	beforeAll(() => {
		// Store original console.error
		originalConsoleError = console.error
	})

	afterAll(() => {
		// Restore original console.error
		console.error = originalConsoleError
	})

	let tempDir: string
	let currentTestFilePath: string

	beforeEach(async () => {
		// Create a temporary directory for each test
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "safeWriteJson-test-"))

		// Create a unique file path for each test
		currentTestFilePath = path.join(tempDir, "test-file.json")

		// Pre-create the file with initial content to ensure it exists
		// This allows proper-lockfile to acquire a lock on an existing file.
		await fs.writeFile(currentTestFilePath, JSON.stringify({ initial: "content" }))
	})

	afterEach(async () => {
		// Clean up the temporary directory after each test
		await fs.rm(tempDir, { recursive: true, force: true })

		// Reset all mocks to their actual implementations
		vi.restoreAllMocks()
	})

	// Helper function to read file content
	async function readFileContent(filePath: string): Promise<any> {
		const readContent = await fs.readFile(filePath, "utf-8")
		return JSON.parse(readContent)
	}

	// Helper function to check if a file exists
	async function fileExists(filePath: string): Promise<boolean> {
		try {
			await fs.access(filePath)
			return true
		} catch {
			return false
		}
	}

	// Success Scenarios
	// Note: Since we pre-create the file in beforeEach, this test will overwrite it.
	// If "creation from non-existence" is critical and locking prevents it, safeWriteJson or locking strategy needs review.
	test("should successfully write a new file (overwriting initial content from beforeEach)", async () => {
		const data = { message: "Hello, new world!" }

		await safeWriteJson(currentTestFilePath, data)

		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual(data)
	})

	test("should successfully overwrite an existing file", async () => {
		const initialData = { message: "Initial content" }
		const newData = { message: "Updated content" }

		// Write initial data (overwriting the pre-created file from beforeEach)
		await fsPromisesActuals.writeFile!(currentTestFilePath, JSON.stringify(initialData))

		await safeWriteJson(currentTestFilePath, newData)

		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual(newData)
	})

	// Failure Scenarios
	test("should handle failure when writing to tempNewFilePath", async () => {
		// currentTestFilePath exists due to beforeEach, allowing lock acquisition.
		const data = { message: "test write failure" }

		const mockErrorStream = new Writable() as any
		mockErrorStream._write = (_chunk: any, _encoding: any, callback: any) => {
			callback(new Error("Write stream error"))
		}
		// Add missing WriteStream properties
		mockErrorStream.close = vi.fn()
		mockErrorStream.bytesWritten = 0
		mockErrorStream.path = ""
		mockErrorStream.pending = false

		// Mock createWriteStream to return a stream that errors on write
		;(fsSyncActual.createWriteStream as any).mockImplementationOnce((_path: any, _options: any) => {
			return mockErrorStream
		})

		await expect(safeWriteJson(currentTestFilePath, data)).rejects.toThrow("Write stream error")

		// Verify the original file still exists and is unchanged
		const exists = await fileExists(currentTestFilePath)
		expect(exists).toBe(true)

		// Verify content is unchanged (should still have the initial content from beforeEach)
		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual({ initial: "content" })
	})

	test("should handle failure when the commit rename fails (filePath exists)", async () => {
		const initialData = { message: "Initial content, should remain" }
		const newData = { message: "New content, should not be written" }

		// Overwrite the pre-created file with specific initial data
		await fsPromisesActuals.writeFile!(currentTestFilePath, JSON.stringify(initialData))

		// fs.rename is already vi.fn() — use vi.mocked to avoid double-wrapping via vi.spyOn
		vi.mocked(fs.rename).mockImplementationOnce(async () => {
			throw new Error("Rename to backup failed")
		})

		await expect(safeWriteJson(currentTestFilePath, newData)).rejects.toThrow("Rename to backup failed")

		// Verify the original file still exists with initial content
		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual(initialData)
	})

	test("should handle failure when renaming tempNewFilePath to filePath (filePath exists, backup copy taken)", async () => {
		const initialData = { message: "Initial content, should be restored" }
		const newData = { message: "New content" }

		// Overwrite the pre-created file with specific initial data
		await fsPromisesActuals.writeFile!(currentTestFilePath, JSON.stringify(initialData))

		// Track rename calls
		let renameCallCount = 0

		// fs.rename is already vi.fn() — use vi.mocked to avoid double-wrapping via vi.spyOn
		vi.mocked(fs.rename).mockImplementation(async (oldPath, newPath) => {
			renameCallCount++
			if (renameCallCount === 1) {
				// The commit rename is the only rename in this flow: it fails.
				throw new Error("Rename from temp to final failed")
			}
			// Default: use original implementation
			return fsPromisesActuals.rename!(oldPath, newPath)
		})

		await expect(safeWriteJson(currentTestFilePath, newData)).rejects.toThrow("Rename from temp to final failed")

		// Verify the file was restored to initial content
		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual(initialData)
	})

	// Tests for directory creation functionality
	test("should create parent directory if it doesn't exist", async () => {
		// Create a path in a non-existent subdirectory of the temp dir
		const subDir = path.join(tempDir, "new-subdir")
		const filePath = path.join(subDir, "file.json")
		const data = { test: "directory creation" }

		// Verify directory doesn't exist
		await expect(fs.access(subDir)).rejects.toThrow()

		// Write file
		await safeWriteJson(filePath, data)

		// Verify directory was created
		await expect(fs.access(subDir)).resolves.toBeUndefined()

		// Verify file was written
		const content = await readFileContent(filePath)
		expect(content).toEqual(data)
	})

	test("should handle multi-level directory creation", async () => {
		// Create a new non-existent subdirectory path with multiple levels
		const deepDir = path.join(tempDir, "level1", "level2", "level3")
		const filePath = path.join(deepDir, "deep-file.json")
		const data = { nested: "deeply" }

		// Verify none of the directories exist
		await expect(fs.access(path.join(tempDir, "level1"))).rejects.toThrow()

		// Write file
		await safeWriteJson(filePath, data)

		// Verify all directories were created
		await expect(fs.access(path.join(tempDir, "level1"))).resolves.toBeUndefined()
		await expect(fs.access(path.join(tempDir, "level1", "level2"))).resolves.toBeUndefined()
		await expect(fs.access(deepDir)).resolves.toBeUndefined()

		// Verify file was written
		const content = await readFileContent(filePath)
		expect(content).toEqual(data)
	})

	test("should handle directory creation permission errors", async () => {
		// fs.mkdir is already vi.fn() — use vi.mocked to avoid double-wrapping via vi.spyOn
		vi.mocked(fs.mkdir).mockImplementationOnce(async () => {
			const error = new Error("EACCES: permission denied") as any
			error.code = "EACCES"
			throw error
		})

		const subDir = path.join(tempDir, "forbidden-dir")
		const filePath = path.join(subDir, "file.json")
		const data = { test: "permission error" }

		// Should throw the permission error
		await expect(safeWriteJson(filePath, data)).rejects.toThrow("EACCES: permission denied")

		// Verify directory was not created
		await expect(fs.access(subDir)).rejects.toThrow()
	})

	test("should successfully write to a non-existent file in an existing directory", async () => {
		// Create directory but not the file
		const subDir = path.join(tempDir, "existing-dir")
		await fs.mkdir(subDir)

		const filePath = path.join(subDir, "new-file.json")
		const data = { fresh: "file" }

		// Verify file doesn't exist yet
		await expect(fs.access(filePath)).rejects.toThrow()

		// Write file
		await safeWriteJson(filePath, data)

		// Verify file was created with correct content
		const content = await readFileContent(filePath)
		expect(content).toEqual(data)
	})

	test("should handle failure when deleting tempBackupFilePath (filePath exists, all renames succeed)", async () => {
		const initialData = { message: "Initial content" }
		const newData = { message: "Successfully written new content" }

		// Overwrite the pre-created file with specific initial data
		await fsPromisesActuals.writeFile!(currentTestFilePath, JSON.stringify(initialData))

		// fs.unlink is already vi.fn() — use vi.mocked to avoid double-wrapping via vi.spyOn
		vi.mocked(fs.unlink).mockImplementationOnce(async () => {
			throw new Error("Failed to delete backup file")
		})

		// The write should succeed even if backup deletion fails
		await safeWriteJson(currentTestFilePath, newData)

		// Verify the new content was written successfully
		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual(newData)
	})

	// Test for best-effort backup deletion (the backup lifecycle now lives in safeWriteText)
	test("does not fail the write when backup deletion fails (orphaned backup is acceptable)", async () => {
		const initialData = { message: "Initial" }
		const newData = { message: "New" }

		await fsPromisesActuals.writeFile!(currentTestFilePath, JSON.stringify(initialData))

		// fs.unlink is already vi.fn() — use vi.mocked to avoid double-wrapping via vi.spyOn
		vi.mocked(fs.unlink).mockImplementation(async (filePath: any) => {
			if (filePath.toString().includes("safeWriteText.bak_")) {
				throw new Error("Backup deletion failed")
			}
			return fsPromisesActuals.unlink!(filePath)
		})

		// The write must still succeed: backup cleanup is best-effort inside
		// safeWriteText and never masks the committed content.
		await safeWriteJson(currentTestFilePath, newData)

		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual(newData)

		// The orphaned backup is still on disk because its deletion failed.
		const entries = await fs.readdir(tempDir)
		expect(entries.some((entry) => entry.includes("safeWriteText.bak_"))).toBe(true)

		vi.mocked(fs.unlink).mockRestore()
	})

	// The expected error message might need to change if the mock behaves differently.
	test("should handle failure when renaming tempNewFilePath to filePath (filePath initially exists)", async () => {
		// currentTestFilePath exists due to beforeEach.
		const initialData = { message: "Initial content" }
		const newData = { message: "New content" }

		await fsPromisesActuals.writeFile!(currentTestFilePath, JSON.stringify(initialData))

		// fs.rename is already vi.fn() — use vi.mocked to avoid double-wrapping via vi.spyOn.
		// Once-only so the override does not leak into later tests: the commit rename is
		// the only rename in this flow.
		vi.mocked(fs.rename).mockImplementationOnce(async () => {
			throw new Error("Rename failed")
		})

		await expect(safeWriteJson(currentTestFilePath, newData)).rejects.toThrow("Rename failed")

		// The file should be restored to its initial content
		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual(initialData)
	})

	test("should throw an error if an inter-process lock is already held for the filePath", async () => {
		vi.resetModules() // Clear module cache to ensure fresh imports for this test

		const data = { message: "test lock failure" }

		// Create a new file path for this specific test to avoid conflicts
		const lockTestFilePath = path.join(tempDir, "lock-test-file.json")
		await fs.writeFile(lockTestFilePath, JSON.stringify({ initial: "lock test content" }))

		vi.doMock("proper-lockfile", () => ({
			...vi.importActual("proper-lockfile"),
			lock: vi.fn().mockRejectedValueOnce(new Error("Failed to get lock.")),
		}))

		// Re-import safeWriteJson to use the mocked proper-lockfile
		const { safeWriteJson: mockedSafeWriteJson } = await import("../safeWriteJson")

		await expect(mockedSafeWriteJson(lockTestFilePath, data)).rejects.toThrow("Failed to get lock.")

		// Clean up
		await fs.unlink(lockTestFilePath).catch(() => {}) // Ignore errors if file doesn't exist
		vi.unmock("proper-lockfile") // Ensure the mock is removed after this test
	})
	test("should release lock even if an error occurs mid-operation", async () => {
		const data = { message: "test lock release on error" }

		// Mock createWriteStream to throw an error
		const createWriteStreamSpy = vi.spyOn(fsSyncActual, "createWriteStream")
		createWriteStreamSpy.mockImplementationOnce((_path: any, _options: any) => {
			const errorStream = new Writable() as any
			errorStream._write = (_chunk: any, _encoding: any, callback: any) => {
				callback(new Error("Stream write error"))
			}
			// Add missing WriteStream properties
			errorStream.close = vi.fn()
			errorStream.bytesWritten = 0
			errorStream.path = _path
			errorStream.pending = false
			return errorStream
		})

		// This should throw but still release the lock
		await expect(safeWriteJson(currentTestFilePath, data)).rejects.toThrow("Stream write error")

		// Reset the mock to allow the second call to work normally
		createWriteStreamSpy.mockRestore()

		// If the lock wasn't released, this second attempt would fail with a lock error
		// Instead, it should succeed (proving the lock was released)
		await expect(safeWriteJson(currentTestFilePath, data)).resolves.toBeUndefined()
	})

	test("should handle fs.access error that is not ENOENT", async () => {
		const data = { message: "access error test" }
		// fs.access is already vi.fn() — use vi.mocked to avoid double-wrapping via vi.spyOn
		vi.mocked(fs.access).mockImplementationOnce(async () => {
			const error = new Error("EACCES: permission denied") as any
			error.code = "EACCES"
			throw error
		})

		// Create a path that will trigger the access check
		const testPath = path.join(tempDir, "access-error-test.json")

		await expect(safeWriteJson(testPath, data)).rejects.toThrow("EACCES: permission denied")

		// Verify access was called
		expect(vi.mocked(fs.access)).toHaveBeenCalled()
	})

	// The backup is a copy taken before the commit, so a failed commit has nothing to
	// roll back: the target keeps its previous content and the copy is removed.
	test("a failed commit keeps the previous content at the target and removes the backup copy", async () => {
		const initialData = { message: "Initial, must survive a failed commit" }
		const newData = { message: "New content" }

		await fsPromisesActuals.writeFile!(currentTestFilePath, JSON.stringify(initialData))

		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {}) // Suppress console.error

		// fs.rename is already vi.fn() — use vi.mocked to avoid double-wrapping via vi.spyOn
		let renameCallCount = 0
		vi.mocked(fs.rename).mockImplementation(async (oldPath, newPath) => {
			renameCallCount++
			if (renameCallCount === 1) {
				// The commit rename fails; there is no rollback rename to fail.
				throw new Error("Primary rename failed")
			}
			return fsPromisesActuals.rename!(oldPath, newPath)
		})

		await expect(safeWriteJson(currentTestFilePath, newData)).rejects.toThrow("Primary rename failed")

		// Exactly one rename was attempted, and it was the commit.
		expect(renameCallCount).toBe(1)

		// The target never left its path, so the previous content is still what a
		// reader sees, and no orphaned backup copy is left behind either.
		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual(initialData)
		const entries = await fs.readdir(tempDir)
		expect(entries.some((entry) => entry.includes("safeWriteText.bak_"))).toBe(false)

		consoleErrorSpy.mockRestore()
	})

	// Merge option tests
	test("should merge incoming data with existing file content when merge callback is provided", async () => {
		const initial = { a: 1, b: 2 }
		await safeWriteJson(currentTestFilePath, initial)

		const incoming = { b: 3, c: 4 }
		await safeWriteJson(currentTestFilePath, incoming, {
			merge: (existing, data) => ({
				...(existing as Record<string, unknown>),
				...(data as Record<string, unknown>),
			}),
		})

		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual({ a: 1, b: 3, c: 4 })
	})

	test("should pass null to merge callback when file does not exist", async () => {
		const newFilePath = path.join(tempDir, "nonexistent.json")
		const mergeFn = vi.fn((existing, incoming) => incoming)

		await safeWriteJson(newFilePath, { value: 42 }, { merge: mergeFn })

		expect(mergeFn).toHaveBeenCalledWith(null, { value: 42 })
		const content = await readFileContent(newFilePath)
		expect(content).toEqual({ value: 42 })
	})

	test("should propagate non-ENOENT read errors during merge instead of silently losing data", async () => {
		const initial = { a: 1, b: 2 }
		await safeWriteJson(currentTestFilePath, initial)

		const eio = Object.assign(new Error("I/O error"), { code: "EIO" })
		vi.mocked(fs.readFile).mockRejectedValueOnce(eio)

		await expect(
			safeWriteJson(
				currentTestFilePath,
				{ b: 99 },
				{
					merge: (existing, incoming) => ({
						...(existing as Record<string, unknown>),
						...(incoming as Record<string, unknown>),
					}),
				},
			),
		).rejects.toThrow("I/O error")

		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual({ a: 1, b: 2 })
	})

	test("should treat corrupt JSON as null during merge", async () => {
		await fs.writeFile(currentTestFilePath, "not valid json", "utf8")

		const mergeFn = vi.fn((_existing, incoming) => incoming)
		await safeWriteJson(currentTestFilePath, { value: 1 }, { merge: mergeFn })

		expect(mergeFn).toHaveBeenCalledWith(null, { value: 1 })
		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual({ value: 1 })
	})

	test("should write incoming data directly when no merge callback is provided", async () => {
		const initial = { a: 1, b: 2 }
		await safeWriteJson(currentTestFilePath, initial)

		const replacement = { c: 3 }
		await safeWriteJson(currentTestFilePath, replacement)

		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual({ c: 3 })
	})

	// The commit rename targets the symlink referent. The staged temp file must
	// therefore be created beside the RESOLVED target — staging beside the link
	// would make the commit rename fail with EXDEV when the referent is on
	// another filesystem. (Real symlinks are unavailable in this CI lane, so the
	// resolution is simulated by mocking fs.realpath the same way.)
	test("stages the temp file beside the symlink referent and commits onto it", async () => {
		const referentDir = path.join(tempDir, "referent")
		const linkDir = path.join(tempDir, "link")
		await fs.mkdir(referentDir, { recursive: true })
		await fs.mkdir(linkDir, { recursive: true })
		// caller-visible path (the link) vs the resolved referent path
		const callerPath = path.join(linkDir, "test-file.json")
		const referentPath = path.join(referentDir, "test-file.json")
		// Seed the RESOLVED referent with real content (via the actual fs) so the
		// write exercises replacement of an EXISTING referent: the lock, the
		// backup, and the commit all target the resolved referent.
		await fsPromisesActuals.writeFile!(referentPath, JSON.stringify({ seed: true }))

		// Only the file resolves through the link; the directory is already canonical,
		// so the lock key is the referent rather than the alias directory + basename.
		vi.spyOn(fs, "realpath").mockImplementation(async (target) =>
			target === callerPath ? referentPath : String(target),
		)

		await safeWriteJson(callerPath, { after: true })

		// the temp file was created next to the resolved referent, NOT beside the link
		const tempPaths = vi.mocked(fsSyncActual.createWriteStream).mock.calls.map((call) => String(call[0]))
		expect(tempPaths.some((p) => p.startsWith(referentDir + path.sep) && p.includes(".new_"))).toBe(true)
		expect(tempPaths.some((p) => p.startsWith(linkDir + path.sep))).toBe(false)

		// the content was committed onto the referent
		expect(await readFileContent(referentPath)).toEqual({ after: true })
	})

	// proper-lockfile with realpath:false keys the lock by the given path, so a
	// symlink alias and its referent must coordinate through ONE lock on the
	// resolved referent — otherwise a concurrent merge through both aliases
	// reads the same JSON and overwrites one update. (Real symlinks are
	// unavailable in this CI lane, so the resolution is simulated by mocking
	// fs.realpath, the same way as the staging test above.)
	test("acquires the lock on the resolved referent, not the caller alias", async () => {
		vi.resetModules() // fresh module instances so the doMock below is picked up

		const referentDir = path.join(tempDir, "lock-referent")
		const linkDir = path.join(tempDir, "lock-link")
		await fs.mkdir(referentDir, { recursive: true })
		await fs.mkdir(linkDir, { recursive: true })
		// caller-visible path (the link) vs the resolved referent path
		const callerPath = path.join(linkDir, "locked.json")
		const referentPath = path.join(referentDir, "locked.json")
		await fsPromisesActuals.writeFile!(referentPath, JSON.stringify({ seed: 1 }))

		// Only the file resolves through the link; the directory is already canonical,
		// so the lock key is the referent rather than the alias directory + basename.
		const realpathSpy = vi
			.spyOn(fs, "realpath")
			.mockImplementation(async (target) => (target === callerPath ? referentPath : String(target)))

		// Wrap the real lock in a capturing mock, and drive the two rare error paths
		// (the onCompromised callback and a failing release) so they stay covered
		// without real lockfile staleness. The callback rethrows by design, so
		// the mock swallows that throw and lets the real lock proceed.
		const realLockfile = await vi.importActual<typeof import("proper-lockfile")>("proper-lockfile")
		const lockMockFn = vi.fn(
			async (
				file: Parameters<typeof realLockfile.lock>[0],
				options?: Parameters<typeof realLockfile.lock>[1],
			) => {
				try {
					options?.onCompromised?.(new Error("lock compromised (test)"))
				} catch {
					// onCompromised rethrows by design; swallow so the real lock proceeds.
				}
				const release = await realLockfile.lock(file, options)
				return async () => {
					await release()
					throw new Error("release failed (test)")
				}
			},
		)
		const lockMock = lockMockFn as unknown as typeof realLockfile.lock
		vi.doMock("proper-lockfile", () => ({
			...realLockfile,
			lock: lockMock,
		}))

		// Re-import safeWriteJson so it picks up the mocked proper-lockfile.
		const { safeWriteJson: mockedSafeWriteJson } = await import("../safeWriteJson")

		const mergeFn = vi.fn((existing: unknown, incoming: unknown) => ({
			...(existing as Record<string, unknown>),
			...(incoming as Record<string, unknown>),
		}))

		// Capture the compromise + release-failure logs.
		const consoleErrorSpy = vi.spyOn(console, "error")
		try {
			await mockedSafeWriteJson(callerPath, { added: true }, { merge: mergeFn })

			// The lock was keyed by the resolved referent — every alias shares it.
			expect(lockMock).toHaveBeenCalledTimes(1)
			expect(String(lockMockFn.mock.calls[0][0])).toBe(referentPath)
			// The merge read the referent's content through that single lock.
			expect(mergeFn).toHaveBeenCalledWith({ seed: 1 }, { added: true })
			expect(await readFileContent(referentPath)).toEqual({ seed: 1, added: true })
			// The compromise callback and the failed release were logged, not thrown.
			expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("was compromised"), expect.any(Error))
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining("Failed to release lock"),
				expect.any(Error),
			)
		} finally {
			// Cleanup must run even when an assertion fails: a leaked mock
			// registration or console spy changes later tests, and vi.unmock
			// alone does not reset a module that already imported the mock.
			realpathSpy.mockRestore()
			vi.unmock("proper-lockfile")
			vi.resetModules()
			consoleErrorSpy.mockRestore()
		}
	})

	// CWE-732 regression: safeWriteJson stages the temp itself and passes it
	// via tempPath, so safeWriteText must apply the existing target's mode to
	// the staged temp before the atomic rename — otherwise a 0o600 target is
	// published as 0o644. POSIX-only assertion (Windows ignores POSIX modes).
	test("rejects a confined write whose target is outside the confined directory", async () => {
		const scope = path.join(tempDir, "project")
		await fs.mkdir(scope)
		const outside = path.join(tempDir, "elsewhere.json")

		// No symlink needed: the check runs on the resolved publish target, so an
		// out-of-scope path is rejected on every platform, and it is rejected before the
		// lock is taken and before anything is staged.
		await expect(safeWriteJson(outside, { mcpServers: {} }, { confineTo: scope })).rejects.toThrow(
			ConfinedPathEscapeError,
		)

		const left = await fs.readdir(tempDir)
		expect(left).not.toContain("elsewhere.json")
		expect(left.filter((entry) => entry.includes(".new_") || entry.endsWith(".lock"))).toEqual([])
	})

	test.skipIf(process.platform === "win32")(
		"rejects a confined write whose symlink resolves outside the confined directory",
		async () => {
			const projectDir = path.join(tempDir, "project")
			await fs.mkdir(projectDir)
			const outside = path.join(tempDir, "outside.json")
			await fsSyncActual.promises.writeFile(outside, JSON.stringify({ secret: "original" }), "utf8")
			// A repository that plants its project settings file as a link to somewhere else
			// must not receive the settings write at the linked path. The caller picked
			// projectDir/mcp.json from the workspace, so it declares that scope.
			const projectConfig = path.join(projectDir, "mcp.json")
			await fs.symlink(outside, projectConfig)

			await expect(
				safeWriteJson(projectConfig, { mcpServers: {} }, { confineTo: projectDir }),
			).rejects.toThrow(ConfinedPathEscapeError)

			// The linked file is untouched and nothing was staged beside it.
			expect(JSON.parse(await fsSyncActual.promises.readFile(outside, "utf8"))).toEqual({ secret: "original" })
			const entries = await fs.readdir(tempDir)
			expect(entries).toContain("outside.json")
			expect(
				entries.filter((entry) => entry.includes(".new_") || entry.includes("safeWriteText") || entry.endsWith(".lock")),
			).toEqual([])
		},
	)

	test.skipIf(process.platform === "win32")(
		"confines a write whose symlink referent stays inside the confined directory",
		async () => {
			const projectDir = path.join(tempDir, "project-in")
			await fs.mkdir(projectDir)
			const referent = path.join(projectDir, "real-mcp.json")
			await fsSyncActual.promises.writeFile(referent, JSON.stringify({ mcpServers: {} }), "utf8")
			const alias = path.join(projectDir, "mcp.json")
			await fs.symlink(referent, alias)

			// Confining is about the scope, not about forbidding links: a link that stays
			// inside the project still publishes to its referent.
			await safeWriteJson(alias, { mcpServers: { local: { url: "http://localhost" } } }, { confineTo: projectDir })

			expect(JSON.parse(await fsSyncActual.promises.readFile(referent, "utf8"))).toEqual({
				mcpServers: { local: { url: "http://localhost" } },
			})
		},
	)

	test.skipIf(process.platform === "win32")(
		"refuses a confined write whose link is swapped after the confinement check",
		async () => {
			// The race the under-lock confinement check cannot see on its own: the link is
			// inside the scope when the check runs, and a local process repoints it outside
			// before the commit. The merge callback runs under the lock, after the check and
			// before anything is staged, so it stands in for that process deterministically.
			const projectDir = path.join(tempDir, "project-race")
			await fs.mkdir(projectDir)
			const inside = path.join(projectDir, "inside.json")
			await fsSyncActual.promises.writeFile(inside, JSON.stringify({ mcpServers: {} }), "utf8")
			const outside = path.join(tempDir, "outside-race.json")
			await fsSyncActual.promises.writeFile(outside, JSON.stringify({ secret: "original" }), "utf8")
			const projectConfig = path.join(projectDir, "mcp.json")
			await fs.symlink(inside, projectConfig)

			await expect(
				safeWriteJson(
					projectConfig,
					{ mcpServers: { swapped: { url: "http://localhost" } } },
					{
						confineTo: projectDir,
						merge: (existing) => {
							// Same name, different referent: exactly what the check above
							// cannot observe after it has run.
							fsSyncActual.unlinkSync(projectConfig)
							fsSyncActual.symlinkSync(outside, projectConfig)
							return existing
						},
					},
				),
			).rejects.toThrow(TargetMovedError)

			// Neither the new referent nor the original one was written, and no staging or
			// lock artifact survives in either directory.
			expect(JSON.parse(await fsSyncActual.promises.readFile(outside, "utf8"))).toEqual({ secret: "original" })
			expect(JSON.parse(await fsSyncActual.promises.readFile(inside, "utf8"))).toEqual({ mcpServers: {} })
			for (const dir of [tempDir, projectDir]) {
				const entries = await fs.readdir(dir)
				expect(
					entries.filter(
						(entry) => entry.includes(".new_") || entry.includes("safeWriteText") || entry.endsWith(".lock"),
					),
				).toEqual([])
			}
		},
	)

	test.skipIf(process.platform === "win32")(
		"confines a scope path that itself runs through a symlink and does not exist yet",
		async () => {
			const real = path.join(tempDir, "real-project")
			await fs.mkdir(real)
			const alias = path.join(tempDir, "alias-project")
			await fs.symlink(real, alias)
			// The scope is declared through the alias, and the directory it names does not
			// exist yet. Resolving it lexically would compare an unresolved scope against a
			// fully resolved target and reject a write that is in fact inside the project -
			// the macOS /var -> /private/var shape. The nearest existing ancestor is resolved
			// and the remainder re-joined instead.
			const nested = path.join(alias, "nested")
			const target = path.join(nested, "mcp.json")

			await safeWriteJson(target, { mcpServers: {} }, { confineTo: nested })

			expect(
				JSON.parse(await fsSyncActual.promises.readFile(path.join(real, "nested", "mcp.json"), "utf8")),
			).toEqual({ mcpServers: {} })
		},
	)

	test.skipIf(process.platform === "win32")(
		"preserves a restrictive 0o600 target mode through the atomic publish",
		async () => {
			await fsPromisesActuals.writeFile!(currentTestFilePath, JSON.stringify({ before: true }))
			fsSyncActual.chmodSync(currentTestFilePath, 0o600)

			await safeWriteJson(currentTestFilePath, { after: true })

			expect(fsSyncActual.statSync(currentTestFilePath).mode & 0o777).toBe(0o600)
			expect(await readFileContent(currentTestFilePath)).toEqual({ after: true })
		},
	)

	// Ordering matters for the security guarantee: proper-lockfile creates
	// ${lockKey}.lock beside the lock key, and the key is the symlink referent. If
	// confinement were checked only after the lock, an out-of-scope target would first
	// create a lock directory outside the scope. A lock mock that throws if reached
	// proves the check runs first. Written without symlinks so it runs on every lane.
	test("rejects an out-of-scope target before the advisory lock is taken", async () => {
		vi.resetModules()
		const projectDir = path.join(tempDir, "order-project-plain")
		await fs.mkdir(projectDir)
		const outside = path.join(tempDir, "order-outside-plain.json")

		const realLockfile = await vi.importActual<typeof import("proper-lockfile")>("proper-lockfile")
		const lockMockFn = vi.fn(async () => {
			throw new Error("lock taken for an out-of-scope target (test)")
		})
		vi.doMock("proper-lockfile", () => ({ ...realLockfile, lock: lockMockFn }))
		const { safeWriteJson: lockedSafeWriteJson } = await import("../safeWriteJson")

		try {
			await expect(lockedSafeWriteJson(outside, { mcpServers: {} }, { confineTo: projectDir })).rejects.toThrow(
				/resolves outside the confined directory/,
			)
			expect(lockMockFn).not.toHaveBeenCalled()
			const entries = await fs.readdir(tempDir)
			expect(entries.filter((entry) => entry.endsWith(".lock") || entry.includes(".new_"))).toEqual([])
		} finally {
			vi.doUnmock("proper-lockfile")
			vi.resetModules()
		}
	})

	// The symlink cases above only run where symlinks can be created, so the wiring
	// itself is pinned here, on every lane: the confinement decision has to reach the
	// publish primitive, or the checks above protect a path the commit no longer uses.
	test("pins the confined target and its directory identities onto the publish", async () => {
		vi.resetModules()
		const projectDir = path.join(tempDir, "pin-project")
		const nested = path.join(projectDir, "nested")
		await fs.mkdir(projectDir)
		await fs.mkdir(nested)
		const target = path.join(nested, "mcp.json")

		const real = await vi.importActual<typeof import("../../services/file-safety/safeWriteText")>(
			"../../services/file-safety/safeWriteText",
		)
		// Typed parameters so the recorded call's options are readable without a cast.
		const publishSpy = vi.fn(async (_target: string, _content: string, options?: Record<string, unknown>) => {})
		vi.doMock("../../services/file-safety/safeWriteText", () => ({ ...real, safeWriteText: publishSpy }))
		const { safeWriteJson: pinnedSafeWriteJson } = await import("../safeWriteJson")

		try {
			await pinnedSafeWriteJson(target, { mcpServers: {} }, { confineTo: projectDir })

			expect(publishSpy).toHaveBeenCalledTimes(1)
			const options = publishSpy.mock.calls[0][2] as Record<string, unknown>
			// The exact path the scope check authorized...
			expect(options.expectedResolvedPath).toBe(path.join(await fs.realpath(nested), "mcp.json"))
			// ...and the identity of every directory that check walked through, from the
			// scope root down to the target's parent.
			const ancestors = options.expectedAncestorIdentities as { dir: string; dev: bigint; ino: bigint }[]
			const pinnedDirs = ancestors.map((entry) => entry.dir)
			expect(pinnedDirs).toEqual([await fs.realpath(projectDir), await fs.realpath(nested)])
			for (const entry of ancestors) {
				const stat = await fs.stat(entry.dir, { bigint: true })
				expect(entry.dev).toBe(stat.dev)
				expect(entry.ino).toBe(stat.ino)
			}
		} finally {
			vi.doUnmock("../../services/file-safety/safeWriteText")
			vi.resetModules()
			// The publish was stubbed, so the staged temp file was never committed or
			// cleaned by it; remove it rather than leave it for a later test.
			const left = await fs.readdir(nested)
			await Promise.all(left.map((entry) => fs.unlink(path.join(nested, entry)).catch(() => {})))
		}
	})

	test("does not create the parent directory of an out-of-scope confined target", async () => {
		const projectDir = path.join(tempDir, "scope-dir-project")
		await fs.mkdir(projectDir)
		// The parent does not exist yet: the mkdir in safeWriteJson would create it -
		// a filesystem change outside confineTo - before the confinement check rejected
		// the write.
		const outside = path.join(tempDir, "scope-missing-parent", "nested.json")

		await expect(safeWriteJson(outside, { mcpServers: {} }, { confineTo: projectDir })).rejects.toThrow(
			/resolves outside the confined directory/,
		)

		const entries = await fs.readdir(tempDir)
		expect(entries).not.toContain("scope-missing-parent")
		expect(entries.filter((entry) => entry.endsWith(".lock") || entry.includes(".new_"))).toEqual([])
	})
})
