import * as fsSyncActual from "fs"
import { Writable } from "stream"
import * as path from "path"
import * as os from "os"

import { safeWriteJson } from "../safeWriteJson"

// Capture actual implementations before the vi.mock factory runs,
// so they are never wrapped by vi.fn() ? avoids infinite recursion when
// test mockImplementation callbacks delegate to the real implementation.
const fsPromisesActuals = vi.hoisted(() => ({
	rename: undefined as (typeof import("fs/promises"))["rename"] | undefined,
	unlink: undefined as (typeof import("fs/promises"))["unlink"] | undefined,
	writeFile: undefined as (typeof import("fs/promises"))["writeFile"] | undefined,
}))

// The sync open is captured the same way: the staging rows below spy fs.openSync to inspect
// or refuse the exclusive create, and a spy that delegated to the spied binding would recurse
// instead of opening the file.
const fsSyncActuals = vi.hoisted(() => ({
	openSync: undefined as (typeof import("fs"))["openSync"] | undefined,
}))

vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	fsPromisesActuals.rename = actual.rename
	fsPromisesActuals.unlink = actual.unlink
	fsPromisesActuals.writeFile = actual.writeFile
	// Start with all actual implementations.
	const mockedFs = {
		...actual,
		writeFile: vi.fn(actual.writeFile),
		readFile: vi.fn(actual.readFile),
		rename: vi.fn(actual.rename),
		unlink: vi.fn(actual.unlink),
		access: vi.fn(actual.access),
		stat: vi.fn(actual.stat),
		open: vi.fn(actual.open),
		mkdtemp: vi.fn(actual.mkdtemp),
		rm: vi.fn(actual.rm),
		readdir: vi.fn(actual.readdir),
		mkdir: vi.fn(actual.mkdir),
	}
	// fs.lstat is available via { ...actual }

	return mockedFs
})

// Mock the 'fs' module for fsSync.createWriteStream
vi.mock("fs", async () => {
	const actualFs = await vi.importActual<typeof import("fs")>("fs")
	// The staging rows spy fs.openSync and delegate through this captured real open,
	// so a spy never recurses into its own binding.
	fsSyncActuals.openSync = actualFs.openSync

	return {
		...actualFs, // Spread actual implementations
		createWriteStream: vi.fn(actualFs.createWriteStream), // Default to actual, but mockable
	}
})

import * as fs from "fs/promises" // This will now be the mocked version

/** One recorded fs.openSync of a staging file. */
interface StageOpen {
	path: string
	flags: string
	mode: number | undefined
}

