import * as fsSyncActual from "fs"
import { Writable } from "stream"
import * as path from "path"
import * as os from "os"

import { safeWriteJson } from "../safeWriteJson"

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
	mockedFs.copyFile = vi.fn(actual.copyFile)
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
		// Reset implementations between tests: a mockImplementation set by one test keeps its
		// closure counter into the next test, so a call-count based mock leaks across tests.
		vi.resetAllMocks()
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

	// Staging permissions
	test.skipIf(process.platform === "win32")(
		"stages the temp file with the existing target's mode instead of the process default",
		async () => {
			const target = path.join(tempDir, "private.json")
			await fs.writeFile(target, JSON.stringify({ initial: 1 }), { mode: 0o600 })
			await fs.chmod(target, 0o600)

			const streamCalls = vi.mocked(fsSyncActual.createWriteStream)
			streamCalls.mockClear()

			await safeWriteJson(target, { updated: 2 })

			const staged = streamCalls.mock.calls.find((call) => String(call[0]).includes(".new_"))
			expect(staged).toBeDefined()
			// createWriteStream defaults to 0o666 (& ~umask = 0o644). The staged file holds
			// the whole payload until the commit rename, so beside a 0o600 target it would
			// be readable by other local users for the duration of the write.
			expect(Number((staged![1] as { mode?: number } | undefined)?.mode)).toBe(0o600)
		},
	)

	test.skipIf(process.platform === "win32")(
		"stages with the target's own mode when it is the ordinary 0o644",
		async () => {
			const target = path.join(tempDir, "public.json")
			await fs.writeFile(target, JSON.stringify({ initial: 1 }), { mode: 0o644 })
			await fs.chmod(target, 0o644)

			const streamCalls = vi.mocked(fsSyncActual.createWriteStream)
			streamCalls.mockClear()

			await safeWriteJson(target, { updated: 2 })

			const staged = streamCalls.mock.calls.find((call) => String(call[0]).includes(".new_"))
			expect(staged).toBeDefined()
			// No widening and no narrowing: the staged file mirrors the target it replaces.
			expect(Number((staged![1] as { mode?: number } | undefined)?.mode)).toBe(0o644)
		},
	)

	test.skipIf(process.platform === "win32")(
		"keeps the staged file owner-writable when the target is read-only",
		async () => {
			const target = path.join(tempDir, "readonly.json")
			await fs.writeFile(target, JSON.stringify({ initial: 1 }))
			await fs.chmod(target, 0o400)

			const streamCalls = vi.mocked(fsSyncActual.createWriteStream)
			streamCalls.mockClear()

			// Mirroring the target mode verbatim would stage a 0o400 file, and safeWriteText
			// reopens the staged file with "r+" (before applying the target mode with
			// fchmod), so the write would fail with EACCES for an ordinary user.
			await safeWriteJson(target, { updated: 2 })

			const staged = streamCalls.mock.calls.find((call) => String(call[0]).includes(".new_"))
			expect(staged).toBeDefined()
			expect(Number((staged![1] as { mode?: number } | undefined)?.mode)).toBe(0o600)

			const written = JSON.parse(await fs.readFile(target, "utf8"))
			expect(written).toEqual({ updated: 2 })
			await fs.chmod(target, 0o600)
		},
	)

	test(
		"surfaces a stat failure other than ENOENT instead of staging with the default mode",
		async () => {
			const target = path.join(tempDir, "stat-fails.json")
			await fs.writeFile(target, JSON.stringify({ initial: 1 }))

			const streamCalls = vi.mocked(fsSyncActual.createWriteStream)
			streamCalls.mockClear()
			const statSpy = vi.spyOn(fsSyncActual, "statSync").mockImplementation(() => {
				throw Object.assign(new Error("EIO"), { code: "EIO" })
			})

			try {
				await expect(safeWriteJson(target, { updated: 2 })).rejects.toThrow(/EIO/)
				// The stat failure has to surface BEFORE anything is staged: a staged file
				// created with the wide default mode would sit beside a restrictive target
				// for the duration of the write. Asserting no stream call (not just no
				// leftover) is what pins the order - safeWriteText would also reject this
				// EIO later, which alone would pass without any staging-mode check.
				expect(streamCalls).not.toHaveBeenCalled()
				expect((await fs.readdir(tempDir)).filter((entry) => entry.includes(".new_"))).toEqual([])
			} finally {
				statSpy.mockRestore()
			}
		},
	)

	test.skipIf(process.platform === "win32")(
		"serializes a writer that reaches the file through a symlink with one that uses the referent",
		async () => {
			const referent = path.join(tempDir, "state.json")
			await fsSyncActual.promises.writeFile(referent, JSON.stringify({ a: 1 }), "utf8")
			const alias = path.join(tempDir, "alias.json")
			await fs.symlink(referent, alias)

			const merge = (existing: unknown, incoming: unknown) => ({
				...((existing ?? {}) as Record<string, unknown>),
				...((incoming ?? {}) as Record<string, unknown>),
			})

			// Hold the first writer's commit rename until the second writer has taken its
			// lock and read the target. Keyed on the caller's alias the two writers take
			// different lock files (.alias.json.lock vs state.json.lock), so the second
			// read-modify-write starts from the pre-write state and its update is lost.
			let proceed: () => void = () => {}
			const proceedGate = new Promise<void>((resolve) => {
				proceed = resolve
			})
			let reachedRename: () => void = () => {}
			const reachedFirstRename = new Promise<void>((resolve) => {
				reachedRename = resolve
			})
			vi.mocked(fs.rename).mockImplementationOnce(async (oldPath, newPath) => {
				reachedRename()
				await proceedGate
				return fsPromisesActuals.rename!(oldPath, newPath)
			})

			const throughAlias = safeWriteJson(alias, { b: 2 }, { merge })
			await reachedFirstRename
			const throughReferent = safeWriteJson(referent, { c: 3 }, { merge })
			// Let the second writer reach its lock attempt / read before the first commits.
			await new Promise((resolve) => setTimeout(resolve, 150))
			proceed()
			await Promise.all([throughAlias, throughReferent])

			expect(JSON.parse(await fsSyncActual.promises.readFile(referent, "utf8"))).toEqual({ a: 1, b: 2, c: 3 })
		},
	)

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

	test("does not copy the target before the commit: the rename is already atomic", async () => {
		const initialData = { message: "Initial content" }
		const newData = { message: "New content" }

		await fsPromisesActuals.writeFile!(currentTestFilePath, JSON.stringify(initialData))

		await safeWriteJson(currentTestFilePath, newData)

		// A backup copy would be a full extra read+write of the old file on every
		// persistence step, and nothing restores from it: the commit is one rename,
		// so the target is intact until it lands.
		expect(fs.copyFile).not.toHaveBeenCalled()

		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual(newData)
	})

	test("a failed publish leaves the target in place because the backup is a copy", async () => {
		const initialData = { message: "Initial content, should be restored" }
		const newData = { message: "New content" }

		// Overwrite the pre-created file with specific initial data
		await fsPromisesActuals.writeFile!(currentTestFilePath, JSON.stringify(initialData))

		// The backup is a copy, so the only rename is the publish.
		vi.mocked(fs.rename).mockImplementationOnce(async () => {
			throw new Error("Rename from temp to final failed")
		})
		await expect(safeWriteJson(currentTestFilePath, newData)).rejects.toThrow("Rename from temp to final failed")

		// The target was never moved, so it still holds the initial content.
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

	// Removed with the backup option: safeWriteJson no longer takes a backup copy,
	// so there is no orphaned backup to tolerate here. The equivalent coverage of
	// best-effort backup cleanup lives in safeWriteText.spec.ts.

	// The expected error message might need to change if the mock behaves differently.
	test("should handle failure when renaming tempNewFilePath to filePath (filePath initially exists)", async () => {
		// currentTestFilePath exists due to beforeEach.
		const initialData = { message: "Initial content" }
		const newData = { message: "New content" }

		await fsPromisesActuals.writeFile!(currentTestFilePath, JSON.stringify(initialData))

		// fs.rename is already vi.fn() — use vi.mocked to avoid double-wrapping via vi.spyOn
		let renameCallCount = 0
		vi.mocked(fs.rename).mockImplementation(async (oldPath, newPath) => {
			renameCallCount++
			if (renameCallCount === 1) {
				// The only rename is the publish (temp -> filePath).
				throw new Error("Rename failed")
			}
			// For all other calls, use the original implementation
			return fsPromisesActuals.rename!(oldPath, newPath)
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

	// The publish is a single rename: a failed commit must leave the target intact
	// and must not leak the staged file.
	test("propagates the publish failure and removes the staged .new_ file", async () => {
		const initialData = { message: "Initial, must survive a failed publish" }
		const newData = { message: "New content" }

		await fsPromisesActuals.writeFile!(currentTestFilePath, JSON.stringify(initialData))

		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {}) // Suppress console.error

		// fs.rename is already vi.fn() — use vi.mocked to avoid double-wrapping via vi.spyOn
		// The only rename is the publish, so failing it is the failed-publish case.
		vi.mocked(fs.rename).mockImplementationOnce(async () => {
			throw new Error("Primary rename failed")
		})

		// The original error must propagate, not the cleanup error
		await expect(safeWriteJson(currentTestFilePath, newData)).rejects.toThrow("Primary rename failed")

		expect(await fileExists(currentTestFilePath)).toBe(true)

		// This is the caller-supplied staged path, so it is the file that leaks when the
		// caller's cleanup misses it; safeWriteText's own failure test only covers the
		// temp path it generates itself.
		const entries = await fs.readdir(tempDir)
		expect(entries.some((entry) => entry.includes(".new_"))).toBe(false)

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
		// write exercises replacement of an EXISTING referent: the lock is
		// acquired on the caller path (realpath:false, which may be absent) while
		// the backup + commit happen on the referent.
		await fsPromisesActuals.writeFile!(referentPath, JSON.stringify({ seed: true }))

		vi.spyOn(fs, "realpath").mockResolvedValue(referentPath)

		await safeWriteJson(callerPath, { after: true })

		// the temp file was created next to the resolved referent, NOT beside the link
		const tempPaths = vi.mocked(fsSyncActual.createWriteStream).mock.calls.map((call) => String(call[0]))
		expect(tempPaths.some((p) => p.startsWith(referentDir + path.sep) && p.includes(".new_"))).toBe(true)
		expect(tempPaths.some((p) => p.startsWith(linkDir + path.sep))).toBe(false)

		// the content was committed onto the referent
		expect(await readFileContent(referentPath)).toEqual({ after: true })
	})

	// CWE-732 regression: safeWriteJson stages the temp itself and passes it
	// via tempPath, so safeWriteText must apply the existing target's mode to
	// the staged temp before the atomic rename — otherwise a 0o600 target is
	// published as 0o644. POSIX-only assertion (Windows ignores POSIX modes).
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
})
