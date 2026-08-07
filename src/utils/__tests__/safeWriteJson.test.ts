import * as fsSyncActual from "fs"
import { Writable } from "stream"
import * as path from "path"
import * as os from "os"

import * as lockfile from "proper-lockfile"
import { safeWriteJson, safeUpdateJson } from "../safeWriteJson"

vi.mock("proper-lockfile", async () => {
	const actual = await vi.importActual<typeof import("proper-lockfile")>("proper-lockfile")
	return {
		...actual,
		lock: vi.fn(actual.lock),
	}
})

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

	test("should handle failure when renaming filePath to tempBackupFilePath (filePath exists)", async () => {
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

	test("should handle failure when renaming tempNewFilePath to filePath (filePath exists, backup succeeded)", async () => {
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
				// First call: filePath -> tempBackupFilePath (should succeed)
				return fsPromisesActuals.rename!(oldPath, newPath)
			} else if (renameCallCount === 2) {
				// Second call: tempNewFilePath -> filePath (should fail)
				throw new Error("Rename from temp to final failed")
			} else if (renameCallCount === 3) {
				// Third call: tempBackupFilePath -> filePath (rollback, should succeed)
				return fsPromisesActuals.rename!(oldPath, newPath)
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

	// Test for console error suppression during backup deletion
	test("should suppress console.error when backup deletion fails", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {}) // Suppress console.error
		const initialData = { message: "Initial" }
		const newData = { message: "New" }

		await fsPromisesActuals.writeFile!(currentTestFilePath, JSON.stringify(initialData))

		// fs.unlink is already vi.fn() — use vi.mocked to avoid double-wrapping via vi.spyOn
		vi.mocked(fs.unlink).mockImplementation(async (filePath: any) => {
			if (filePath.toString().includes(".bak_")) {
				throw new Error("Backup deletion failed")
			}
			return fsPromisesActuals.unlink!(filePath)
		})

		await safeWriteJson(currentTestFilePath, newData)

		// Verify console.error was called with the expected message
		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Successfully wrote"), expect.any(Error))

		consoleErrorSpy.mockRestore()
		vi.mocked(fs.unlink).mockRestore()
	})

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
			if (renameCallCount === 2) {
				// Second call: tempNewFilePath -> filePath (should fail)
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
		const data = { message: "test lock failure" }

		// Create a new file path for this specific test to avoid conflicts
		const lockTestFilePath = path.join(tempDir, "lock-test-file.json")
		await fs.writeFile(lockTestFilePath, JSON.stringify({ initial: "lock test content" }))

		vi.mocked(lockfile.lock).mockRejectedValueOnce(new Error("Failed to get lock."))

		await expect(safeWriteJson(lockTestFilePath, data)).rejects.toThrow("Failed to get lock.")

		// Clean up
		await fs.unlink(lockTestFilePath).catch(() => {}) // Ignore errors if file doesn't exist
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

	// Test for rollback failure scenario
	test("should log error and re-throw original if rollback fails", async () => {
		const initialData = { message: "Initial, should be lost if rollback fails" }
		const newData = { message: "New content" }

		await fsPromisesActuals.writeFile!(currentTestFilePath, JSON.stringify(initialData))

		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {}) // Suppress console.error

		// fs.rename is already vi.fn() — use vi.mocked to avoid double-wrapping via vi.spyOn
		let renameCallCount = 0
		vi.mocked(fs.rename).mockImplementation(async (oldPath, newPath) => {
			renameCallCount++
			if (renameCallCount === 2) {
				// Second call: tempNewFilePath -> filePath (fail)
				throw new Error("Primary rename failed")
			} else if (renameCallCount === 3) {
				// Third call: tempBackupFilePath -> filePath (rollback, also fail)
				throw new Error("Rollback rename failed")
			}
			return fsPromisesActuals.rename!(oldPath, newPath)
		})

		// Should throw the original error, not the rollback error
		await expect(safeWriteJson(currentTestFilePath, newData)).rejects.toThrow("Primary rename failed")

		// Verify console.error was called for the rollback failure
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Failed to restore backup"),
			expect.objectContaining({ message: "Rollback rename failed" }),
		)

		consoleErrorSpy.mockRestore()
	})
})