function makeErrorWriteStream(message: string): fsSyncActual.WriteStream {
	const stream = Object.assign(
		new Writable({
			write(_chunk, _encoding, callback) {
				callback(new Error(message))
			},
		}),
		{ close: () => {}, bytesWritten: 0, path: "", pending: false },
	)

	// The double provides the Writable behavior and WriteStream properties consumed by the serializer.
	return stream as unknown as fsSyncActual.WriteStream
}

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
	async function readFileContent(filePath: string): Promise<unknown> {
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

		const mockErrorStream = makeErrorWriteStream("Write stream error")

		// Mock createWriteStream to return a stream that errors on write
		vi.mocked(fsSyncActual.createWriteStream).mockImplementationOnce(() => mockErrorStream)

		await expect(safeWriteJson(currentTestFilePath, data)).rejects.toThrow("Write stream error")

		// Verify the original file still exists and is unchanged
		const exists = await fileExists(currentTestFilePath)
		expect(exists).toBe(true)

		// Verify content is unchanged (should still have the initial content from beforeEach)
		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual({ initial: "content" })
	})

	test("should fall back to the two-step replacement when the commit rename fails with EPERM", async () => {
		const initialData = { message: "Initial content" }
		const newData = { message: "Windows-style EPERM replacement" }

		// Overwrite the pre-created file with specific initial data
		await fsPromisesActuals.writeFile!(currentTestFilePath, JSON.stringify(initialData))

		// fs.rename is already vi.fn() ? use vi.mocked to avoid double-wrapping via vi.spyOn
		// First call: the single-rename commit fails with the Windows-style EPERM
		// (a reader holds the target open). The fallback then renames the target
		// to a backup and the replacement into place, using real renames.
		vi.mocked(fs.rename).mockImplementationOnce(async () => {
			throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })
		})

		await safeWriteJson(currentTestFilePath, newData)

		// Verify the new content was committed by the fallback
		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual(newData)

		// Verify the fallback backup was cleaned up
		const leftovers = (await fs.readdir(tempDir)).filter((entry) => entry.includes(".bak_"))
		expect(leftovers).toEqual([])
	})

	test("should restore the committed file when the EPERM fallback's replacement rename fails", async () => {
		const initialData = { message: "Initial content, should be restored" }
		const newData = { message: "New content" }

		// Overwrite the pre-created file with specific initial data
		await fsPromisesActuals.writeFile!(currentTestFilePath, JSON.stringify(initialData))

		// Track rename calls
		let renameCallCount = 0

		// fs.rename is already vi.fn() ? use vi.mocked to avoid double-wrapping via vi.spyOn
		vi.mocked(fs.rename).mockImplementation(async (oldPath, newPath) => {
			renameCallCount++
			if (renameCallCount === 1) {
				// First call: the single-rename commit fails with EPERM, which
				// triggers the two-step fallback.
				throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })
			} else if (renameCallCount === 2) {
				// Second call: filePath -> tempBackupFilePath (fallback backup, succeeds)
				return fsPromisesActuals.rename!(oldPath, newPath)
			} else if (renameCallCount === 3) {
				// Third call: tempNewFilePath -> filePath (fallback replacement, fails)
				throw new Error("Fallback replacement rename failed")
			}
			// Fourth call: tempBackupFilePath -> filePath (rollback, succeeds)
			return fsPromisesActuals.rename!(oldPath, newPath)
		})

		await expect(safeWriteJson(currentTestFilePath, newData)).rejects.toThrow("Fallback replacement rename failed")

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
		// fs.mkdir is already vi.fn() ? use vi.mocked to avoid double-wrapping via vi.spyOn
		vi.mocked(fs.mkdir).mockImplementationOnce(async () => {
			const error = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
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

	test("should handle failure when deleting tempBackupFilePath (EPERM fallback, all renames succeed)", async () => {
		const initialData = { message: "Initial content" }
		const newData = { message: "Successfully written new content" }

		// Overwrite the pre-created file with specific initial data
		await fsPromisesActuals.writeFile!(currentTestFilePath, JSON.stringify(initialData))

		// Force the two-step fallback so a backup exists, then let its deletion fail
		vi.mocked(fs.rename).mockImplementationOnce(async () => {
			throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })
		})

		// fs.unlink is already vi.fn() ? use vi.mocked to avoid double-wrapping via vi.spyOn
		vi.mocked(fs.unlink).mockImplementationOnce(async () => {
			throw new Error("Failed to delete backup file")
		})

		// The write should succeed even if backup deletion fails
		await safeWriteJson(currentTestFilePath, newData)

		// Verify the new content was written successfully
		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual(newData)
	})

	// The json entry point's own half of the backup-deletion claim: the failure is reported,
	// not fatal, and the orphaned backup stays recoverable.
	test("should keep the committed content and the orphaned backup when backup deletion fails", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {}) // Suppress console.error
		const initialData = { message: "Initial" }
		const newData = { message: "New" }

		await fsPromisesActuals.writeFile!(currentTestFilePath, JSON.stringify(initialData))

		// Force the two-step fallback so a backup exists, then fail its deletion
		vi.mocked(fs.rename).mockImplementationOnce(async () => {
			throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })
		})

		// fs.unlink is already vi.fn() ? use vi.mocked to avoid double-wrapping via vi.spyOn
		vi.mocked(fs.unlink).mockImplementation(async (filePath) => {
			if (filePath.toString().includes(".bak_")) {
				throw new Error("Backup deletion failed")
			}
			return fsPromisesActuals.unlink!(filePath)
		})

		await safeWriteJson(currentTestFilePath, newData)

		// Verify console.error was called with the expected message
		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Successfully wrote"), expect.any(Error))

		// The claim the absent title made about json behaviour, asserted here at this entry
		// point instead of only at the text layer: the payload is committed, the backup that
		// could not be deleted survives with the pre-write content for a later writer to
		// recover, and no staging file is left behind.
		expect(await readFileContent(currentTestFilePath)).toEqual(newData)
		const orphanedBackups = (await fs.readdir(tempDir)).filter((entry) => entry.includes(".bak_"))
		expect(orphanedBackups).toHaveLength(1)
		expect(await readFileContent(path.join(tempDir, orphanedBackups[0]))).toEqual(initialData)
		expect((await fs.readdir(tempDir)).filter((entry) => entry.includes(".new_"))).toHaveLength(0)

		consoleErrorSpy.mockRestore()
		vi.mocked(fs.unlink).mockRestore()
	})

	// The expected error message might need to change if the mock behaves differently.
	test("should keep the committed file when the commit rename fails with a non-EPERM error", async () => {
		// currentTestFilePath exists due to beforeEach.
		const initialData = { message: "Initial content" }
		const newData = { message: "New content" }

		await fsPromisesActuals.writeFile!(currentTestFilePath, JSON.stringify(initialData))

		// fs.rename is already vi.fn() ? use vi.mocked to avoid double-wrapping via vi.spyOn
		vi.mocked(fs.rename).mockImplementationOnce(async () => {
			throw new Error("Rename failed")
		})

		await expect(safeWriteJson(currentTestFilePath, newData)).rejects.toThrow("Rename failed")

		// No backup is made on the single-rename path, and the committed file
		// keeps its previous content
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
		createWriteStreamSpy.mockImplementationOnce(() => makeErrorWriteStream("Stream write error"))

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
		// fs.access is already vi.fn() ? use vi.mocked to avoid double-wrapping via vi.spyOn
		vi.mocked(fs.access).mockImplementationOnce(async () => {
			const error = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
			throw error
		})

		// Create a path that will trigger the access check
		const testPath = path.join(tempDir, "access-error-test.json")

		await expect(safeWriteJson(testPath, data)).rejects.toThrow("EACCES: permission denied")

		// Verify access was called
		expect(vi.mocked(fs.access)).toHaveBeenCalled()
	})

	// Test for rollback failure scenario
	test("should log error and re-throw original if rollback fails", async () => {
		const initialData = { message: "Initial, preserved if rollback fails" }
		const newData = { message: "New content" }

		await fsPromisesActuals.writeFile!(currentTestFilePath, JSON.stringify(initialData))

		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {}) // Suppress console.error

		// fs.rename is already vi.fn() ? use vi.mocked to avoid double-wrapping via vi.spyOn
		let renameCallCount = 0
		vi.mocked(fs.rename).mockImplementation(async (oldPath, newPath) => {
			renameCallCount++
			if (renameCallCount === 1) {
				// First call: the single-rename commit fails with EPERM, which
				// triggers the two-step fallback.
				throw Object.assign(new Error("Primary rename failed"), { code: "EPERM" })
			} else if (renameCallCount === 2) {
				// Second call: filePath -> tempBackupFilePath (fallback backup, succeeds)
				return fsPromisesActuals.rename!(oldPath, newPath)
			} else if (renameCallCount === 3) {
				// Third call: tempNewFilePath -> filePath (fallback replacement, fails)
				throw new Error("Fallback replacement rename failed")
			} else if (renameCallCount === 4) {
				// Fourth call: tempBackupFilePath -> filePath (rollback, also fails)
				throw new Error("Rollback rename failed")
			}
			return fsPromisesActuals.rename!(oldPath, newPath)
		})

		// The fallback's replacement error rejects the write; the rollback error
		// is only logged.
		await expect(safeWriteJson(currentTestFilePath, newData)).rejects.toThrow("Fallback replacement rename failed")

		const backups = (await fs.readdir(tempDir)).filter((entry) => entry.includes(".bak_"))
		expect(backups).toHaveLength(1)
		expect(await readFileContent(path.join(tempDir, backups[0]))).toEqual(initialData)
		await safeWriteJson(currentTestFilePath, newData, {
			merge: (existing) => {
				expect(existing).toEqual(initialData)
				return newData
			},
		})

		// Verify console.error was called for the rollback failure
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Failed to restore backup"),
			expect.objectContaining({ message: "Rollback rename failed" }),
		)

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
		const mergeFn = vi.fn((_existing, incoming) => incoming)

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

	// Interrupted-write recovery tests
	it.each(["EMFILE", "EIO"])(
		"should preserve committed history when the recovery scan fails with %s",
		async (code) => {
			await fs.unlink(currentTestFilePath)
			const backupPath = path.join(tempDir, `.${path.basename(currentTestFilePath)}.bak_1_saved.tmp`)
			const committed = { history: ["saved"] }
			await fs.writeFile(backupPath, JSON.stringify(committed))
			const error = Object.assign(new Error("Recovery scan failed"), { code })
			vi.mocked(fs.readdir).mockRejectedValueOnce(error)
			const merge = vi.fn((existing: unknown) => existing)
			const trace = vi.fn()

			await expect(safeWriteJson(currentTestFilePath, {}, { merge, trace })).rejects.toBe(error)

			expect(merge).not.toHaveBeenCalled()
			expect(trace).toHaveBeenCalledExactlyOnceWith({ stage: "recover", detail: `failed:${code}` })
			expect(await readFileContent(backupPath)).toEqual(committed)
			await expect(fs.readFile(currentTestFilePath)).rejects.toMatchObject({ code: "ENOENT" })
			// Once the fault clears, a later merge still sees the committed state.
			await safeWriteJson(currentTestFilePath, {}, { merge })
			expect(merge).toHaveBeenCalledExactlyOnceWith(committed, {})
			expect(await readFileContent(currentTestFilePath)).toEqual(committed)
		},
	)

	test("should allow a write when the recovery directory scan reports ENOENT", async () => {
		vi.mocked(fs.readdir).mockRejectedValueOnce(Object.assign(new Error("Directory missing"), { code: "ENOENT" }))
		await safeWriteJson(currentTestFilePath, { saved: true })
		expect(await readFileContent(currentTestFilePath)).toEqual({ saved: true })
	})

	test("should restore an orphaned backup when the canonical path is missing after an interrupted write", async () => {
		const committedData = { message: "Committed before the interruption" }

		// Simulate the crash state of the two-step replacement: the target was
		// renamed to a backup, the replacement never landed, and the
		// replacement temp file was left behind. The canonical path is absent.
		await fsPromisesActuals.unlink!(currentTestFilePath)
		const backupPath = path.join(tempDir, `.${path.basename(currentTestFilePath)}.bak_1_abc.tmp`)
		const orphanedNewPath = path.join(tempDir, `.${path.basename(currentTestFilePath)}.new_1_def.tmp`)
		await fsPromisesActuals.writeFile!(backupPath, JSON.stringify(committedData))
		await fsPromisesActuals.writeFile!(orphanedNewPath, "{}")

		// A merge write must observe the restored committed content, not null.
		const incoming = { message: "New content" }
		let mergedWith: unknown
		await safeWriteJson(currentTestFilePath, incoming, {
			merge: (existing) => {
				mergedWith = existing
				return incoming
			},
		})

		expect(mergedWith).toEqual(committedData)
		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual(incoming)

		// The restored backup is consumed and the leftover replacement file is
		// garbage collected.
		const leftovers = (await fs.readdir(tempDir)).filter(
			(entry) => entry.includes(".new_") || entry.includes(".bak_"),
		)
		expect(leftovers).toEqual([])
	})

	it.each(["EACCES", "EIO", "EPERM", undefined])(
		"should preserve committed content when canonical access fails with %s",
		async (code) => {
			const backupPath = path.join(tempDir, `.${path.basename(currentTestFilePath)}.bak_1_stale.tmp`)
			await fs.writeFile(backupPath, JSON.stringify({ stale: true }))
			// Directory access succeeds; only the canonical-path check fails.
			const error = Object.assign(new Error("Canonical access failed"), { code })
			vi.mocked(fs.access).mockResolvedValueOnce(undefined).mockRejectedValueOnce(error)
			const merge = vi.fn((existing: unknown) => existing)
			const trace = vi.fn()

			await expect(safeWriteJson(currentTestFilePath, {}, { merge, trace })).rejects.toBe(error)

			expect(trace).toHaveBeenCalledExactlyOnceWith({ stage: "recover", detail: `failed:${code ?? "unknown"}` })
			expect(merge).not.toHaveBeenCalled()
			expect(await readFileContent(currentTestFilePath)).toEqual({ initial: "content" })
			expect(await readFileContent(backupPath)).toEqual({ stale: true })
		},
	)

	it.each(["ENOENT", "EACCES", "EIO"])(
		"should preserve backups when another backup stat fails with %s",
		async (code) => {
			await fs.unlink(currentTestFilePath)
			const unreadableBackup = path.join(tempDir, `.${path.basename(currentTestFilePath)}.bak_1_bad.tmp`)
			const readableBackup = path.join(tempDir, `.${path.basename(currentTestFilePath)}.bak_2_good.tmp`)
			await fs.writeFile(unreadableBackup, JSON.stringify({ stale: true }))
			await fs.writeFile(readableBackup, JSON.stringify({ committed: true }))
			const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
			vi.mocked(fs.stat).mockImplementation(async (backupPath) => {
				if (backupPath === unreadableBackup) {
					throw Object.assign(new Error("Backup stat failed"), { code })
				}
				return actual.stat(backupPath)
			})
			const merge = vi.fn((existing: unknown) => existing)

			if (code === "ENOENT") {
				await safeWriteJson(currentTestFilePath, {}, { merge })
				expect(merge).toHaveBeenCalledWith({ committed: true }, {})
			} else {
				await expect(safeWriteJson(currentTestFilePath, {}, { merge })).rejects.toMatchObject({ code })
				expect(merge).not.toHaveBeenCalled()
				expect(await readFileContent(unreadableBackup)).toEqual({ stale: true })
				expect(await readFileContent(readableBackup)).toEqual({ committed: true })
			}
		},
	)

	it.each(["rename", "stat"] as const)(
		"should abort recovery and preserve history when backup %s fails",
		async (operation) => {
			await fs.unlink(currentTestFilePath)
			const backupPath = path.join(tempDir, `.${path.basename(currentTestFilePath)}.bak_1_saved.tmp`)
			const committed = { history: ["saved"] }
			await fs.writeFile(backupPath, JSON.stringify(committed))
			const error = Object.assign(new Error("Recovery failed"), { code: "EACCES" })
			vi.mocked(fs[operation]).mockRejectedValueOnce(error)
			const merge = vi.fn()
			const trace = vi.fn()

			await expect(safeWriteJson(currentTestFilePath, {}, { merge, trace })).rejects.toBe(error)

			expect(trace).toHaveBeenCalledExactlyOnceWith({ stage: "recover", detail: "failed:EACCES" })
			expect(merge).not.toHaveBeenCalled()
			expect(await readFileContent(backupPath)).toEqual(committed)
			await expect(fs.readFile(currentTestFilePath)).rejects.toMatchObject({ code: "ENOENT" })
			await safeWriteJson(currentTestFilePath, {}, { merge: (existing) => existing })
			expect(await readFileContent(currentTestFilePath)).toEqual(committed)
		},
	)

	test("should restore by mtime and preserve unrelated siblings", async () => {
		await fs.unlink(currentTestFilePath)
		const prefix = `.${path.basename(currentTestFilePath)}`
		const newest = path.join(tempDir, `${prefix}.bak_1_newest.tmp`)
		const older = path.join(tempDir, `${prefix}.bak_9_older.tmp`)
		const unrelated = path.join(tempDir, ".other.json.bak_1_saved.tmp")
		const wrongSuffix = path.join(tempDir, `${prefix}.bak_1_saved.txt`)
		await fs.writeFile(newest, JSON.stringify({ newest: true }))
		await fs.writeFile(older, JSON.stringify({ older: true }))
		await fs.writeFile(unrelated, "keep")
		await fs.writeFile(wrongSuffix, "keep")
		await fs.utimes(older, new Date(1000), new Date(1000))
		await fs.utimes(newest, new Date(2000), new Date(2000))

		await safeWriteJson(currentTestFilePath, {}, { merge: (existing) => existing })

		expect(await readFileContent(currentTestFilePath)).toEqual({ newest: true })
		expect(await fs.readFile(unrelated, "utf8")).toBe("keep")
		expect(await fs.readFile(wrongSuffix, "utf8")).toBe("keep")
	})

	test("should open the replacement with write access for flushing", async () => {
		const open = vi.mocked(fs.open)
		open.mockClear()

		await safeWriteJson(currentTestFilePath, { flushed: true })

		expect(open).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(".new_"), "r+")
		expect(await readFileContent(currentTestFilePath)).toEqual({ flushed: true })
	})

	it.each([false, true])("should close the flush handle before commit when sync fails: %s", async (failSync) => {
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		const steps: string[] = []
		vi.mocked(fs.open).mockImplementation(async (filePath, flags) => {
			const handle = await actual.open(filePath, flags)
			const sync = handle.sync.bind(handle)
			const close = handle.close.bind(handle)
			vi.spyOn(handle, "sync").mockImplementation(async () => {
				steps.push("sync")
				if (failSync) throw Object.assign(new Error("Flush failed"), { code: "EIO" })
				await sync()
			})
			vi.spyOn(handle, "close").mockImplementation(async () => {
				steps.push("close")
				await close()
			})
			return handle
		})
		await safeWriteJson(currentTestFilePath, { saved: true }, { trace: ({ stage }) => steps.push(stage) })
		expect(steps).toEqual(["write-start", "sync", "close", "replacement-rename", "write-complete"])
		expect(await readFileContent(currentTestFilePath)).toEqual({ saved: true })
	})

	test("should garbage collect orphaned replacement files when the canonical path exists", async () => {
		const initialData = { message: "Initial content" }

		await fsPromisesActuals.writeFile!(currentTestFilePath, JSON.stringify(initialData))

		// Leftovers from an interrupted write whose commit rename never ran.
		const backupPath = path.join(tempDir, `.${path.basename(currentTestFilePath)}.bak_1_abc.tmp`)
		const orphanedNewPath = path.join(tempDir, `.${path.basename(currentTestFilePath)}.new_1_def.tmp`)
		await fsPromisesActuals.writeFile!(backupPath, JSON.stringify({ message: "stale backup" }))
		await fsPromisesActuals.writeFile!(orphanedNewPath, "{}")

		const newData = { message: "New content" }
		await safeWriteJson(currentTestFilePath, newData)

		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual(newData)

		const leftovers = (await fs.readdir(tempDir)).filter(
			(entry) => entry.includes(".new_") || entry.includes(".bak_"),
		)
		expect(leftovers).toEqual([])
	})

	test("should report replacement-protocol trace events when a trace callback is provided", async () => {
		const traceEvents: Array<{ stage: string; detail?: string }> = []
		const newData = { message: "traced write" }

		await safeWriteJson(currentTestFilePath, newData, {
			trace: (event) => traceEvents.push(event),
		})

		expect(traceEvents.map((event) => event.stage)).toEqual(["write-start", "replacement-rename", "write-complete"])
		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual(newData)
	})

	test("should trace the EPERM fallback backup rename", async () => {
		const traceEvents: Array<{ stage: string; detail?: string }> = []
		const initialData = { message: "Initial content" }
		const newData = { message: "Traced fallback write" }

		await fsPromisesActuals.writeFile!(currentTestFilePath, JSON.stringify(initialData))

		vi.mocked(fs.rename).mockImplementationOnce(async () => {
			throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })
		})

		await safeWriteJson(currentTestFilePath, newData, {
			trace: (event) => traceEvents.push(event),
		})

		expect(traceEvents.map((event) => event.stage)).toEqual([
			"write-start",
			"replacement-rename",
			"backup-rename",
			"replacement-rename",
			"write-complete",
		])
		expect(traceEvents.find((event) => event.stage === "backup-rename")?.detail).toBe("eperm-fallback")
		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual(newData)
	})
})