describe("safeUpdateJson", () => {
	let tempDir: string
	let currentTestFilePath: string

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "safeUpdateJson-test-"))
		currentTestFilePath = path.join(tempDir, "test-file.json")
		await fs.writeFile(currentTestFilePath, JSON.stringify({ count: 1 }))
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	test("updates existing file successfully", async () => {
		const updated = await safeUpdateJson<{ count: number }>(currentTestFilePath, (current) => {
			expect(current).toEqual({ count: 1 })
			return { count: 2 }
		})
		expect(updated).toEqual({ count: 2 })
		const content = JSON.parse(await fs.readFile(currentTestFilePath, "utf-8"))
		expect(content).toEqual({ count: 2 })
	})

	test("supports prettyPrint option", async () => {
		const updated = await safeUpdateJson<{ count: number }>(
			currentTestFilePath,
			(current) => ({ count: (current?.count ?? 0) + 1 }),
			{ prettyPrint: true },
		)
		expect(updated).toEqual({ count: 2 })
		const raw = await fs.readFile(currentTestFilePath, "utf-8")
		expect(raw).toContain("\t")
	})

	test("throws error if file does not exist and allowCreate is false", async () => {
		const nonExistent = path.join(tempDir, "non-existent.json")
		await expect(safeUpdateJson(nonExistent, (curr) => curr ?? { a: 1 }, { allowCreate: false })).rejects.toThrow(
			"safeUpdateJson: file does not exist and allowCreate is false",
		)
	})

	test("creates new file if allowCreate is true and file does not exist", async () => {
		const nonExistent = path.join(tempDir, "non-existent.json")
		const result = await safeUpdateJson(
			nonExistent,
			(curr) => {
				expect(curr).toBeUndefined()
				return { created: true }
			},
			{ allowCreate: true },
		)
		expect(result).toEqual({ created: true })
		const content = JSON.parse(await fs.readFile(nonExistent, "utf-8"))
		expect(content).toEqual({ created: true })
	})

	test("throws original read parse error if file exists but is malformed JSON", async () => {
		await fs.writeFile(currentTestFilePath, "invalid json {")
		await expect(safeUpdateJson(currentTestFilePath, (curr) => curr)).rejects.toThrow(SyntaxError)
	})

	test("rethrows read error if non-ENOENT read error occurs", async () => {
		vi.mocked(fs.readFile).mockImplementationOnce(async () => {
			const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException
			err.code = "EACCES"
			throw err
		})
		await expect(safeUpdateJson(currentTestFilePath, (curr) => curr)).rejects.toThrow("EACCES")
	})

	test("handles lock acquisition failure", async () => {
		vi.mocked(lockfile.lock).mockRejectedValueOnce(new Error("Lock failed"))
		await expect(safeUpdateJson(currentTestFilePath, (curr) => curr)).rejects.toThrow("Lock failed")
	})

	test("handles directory creation error", async () => {
		vi.mocked(fs.mkdir).mockImplementationOnce(async () => {
			const err = new Error("mkdir failed")
			throw err
		})
		const subFile = path.join(tempDir, "subdir", "file.json")
		await expect(safeUpdateJson(subFile, (curr) => curr, { allowCreate: true })).rejects.toThrow("mkdir failed")
	})

	test("rolls back backup if write or rename fails", async () => {
		const initial = { count: 1 }
		let renameCount = 0
		vi.mocked(fs.rename).mockImplementation(async (oldPath, newPath) => {
			renameCount++
			if (renameCount === 2) {
				throw new Error("Write rename failed")
			}
			return fsPromisesActuals.rename!(oldPath, newPath)
		})

		await expect(safeUpdateJson(currentTestFilePath, () => ({ count: 99 }))).rejects.toThrow("Write rename failed")

		const restored = JSON.parse(await fs.readFile(currentTestFilePath, "utf-8"))
		expect(restored).toEqual(initial)
	})

	test("handles backup cleanup failure gracefully after successful update", async () => {
		vi.mocked(fs.unlink).mockImplementation(async (filePath) => {
			if (filePath.toString().includes(".bak_")) {
				throw new Error("Unlink backup failed")
			}
			return fsPromisesActuals.unlink!(filePath)
		})
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		const updated = await safeUpdateJson<{ count: number }>(currentTestFilePath, () => ({ count: 5 }))
		expect(updated).toEqual({ count: 5 })
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("failed to clean up backup"), expect.any(Error))
		consoleSpy.mockRestore()
	})

	test("logs error if rollback fails during write error catch block", async () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		let renameCount = 0
		vi.mocked(fs.rename).mockImplementation(async (oldPath, newPath) => {
			renameCount++
			if (renameCount === 2) {
				throw new Error("Write rename failed")
			} else if (renameCount === 3) {
				throw new Error("Rollback rename failed")
			}
			return fsPromisesActuals.rename!(oldPath, newPath)
		})

		await expect(safeUpdateJson(currentTestFilePath, () => ({ count: 99 }))).rejects.toThrow("Write rename failed")

		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to restore backup"), expect.any(Error))
		consoleSpy.mockRestore()
	})

	test("handles lock compromise callback and unlock failure in finally block", async () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		vi.mocked(lockfile.lock).mockImplementationOnce(async (_path, options) => {
			if (options?.onCompromised) {
				options.onCompromised(new Error("Compromised!"))
			}
			return async () => {
				throw new Error("Unlock failed")
			}
		})

		await expect(safeUpdateJson(currentTestFilePath, () => ({ count: 10 }))).rejects.toThrow("Compromised!")

		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("was compromised"), expect.any(Error))
		consoleSpy.mockRestore()
	})

	test("rethrows non-ENOENT error during backup access check", async () => {
		const accessMock = vi.mocked(fs.access).mockImplementation(async (targetPath) => {
			if (targetPath === currentTestFilePath) {
				const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException
				err.code = "EACCES"
				throw err
			}
			return undefined
		})

		try {
			await expect(safeUpdateJson(currentTestFilePath, () => ({ count: 10 }))).rejects.toThrow("EACCES")
		} finally {
			accessMock.mockRestore()
		}
	})

	test("handles cleanup errors for temporary files during write failure catch block", async () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		let renameCount = 0

		vi.mocked(fs.rename).mockImplementation(async (oldPath, newPath) => {
			renameCount++
			if (renameCount === 2) {
				throw new Error("Rename to target failed")
			}
			return fsPromisesActuals.rename!(oldPath, newPath)
		})

		vi.mocked(fs.unlink).mockImplementation(async (targetPath) => {
			if (targetPath.toString().includes(".tmp")) {
				throw new Error("Unlink temp failed")
			}
			return fsPromisesActuals.unlink!(targetPath)
		})

		await expect(safeUpdateJson(currentTestFilePath, () => ({ count: 99 }))).rejects.toThrow(
			"Rename to target failed",
		)

		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining("Failed to clean up temporary"),
			expect.any(Error),
		)
		consoleSpy.mockRestore()
	})

	test("handles unlock error in finally block during normal execution", async () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		vi.mocked(lockfile.lock).mockImplementationOnce(async () => {
			return async () => {
				throw new Error("Unlock failed on success")
			}
		})

		const result = await safeUpdateJson<{ count: number }>(currentTestFilePath, () => ({ count: 50 }))
		expect(result).toEqual({ count: 50 })
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to release lock"), expect.any(Error))
		consoleSpy.mockRestore()
	})
})