// Two guarded-write titles are deliberately absent from this file. The claims they name split
// in two, and where each half is tested is measured rather than asserted:

// The json-layer consequences are asserted in this file, at this entry point:
//   "should keep the committed content and the orphaned backup when backup deletion fails"
//     the write succeeds, the target holds the new payload, the .bak_ survives with the
//     pre-write content, and no .new_ staging file is left.
//   "should log error and re-throw original if rollback fails"
//     the original error rejects the write, the .bak_ survives with the pre-write content,
//     and a later write recovers it. Inherited from upstream main at bb6cbee59, not new here.

// What stays only at the text layer is that module's own taxonomy, which this file never
// claimed to cover and does not:
//   src/services/file-safety/__tests__/safeWriteText.spec.ts
//     "a post-commit backup cleanup failure is non-fatal: the target stays committed and no temp is left behind"
//     "throws RollbackFailedError with the backup path when the rollback rename also fails"
// The RollbackFailedError type and the .bak_ naming live in safeWriteText.ts; this entry
// point has its own backup protocol and never constructs that error.

describe("safeWriteJson guarded-publish requirements carried by the guarded-write branch", () => {
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
	async function readFileContent(filePath: string): Promise<unknown> {
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

	// The commit rename is no-follow for the final component: it targets the path the caller
	// named, so a link the caller never chose is REPLACED by the rename instead of receiving the
	// payload. Staging therefore happens beside the named path - the same directory the rename
	// lands in - which is also what keeps the rename on one volume. (Real symlinks are unavailable
	// in this CI lane, so the alias is simulated by mocking fs.realpath.)
	test("stages beside the caller-named path and never publishes through the symlink", async () => {
		const referentDir = path.join(tempDir, "referent")
		const linkDir = path.join(tempDir, "link")
		await fs.mkdir(referentDir, { recursive: true })
		await fs.mkdir(linkDir, { recursive: true })
		// caller-visible path (the link) vs the referent a resolution would hand back
		const callerPath = path.join(linkDir, "test-file.json")
		const referentPath = path.join(referentDir, "test-file.json")
		// Seed the referent with real content: if the publish followed the alias, this is what
		// would be replaced.
		await fsPromisesActuals.writeFile!(referentPath, JSON.stringify({ seed: true }))

		vi.spyOn(fs, "realpath").mockResolvedValue(referentPath)

		await safeWriteJson(callerPath, { after: true })

		// the temp file was created next to the named path, NOT beside the referent
		const tempPaths = vi.mocked(fsSyncActual.createWriteStream).mock.calls.map((call) => String(call[0]))
		expect(tempPaths.some((p) => p.startsWith(linkDir + path.sep) && p.includes(".new_"))).toBe(true)
		expect(tempPaths.some((p) => p.startsWith(referentDir + path.sep))).toBe(false)

		// the payload landed on the path the caller named; the referent is untouched
		expect(await readFileContent(callerPath)).toEqual({ after: true })
		expect(await readFileContent(referentPath)).toEqual({ seed: true })
	})

	// proper-lockfile with realpath:false keys the lock by the given path, so a
	// symlink alias and its referent must coordinate through ONE lock on the
	// resolved referent ? otherwise a concurrent merge through both aliases
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

		vi.spyOn(fs, "realpath").mockResolvedValue(referentPath)

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
		await mockedSafeWriteJson(callerPath, { added: true }, { merge: mergeFn })

		// The lock was keyed by the resolved referent ? every alias shares it.
		expect(lockMock).toHaveBeenCalledTimes(1)
		expect(String(lockMockFn.mock.calls[0][0])).toBe(referentPath)
		// The merge reads the path the caller named, not the referent: the publish is no-follow,
		// so the referent's content is never read or written through the alias.
		expect(mergeFn).toHaveBeenCalledTimes(1)
		expect(await readFileContent(callerPath)).toEqual({ added: true })
		expect(await readFileContent(referentPath)).toEqual({ seed: 1 })
		// The compromise callback and the failed release were logged, not thrown.
		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("was compromised"), expect.any(Error))
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Failed to release lock"),
			expect.any(Error),
		)

		// The hoisted vi.unmock runs before this test's runtime vi.doMock, so it
		// cannot remove it; doUnmock + resetModules clear the registry entry so
		// later test files import the real proper-lockfile.
		vi.doUnmock("proper-lockfile")
		vi.resetModules()
	})

	// The staged payload can carry API credentials, and the staging path is generated inside a
	// directory the workspace already controls. Two properties make writing into it safe: it is
	// opened exclusively, so a file another writer planted at the generated name fails the write
	// instead of receiving the payload, and it is created at the mode of the file it replaces, so
	// the commit rename can neither widen a 0o600 target nor narrow a shared one. The text writer
	// applies the same rule: src/services/file-safety/safeWriteText.ts stages at the target's mode
	// with 0o644 as the default for a target that does not exist yet.
	/** Record every open of a staging file made through fs.openSync, and pass each call to the
	 *  captured real open unless this row asked to be refused. */
	function spyOnStageOpens(refuseStagedOpens: boolean): StageOpen[] {
		const stageOpens: StageOpen[] = []
		const openSyncSpy = vi.spyOn(fsSyncActual, "openSync")
		openSyncSpy.mockImplementation((filePath, flags, mode) => {
			const openedPath = String(filePath)
			if (openedPath.includes(".new_")) {
				stageOpens.push({
					path: openedPath,
					flags: String(flags),
					mode: typeof mode === "number" ? mode : undefined,
				})
				if (refuseStagedOpens) {
					throw Object.assign(new Error("EEXIST: file already exists, open"), { code: "EEXIST" })
				}
			}
			return fsSyncActuals.openSync!(filePath, flags, mode)
		})
		return stageOpens
	}

	test("refuses to write into a staging path another writer already created", async () => {
		const stageOpens = spyOnStageOpens(true)
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		await expect(safeWriteJson(currentTestFilePath, { message: "New" })).rejects.toThrow("EEXIST")

		// The refusal happened at a generated staging path, under an exclusive create, and not at
		// the target: the committed file keeps its pre-write content and nothing is left behind.
		expect(stageOpens.length).toBeGreaterThan(0)
		expect(stageOpens.every((open) => open.flags === "wx")).toBe(true)
		expect(await readFileContent(currentTestFilePath)).toEqual({ initial: "content" })
		expect((await fs.readdir(tempDir)).filter((entry) => entry.includes(".new_"))).toHaveLength(0)

		consoleErrorSpy.mockRestore()
	})

	// The flush row asked that the stage be synchronised through the descriptor that wrote it
	// rather than only through a later reopen. This row measures exactly that hand: the fsync
	// call carries the descriptor the staging open returned, and it happens before that
	// descriptor is closed. Until the change the only synchronisation in the module was
	// _flushFileToDisk reopening the file with r+, which leaves this assertion unmatched.
	test("synchronises the stage on the descriptor that opened it before closing that descriptor", async () => {
		spyOnStageOpens(false)
		const fsyncSpy = vi.spyOn(fsSyncActual, "fsyncSync")
		const closeSpy = vi.spyOn(fsSyncActual, "closeSync")

		await safeWriteJson(currentTestFilePath, { message: "Synced" })

		const streamCall = vi.mocked(fsSyncActual.createWriteStream).mock.calls.at(-1)
		const stagedFd = Number((streamCall?.[1] as { fd?: number } | undefined)?.fd)
		expect(Number.isInteger(stagedFd)).toBe(true)
		expect(fsyncSpy.mock.calls.map((call) => Number(call[0]))).toContain(stagedFd)
		const syncOrder = fsyncSpy.mock.invocationCallOrder.at(0)
		const lastClose = closeSpy.mock.invocationCallOrder.at(-1)
		expect(syncOrder).toBeDefined()
		expect(lastClose).toBeDefined()
		expect(Number(syncOrder)).toBeLessThan(Number(lastClose))
		expect(await readFileContent(currentTestFilePath)).toEqual({ message: "Synced" })
	})

	// The row about the error-stream doubles asked that a failing stream not leave the staging
	// descriptor open. The doubles hand back a Writable that owns no descriptor, so the cleanup
	// has to come from the writer: the descriptor it opened for the stream is closed when the
	// stream fails, which is what the assertion below reads.
	test("closes the staging descriptor when the write stream fails", async () => {
		const stageOpens = spyOnStageOpens(false)
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const closeSpy = vi.spyOn(fsSyncActual, "closeSync")
		const openedFds: number[] = []
		const streamSpy = vi.mocked(fsSyncActual.createWriteStream)
		streamSpy.mockImplementationOnce((_streamPath, options) => {
			const fd = (options as { fd?: number } | undefined)?.fd
			if (typeof fd === "number") {
				openedFds.push(fd)
			}
			return makeErrorWriteStream("Stream failure before commit")
		})

		await expect(safeWriteJson(currentTestFilePath, { message: "Failed" })).rejects.toThrow(
			"Stream failure before commit",
		)

		expect(openedFds).toHaveLength(1)
		expect(closeSpy.mock.calls.map((call) => Number(call[0]))).toContain(openedFds[0])
		expect(stageOpens.length).toBeGreaterThan(0)
		expect(await readFileContent(currentTestFilePath)).toEqual({ initial: "content" })
		streamSpy.mockRestore()
		consoleErrorSpy.mockRestore()
	})

	// The catch around the staging-mode inspection has to fall back to the creation default only
	// for a target that is genuinely missing. The same file names ENOENT explicitly at every
	// other inspection site (the ancestor walk and the publication re-checks), and a permission
	// or I/O error says nothing about the target's mode, so taking the default would silently
	// widen or narrow it: the error has to propagate instead.
	test("propagates a staging-mode inspection error instead of taking the creation default", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const realStatSync = fsSyncActual.statSync
		// The double must reach the real stat for paths other than the target, and statSync's
		// overloads are not expressible through a delegate arrow, so the cast is the last resort.
		const statSpy = vi.spyOn(fsSyncActual, "statSync")
		statSpy.mockImplementation(((statPath: unknown) => {
			if (String(statPath) === currentTestFilePath) {
				throw Object.assign(new Error("EACCES: permission denied, stat"), { code: "EACCES" })
			}
			return realStatSync(String(statPath))
		}) as unknown as typeof fsSyncActual.statSync)

		await expect(safeWriteJson(currentTestFilePath, { message: "New" })).rejects.toThrow("EACCES")

		statSpy.mockRestore()
		expect(await readFileContent(currentTestFilePath)).toEqual({ initial: "content" })
		consoleErrorSpy.mockRestore()
	})

	test("stages the payload at the mode of the file it replaces", async () => {
		const targetMode = fsSyncActual.statSync(currentTestFilePath).mode & 0o777
		const stageOpens = spyOnStageOpens(false)

		await safeWriteJson(currentTestFilePath, { message: "New" })

		expect(stageOpens).toHaveLength(1)
		expect(stageOpens[0].flags).toBe("wx")
		expect(stageOpens[0].mode).toBe(targetMode)
		expect(await readFileContent(currentTestFilePath)).toEqual({ message: "New" })
	})

	test("keeps the creation default for a target that does not exist yet", async () => {
		const freshTarget = path.join(tempDir, "brand-new.json")
		const stageOpens = spyOnStageOpens(false)

		await safeWriteJson(freshTarget, { created: true })

		// A target that does not exist yet is staged at the 0o644 default, so the process umask
		// still decides what the published file becomes, exactly as it did before this change.
		expect(stageOpens).toHaveLength(1)
		expect(stageOpens[0].flags).toBe("wx")
		expect(stageOpens[0].mode).toBe(0o644)
		expect(await readFileContent(freshTarget)).toEqual({ created: true })
	})

	// The two alias rows above simulate the link by mocking fs.realpath. This one asks the platform
	// for a real link: a junction on Windows, which needs no elevation, and a directory symlink
	// elsewhere. Where the platform refuses, the row records the refusal instead of asserting a
	// resolution it never exercised.
	test("keys the lock to the referent of a real link, not to the alias the caller named", async () => {
		vi.resetModules()

		const referentDir = path.join(tempDir, "real-referent")
		const aliasDir = path.join(tempDir, "real-alias")
		await fs.mkdir(referentDir, { recursive: true })
		let linkRefusal: string | undefined
		try {
			await fs.symlink(referentDir, aliasDir, process.platform === "win32" ? "junction" : "dir")
		} catch (error: unknown) {
			linkRefusal =
				error && typeof error === "object" && "code" in error
					? String((error as { code?: string }).code)
					: "unknown"
		}
		if (linkRefusal !== undefined) {
			// Capability probe: a lane that cannot create the link says why rather than passing
			// a row that never resolved anything.
			expect(["EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"]).toContain(linkRefusal)
			return
		}

		const aliasFile = path.join(aliasDir, "locked.json")
		const referentFile = path.join(referentDir, "locked.json")
		await fsPromisesActuals.writeFile!(referentFile, JSON.stringify({ seed: 1 }))

		const realLockfile = await vi.importActual<typeof import("proper-lockfile")>("proper-lockfile")
		const lockMockFn = vi.fn(
			async (file: Parameters<typeof realLockfile.lock>[0], options?: Parameters<typeof realLockfile.lock>[1]) =>
				realLockfile.lock(file, options),
		)
		// The mock must be assignable to the module's lock signature; this is the same double
		// shape the alias row above uses.
		const lockMock = lockMockFn as unknown as typeof realLockfile.lock
		vi.doMock("proper-lockfile", () => ({ ...realLockfile, lock: lockMock }))

		const { safeWriteJson: realLinkSafeWriteJson } = await import("../safeWriteJson")
		const mergeFn = vi.fn((existing: unknown, incoming: unknown) => ({
			...(existing as Record<string, unknown>),
			...(incoming as Record<string, unknown>),
		}))
		await realLinkSafeWriteJson(aliasFile, { added: true }, { merge: mergeFn })

		// The link is the operating system's, so the resolution is not a mock's: the alias and the
		// referent are two names for one file, and both writers must contend on one lock.
		const resolvedReferent = await fs.realpath(aliasFile)
		expect(resolvedReferent).not.toBe(aliasFile)
		expect(lockMockFn).toHaveBeenCalledTimes(1)
		expect(String(lockMockFn.mock.calls[0][0])).toBe(resolvedReferent)
		// The merge read the seeded content through the alias, and the write landed on the same
		// file, seen from either name.
		expect(mergeFn.mock.calls[0][0]).toEqual({ seed: 1 })
		expect(await readFileContent(aliasFile)).toEqual({ seed: 1, added: true })
		expect(await readFileContent(referentFile)).toEqual({ seed: 1, added: true })

		// Measured on this box: removing the junction leaves the referent and its content.
		await fs.unlink(aliasDir)
		vi.doUnmock("proper-lockfile")
		vi.resetModules()
	})

	// A settings export carries API credentials, so it must not be redirected through
	// a link the user never chose. (Real symlinks are unavailable in this CI lane, so
	// the link is simulated by mocking fs.lstat.)
	test("refuses to publish through a symlink when refuseSymlinkTarget is set", async () => {
		const referentPath = path.join(tempDir, "refuse-referent.json")
		const linkPath = path.join(tempDir, "refuse-link.json")
		await fsPromisesActuals.writeFile!(referentPath, JSON.stringify({ seed: "untouched" }))

		vi.spyOn(fs, "lstat").mockResolvedValue({
			isSymbolicLink: () => true,
			// The guard reads only isSymbolicLink(), and a real Stats cannot be
			// produced for a simulated link in this CI lane, so the double is
			// asserted through unknown rather than stubbing every Stats field.
		} as unknown as fsSyncActual.Stats)

		await expect(safeWriteJson(linkPath, { leaked: true }, { refuseSymlinkTarget: true })).rejects.toThrow(
			/refusing to write through the symlink/,
		)

		vi.restoreAllMocks()
		// Nothing was resolved, staged, locked, or committed: the referent still holds
		// the content it had before the refused write.
		expect(await readFileContent(referentPath)).toEqual({ seed: "untouched" })
	})

	test("still writes a regular file when refuseSymlinkTarget is set", async () => {
		const target = path.join(tempDir, "refuse-regular.json")
		await safeWriteJson(target, { written: true }, { refuseSymlinkTarget: true })
		expect(await readFileContent(target)).toEqual({ written: true })
	})

	test("rejects when the destination is swapped for a link after the initial refusal check", async () => {
		const referentPath = path.join(tempDir, "swap-referent.json")
		const linkPath = path.join(tempDir, "swap-link.json")
		await fsPromisesActuals.writeFile!(referentPath, JSON.stringify({ seed: "untouched" }))
		await fsPromisesActuals.writeFile!(linkPath, JSON.stringify({ own: true }))
		const asLink = { isSymbolicLink: () => true } as unknown as fsSyncActual.Stats
		const asFile = { isSymbolicLink: () => false } as unknown as fsSyncActual.Stats
		// The first lstat (the refusal) sees a regular file; the re-check after
		// resolvePublishTarget sees the link a local writer installed in between.
		// Path-aware rather than call-order: the ancestor walk also calls lstat, so a
		// mockResolvedValueOnce chain would be consumed by the wrong component. The first look at
		// the target sees a regular file; the re-check after resolvePublishTarget sees the link.
		let targetLooks = 0
		vi.spyOn(fs, "lstat").mockImplementation(((p: unknown) => {
			if (String(p) === linkPath) {
				targetLooks++
				return Promise.resolve(targetLooks === 1 ? asFile : asLink)
			}
			return Promise.resolve(asFile)
		}) as unknown as typeof fs.lstat)

		await expect(safeWriteJson(linkPath, { leaked: true }, { refuseSymlinkTarget: true })).rejects.toThrow(
			/after resolution/,
		)

		vi.restoreAllMocks()
		expect(await readFileContent(referentPath)).toEqual({ seed: "untouched" })
	})

	test("rejects when the destination becomes a link before the commit is staged", async () => {
		const referentPath = path.join(tempDir, "late-referent.json")
		const linkPath = path.join(tempDir, "late-link.json")
		await fsPromisesActuals.writeFile!(referentPath, JSON.stringify({ seed: "untouched" }))
		await fsPromisesActuals.writeFile!(linkPath, JSON.stringify({ own: true }))
		const asLink = { isSymbolicLink: () => true } as unknown as fsSyncActual.Stats
		const asFile = { isSymbolicLink: () => false } as unknown as fsSyncActual.Stats
		// The swap happens after resolution and while the write is already under the
		// lock: the in-lock re-check must stop the commit rename.
		// Same path-aware scripting: the swap happens after resolution and while the write is
		// already under the lock, so the third look at the target is the one that must be a link.
		let lateLooks = 0
		vi.spyOn(fs, "lstat").mockImplementation(((p: unknown) => {
			if (String(p) === linkPath) {
				lateLooks++
				return Promise.resolve(lateLooks <= 2 ? asFile : asLink)
			}
			return Promise.resolve(asFile)
		}) as unknown as typeof fs.lstat)

		await expect(safeWriteJson(linkPath, { leaked: true }, { refuseSymlinkTarget: true })).rejects.toThrow(
			/before publication/,
		)

		vi.restoreAllMocks()
		expect(await readFileContent(referentPath)).toEqual({ seed: "untouched" })
	})

	test("publishes onto the named path when a link is planted during target resolution", async () => {
		const referentPath = path.join(tempDir, "race-referent.json")
		const namedPath = path.join(tempDir, "race-named.json")
		await fsPromisesActuals.writeFile!(referentPath, JSON.stringify({ seed: "untouched" }))
		await fsPromisesActuals.writeFile!(namedPath, JSON.stringify({ own: true }))
		const asFile = { isSymbolicLink: () => false } as unknown as fsSyncActual.Stats
		// Every lstat in the sequence sees a regular file: the link a local writer plants
		// while the destination is being resolved is gone again before the next check, so
		// no check in the sequence can catch it.
		vi.spyOn(fs, "lstat").mockResolvedValue(asFile)
		// Resolution is the step that would hand back a destination the caller never chose.
		const realpathSpy = vi.spyOn(fs, "realpath").mockResolvedValue(referentPath)

		await safeWriteJson(namedPath, { written: true }, { refuseSymlinkTarget: true })

		vi.restoreAllMocks()
		// With refuseSymlinkTarget the named path is the publish target, so resolution never
		// runs and there is no window in which a planted link can redirect the payload. The
		// commit is a rename, which replaces the named directory entry instead of writing
		// through a link, so the referent cannot receive the export.
		expect(realpathSpy).not.toHaveBeenCalled()
		expect(await readFileContent(namedPath)).toEqual({ written: true })
		expect(await readFileContent(referentPath)).toEqual({ seed: "untouched" })
	})

	test("resolves the publish target only once during a guarded publication", async () => {
		const target = path.join(tempDir, "single-resolve.json")
		// The caller resolves once for the lock key; safeWriteText must not resolve again,
		// or a link installed after the caller's re-check would be followed there.
		const realpath = vi.spyOn(fs, "realpath").mockImplementation(async (p) => String(p))

		await safeWriteJson(target, { written: true })

		expect(realpath).toHaveBeenCalledTimes(1)
		vi.restoreAllMocks()
		expect(await readFileContent(target)).toEqual({ written: true })
	})

	test("refuses a write when an ancestor directory is a symlink", async () => {
		const target = path.join(tempDir, "ancestor-link.json")
		await fsPromisesActuals.writeFile!(target, JSON.stringify({ own: true }))
		const asLink = { isSymbolicLink: () => true } as unknown as fsSyncActual.Stats
		const asFile = { isSymbolicLink: () => false } as unknown as fsSyncActual.Stats
		// The target itself looks ordinary; the link sits one directory above it. Checking only the
		// final component would publish a credential payload outside the directory the caller named.
		vi.spyOn(fs, "lstat").mockImplementation(((p: unknown) => {
			return Promise.resolve(String(p) === tempDir ? asLink : asFile)
		}) as unknown as typeof fs.lstat)

		await expect(safeWriteJson(target, { leaked: true }, { refuseSymlinkTarget: true })).rejects.toThrow(
			/is a symlink/,
		)

		vi.restoreAllMocks()
		expect(await readFileContent(target)).toEqual({ own: true })
	})

	// The initial walk and the commit rename are separated by the whole staging sequence, and
	// Node exposes no handle-relative rename: an ancestor that passed the walk can be swapped
	// while the payload is staged, and the path-based commit rename would follow it. The
	// publication therefore re-derives the final entry and every recorded ancestor identity
	// immediately before the commit rename. (Real symlinks are unavailable in this CI lane, so
	// the swap is simulated by scripting fs.lstat per visit, the same way as the tests above.)
	test("refuses the publish when an ancestor is swapped for a link after the initial walk", async () => {
		const parent = path.join(tempDir, "swap-parent")
		await fs.mkdir(parent, { recursive: true })
		const target = path.join(parent, "swap-ancestor.json")
		await fsPromisesActuals.writeFile!(target, JSON.stringify({ own: true }))
		// The guard reads isSymbolicLink plus the bigint identity, and a real BigIntStats cannot
		// be produced for a simulated directory in this CI lane, so the doubles are asserted
		// through unknown rather than stubbing every Stats field.
		const asDir = { isSymbolicLink: () => false, dev: 1n, ino: 1n } as unknown as fsSyncActual.BigIntStats
		const asLink = { isSymbolicLink: () => true, dev: 2n, ino: 2n } as unknown as fsSyncActual.BigIntStats
		// Path-aware scripting: the first look at the parent is the walk that authorizes it; the
		// next look happens inside the publication, where the swap must be caught.
		let parentLooks = 0
		vi.spyOn(fs, "lstat").mockImplementation(((p: unknown) => {
			if (String(p) === parent) {
				parentLooks++
				return Promise.resolve(parentLooks === 1 ? asDir : asLink)
			}
			return Promise.resolve(asDir)
		}) as unknown as typeof fs.lstat)

		await expect(safeWriteJson(target, { leaked: true }, { refuseSymlinkTarget: true })).rejects.toThrow(
			/is now a symlink/,
		)

		vi.restoreAllMocks()
		// The re-check ran (the walk saw the directory once, the publication once more), the
		// commit rename never happened, and the payload did not escape: the target still holds
		// its own content and the staged temp was discarded, not left beside it.
		expect(parentLooks).toBe(2)
		expect(await readFileContent(target)).toEqual({ own: true })
		expect(fsSyncActual.readdirSync(parent)).toEqual(["swap-ancestor.json"])
	})

	test("refuses the publish when an ancestor is replaced by a different directory", async () => {
		const parent = path.join(tempDir, "repl-parent")
		await fs.mkdir(parent, { recursive: true })
		const target = path.join(parent, "replaced-ancestor.json")
		await fsPromisesActuals.writeFile!(target, JSON.stringify({ own: true }))
		const asDir = { isSymbolicLink: () => false, dev: 1n, ino: 1n } as unknown as fsSyncActual.BigIntStats
		// The rename-away-and-recreate shape: the name is unchanged and the entry is still a
		// directory, so only the identity tells the two apart.
		const asOtherDir = { isSymbolicLink: () => false, dev: 9n, ino: 9n } as unknown as fsSyncActual.BigIntStats
		let parentLooks = 0
		vi.spyOn(fs, "lstat").mockImplementation(((p: unknown) => {
			if (String(p) === parent) {
				parentLooks++
				return Promise.resolve(parentLooks === 1 ? asDir : asOtherDir)
			}
			return Promise.resolve(asDir)
		}) as unknown as typeof fs.lstat)

		await expect(safeWriteJson(target, { leaked: true }, { refuseSymlinkTarget: true })).rejects.toThrow(
			/is no longer the directory that was checked/,
		)

		vi.restoreAllMocks()
		expect(parentLooks).toBe(2)
		expect(await readFileContent(target)).toEqual({ own: true })
		expect(fsSyncActual.readdirSync(parent)).toEqual(["replaced-ancestor.json"])
	})

	test("refuses the publish when an ancestor disappears before the commit", async () => {
		const parent = path.join(tempDir, "gone-parent")
		await fs.mkdir(parent, { recursive: true })
		const target = path.join(parent, "gone-ancestor.json")
		await fsPromisesActuals.writeFile!(target, JSON.stringify({ own: true }))
		const asDir = { isSymbolicLink: () => false, dev: 1n, ino: 1n } as unknown as fsSyncActual.BigIntStats
		// The walk authorizes the directory; by publication time it is gone, so a path-based
		// rename would resolve an ancestry nobody checked. The guard must fail closed.
		let parentLooks = 0
		vi.spyOn(fs, "lstat").mockImplementation(((p: unknown) => {
			if (String(p) === parent) {
				parentLooks++
				if (parentLooks === 1) return Promise.resolve(asDir)
				return Promise.reject(Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }))
			}
			return Promise.resolve(asDir)
		}) as unknown as typeof fs.lstat)

		await expect(safeWriteJson(target, { leaked: true }, { refuseSymlinkTarget: true })).rejects.toThrow(
			/no longer exists/,
		)

		vi.restoreAllMocks()
		expect(await readFileContent(target)).toEqual({ own: true })
		expect(fsSyncActual.readdirSync(parent)).toEqual(["gone-ancestor.json"])
	})

	test("fails closed when an ancestor re-check fails for a non-ENOENT reason", async () => {
		const parent = path.join(tempDir, "eacces-parent")
		await fs.mkdir(parent, { recursive: true })
		const target = path.join(parent, "eacces-ancestor.json")
		await fsPromisesActuals.writeFile!(target, JSON.stringify({ own: true }))
		const asDir = { isSymbolicLink: () => false, dev: 1n, ino: 1n } as unknown as fsSyncActual.BigIntStats
		const failure = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
		let parentLooks = 0
		vi.spyOn(fs, "lstat").mockImplementation(((p: unknown) => {
			if (String(p) === parent) {
				parentLooks++
				if (parentLooks === 1) return Promise.resolve(asDir)
				return Promise.reject(failure)
			}
			return Promise.resolve(asDir)
		}) as unknown as typeof fs.lstat)

		// A stat failure says nothing about whether the entry is safe: the original error
		// propagates instead of publishing blind.
		await expect(safeWriteJson(target, { leaked: true }, { refuseSymlinkTarget: true })).rejects.toThrow(/EACCES/)

		vi.restoreAllMocks()
		expect(await readFileContent(target)).toEqual({ own: true })
	})

	test("fails closed when the destination re-check fails with a non-ENOENT error", async () => {
		const parent = path.join(tempDir, "recheck-parent")
		await fs.mkdir(parent, { recursive: true })
		const target = path.join(parent, "recheck-eacces.json")
		const asDir = { isSymbolicLink: () => false, dev: 1n, ino: 1n } as unknown as fsSyncActual.BigIntStats
		const asFile = { isSymbolicLink: () => false } as unknown as fsSyncActual.Stats
		const failure = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
		// Only ENOENT means "nothing there that could be a link"; any other lstat failure says
		// nothing about the destination. The initial check passes and the pre-commit re-check
		// is the one that fails, so this covers the publication-time inspection specifically.
		let targetLooks = 0
		vi.spyOn(fs, "lstat").mockImplementation(((p: unknown) => {
			if (String(p) === target) {
				targetLooks++
				if (targetLooks >= 2) return Promise.reject(failure)
				return Promise.resolve(asFile)
			}
			return Promise.resolve(asDir)
		}) as unknown as typeof fs.lstat)

		await expect(safeWriteJson(target, { written: true }, { refuseSymlinkTarget: true })).rejects.toThrow(/EACCES/)

		vi.restoreAllMocks()
		// The pre-commit inspection ran (second look at the destination) and stopped the write.
		expect(targetLooks).toBe(2)
		expect(await fileExists(target)).toBe(false)
	})

	test("fails closed when the pre-commit publication inspection fails with a non-ENOENT error", async () => {
		const parent = path.join(tempDir, "publication-parent")
		await fs.mkdir(parent, { recursive: true })
		const target = path.join(parent, "publication-eacces.json")
		const asDir = { isSymbolicLink: () => false, dev: 1n, ino: 1n } as unknown as fsSyncActual.BigIntStats
		const asFile = { isSymbolicLink: () => false } as unknown as fsSyncActual.Stats
		const failure = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
		// The first two looks are the pre-staging destination checks; the third is the one the
		// publication takes immediately before the commit rename. Rejecting the second, as the
		// case above does, cannot show that a publication-time inspection error is honoured, so
		// this case rejects the third and keeps the earlier case standing beside it.
		let targetLooks = 0
		vi.spyOn(fs, "lstat").mockImplementation(((p: unknown) => {
			if (String(p) === target) {
				targetLooks++
				if (targetLooks >= 3) return Promise.reject(failure)
				return Promise.resolve(asFile)
			}
			return Promise.resolve(asDir)
		}) as unknown as typeof fs.lstat)

		await expect(safeWriteJson(target, { written: true }, { refuseSymlinkTarget: true })).rejects.toThrow("EACCES")

		vi.restoreAllMocks()
		// Three destination looks happened, so the failure came from the publication-time
		// inspection rather than an earlier check, and the commit never landed.
		expect(targetLooks).toBe(3)
		expect(await fileExists(target)).toBe(false)
	})

	test("does not take the EPERM two-step fallback when the pre-commit ancestry assertion rejects with EPERM", async () => {
		const parent = path.join(tempDir, "ancestry-eperm-parent")
		await fs.mkdir(parent, { recursive: true })
		const target = path.join(parent, "ancestry-eperm.json")
		// A committed destination is what makes the fallback observable: it renames the
		// target to a backup before the second rename, so a mistaken fallback moves a file
		// the inspection had just refused to publish over.
		await fsPromisesActuals.writeFile!(target, JSON.stringify({ committed: true }))
		const asDir = { isSymbolicLink: () => false, dev: 1n, ino: 1n } as unknown as fsSyncActual.BigIntStats
		const asFile = { isSymbolicLink: () => false } as unknown as fsSyncActual.Stats
		const failure = Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })
		// The third destination look is the one the publication takes immediately before
		// the commit rename, so this arms the ancestry assertion, not an earlier check.
		let targetLooks = 0
		vi.spyOn(fs, "lstat").mockImplementation(((p: unknown) => {
			if (String(p) === target) {
				targetLooks++
				if (targetLooks >= 3) return Promise.reject(failure)
				return Promise.resolve(asFile)
			}
			return Promise.resolve(asDir)
		}) as unknown as typeof fs.lstat)
		const trace = vi.fn()

		await expect(safeWriteJson(target, { fresh: true }, { refuseSymlinkTarget: true, trace })).rejects.toThrow(
			"EPERM",
		)

		vi.restoreAllMocks()
		// The inspection ran and refused. The committed destination is still there, byte for
		// byte, which is only true if the two-step replacement never started: an EPERM from an
		// inspection is not a rename collision and must not move anything.
		expect(targetLooks).toBe(3)
		expect(await readFileContent(target)).toEqual({ committed: true })
		expect(trace).not.toHaveBeenCalledWith(expect.objectContaining({ stage: "backup-rename" }))
	})

	test("fails closed when an ancestor vanishes during the authorizing walk", async () => {
		const parent = path.join(tempDir, "vanish-parent")
		await fs.mkdir(parent, { recursive: true })
		const target = path.join(parent, "vanish-during-walk.json")
		await fsPromisesActuals.writeFile!(target, JSON.stringify({ own: true }))
		const asFile = { isSymbolicLink: () => false } as unknown as fsSyncActual.Stats
		// A directory that vanishes mid-walk has no recorded identity for the pre-commit
		// re-check, so a path that reappears as a symlink before staging would be followed by
		// the path-based rename. The walk must fail closed instead of recording a partial chain.
		vi.spyOn(fs, "lstat").mockImplementation(((p: unknown) => {
			if (String(p) === parent) {
				return Promise.reject(Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }))
			}
			return Promise.resolve(asFile)
		}) as unknown as typeof fs.lstat)

		await expect(safeWriteJson(target, { written: true }, { refuseSymlinkTarget: true })).rejects.toThrow(
			/does not exist, so the destination ancestry cannot be verified/,
		)

		vi.restoreAllMocks()
		// Nothing was published: the existing target keeps its content.
		expect(await readFileContent(target)).toEqual({ own: true })
	})

	test("publishes when every recorded ancestor keeps its identity", async () => {
		const parent = path.join(tempDir, "stable-parent")
		await fs.mkdir(parent, { recursive: true })
		const target = path.join(parent, "stable-ancestor.json")
		await fsPromisesActuals.writeFile!(target, JSON.stringify({ own: true }))
		// Pinning must not reject the ordinary case: every ancestor keeps the identity the walk
		// recorded, so the publication proceeds.
		vi.spyOn(fs, "lstat").mockResolvedValue({
			isSymbolicLink: () => false,
			dev: 1n,
			ino: 1n,
		} as unknown as fsSyncActual.BigIntStats)

		await safeWriteJson(target, { written: true }, { refuseSymlinkTarget: true })

		vi.restoreAllMocks()
		expect(await readFileContent(target)).toEqual({ written: true })
	})

	test("does not apply the ancestor refusal when refuseSymlinkTarget is not set", async () => {
		const target = path.join(tempDir, "default-ancestor.json")
		await fsPromisesActuals.writeFile!(target, JSON.stringify({ own: true }))
		const asLink = { isSymbolicLink: () => true } as unknown as fsSyncActual.Stats
		const asFile = { isSymbolicLink: () => false } as unknown as fsSyncActual.Stats
		// The ancestor walk is part of the credential-write policy, not a global behavior change:
		// callers that did not opt into refuseSymlinkTarget keep their previous semantics.
		vi.spyOn(fs, "lstat").mockImplementation(((p: unknown) => {
			return Promise.resolve(String(p) === tempDir ? asLink : asFile)
		}) as unknown as typeof fs.lstat)

		await safeWriteJson(target, { written: true })

		vi.restoreAllMocks()
		expect(await readFileContent(target)).toEqual({ written: true })
	})

	test("fails closed when an ancestor directory cannot be inspected", async () => {
		const target = path.join(tempDir, "ancestor-eacces.json")
		await fsPromisesActuals.writeFile!(target, JSON.stringify({ own: true }))
		const asFile = { isSymbolicLink: () => false } as unknown as fsSyncActual.Stats
		const failure = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
		// "Could not inspect" is not evidence that the path is safe: only ENOENT is tolerated.
		vi.spyOn(fs, "lstat").mockImplementation(((p: unknown) => {
			if (String(p) === tempDir) {
				return Promise.reject(failure)
			}
			return Promise.resolve(asFile)
		}) as unknown as typeof fs.lstat)

		await expect(safeWriteJson(target, { leaked: true }, { refuseSymlinkTarget: true })).rejects.toThrow(/EACCES/)

		vi.restoreAllMocks()
		expect(await readFileContent(target)).toEqual({ own: true })
	})

	test("does not resolve the publish target when refuseSymlinkTarget is set", async () => {
		const target = path.join(tempDir, "no-resolve.json")
		// Resolving is what turns a planted link into a destination the caller never chose,
		// so the credential-bearing path skips it entirely and publishes onto the name the
		// caller gave.
		const realpath = vi.spyOn(fs, "realpath").mockImplementation(async (p) => String(p))

		await safeWriteJson(target, { written: true }, { refuseSymlinkTarget: true })

		expect(realpath).not.toHaveBeenCalled()
		vi.restoreAllMocks()
		expect(await readFileContent(target)).toEqual({ written: true })
	})
})
