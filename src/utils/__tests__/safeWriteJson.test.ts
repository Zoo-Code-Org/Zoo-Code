import * as fsSyncActual from "fs"
import { Writable } from "stream"
import * as path from "path"
import * as os from "os"

import { ConfinedPathEscapeError, safeWriteJson, undoEscapedPublish } from "../safeWriteJson"

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
	const mockedFs = {
		...actual,
		writeFile: vi.fn(actual.writeFile),
		readFile: vi.fn(actual.readFile),
		rename: vi.fn(actual.rename),
		unlink: vi.fn(actual.unlink),
		access: vi.fn(actual.access),
		stat: vi.fn(actual.stat),
		chmod: vi.fn(actual.chmod),
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
	return {
		...actualFs, // Spread actual implementations
		createWriteStream: vi.fn(actualFs.createWriteStream), // Default to actual, but mockable
	}
})

import * as fs from "fs/promises" // This will now be the mocked version

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

		// fs.rename is already vi.fn() — use vi.mocked to avoid double-wrapping via vi.spyOn
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

		// fs.rename is already vi.fn() — use vi.mocked to avoid double-wrapping via vi.spyOn
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
		// fs.mkdir is already vi.fn() — use vi.mocked to avoid double-wrapping via vi.spyOn
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

		// Force the two-step fallback so a backup exists, then fail its deletion
		vi.mocked(fs.rename).mockImplementationOnce(async () => {
			throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })
		})

		// fs.unlink is already vi.fn() — use vi.mocked to avoid double-wrapping via vi.spyOn
		vi.mocked(fs.unlink).mockImplementation(async (filePath) => {
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
	test("should keep the committed file when the commit rename fails with a non-EPERM error", async () => {
		// currentTestFilePath exists due to beforeEach.
		const initialData = { message: "Initial content" }
		const newData = { message: "New content" }

		await fsPromisesActuals.writeFile!(currentTestFilePath, JSON.stringify(initialData))

		// fs.rename is already vi.fn() — use vi.mocked to avoid double-wrapping via vi.spyOn
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
		// fs.access is already vi.fn() — use vi.mocked to avoid double-wrapping via vi.spyOn
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

		// fs.rename is already vi.fn() — use vi.mocked to avoid double-wrapping via vi.spyOn
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
			// The injection is keyed on the leftover's inode, not on the spelling of its path:
			// the writer stats the canonical form of the same file, which realpath can spell
			// differently from os.tmpdir() on the machine running the test. Production cannot tell
			// the two spellings apart - they are one file - so the double matches the inode.
			const injectedInode = await actual.stat(unreadableBackup)
			const isInjectedInode = async (candidate: Parameters<typeof actual.stat>[0]) => {
				try {
					const inode = await actual.stat(candidate)
					return inode.dev === injectedInode.dev && inode.ino === injectedInode.ino
				} catch {
					return false // a candidate that cannot be stat-ed is not the injected leftover
				}
			}
			// The double is installed for this test only. vi.restoreAllMocks() in afterEach does not
			// clear implementations set on the fs/promises factory mocks, and the operating system
			// recycles inodes, so a matcher left installed rejects a later test's unrelated file the
			// moment that file is handed the inode this row captured.
			const previousStat = vi.mocked(fs.stat).getMockImplementation()
			vi.mocked(fs.stat).mockImplementation(async (backupPath) => {
				if (await isInjectedInode(backupPath)) {
					throw Object.assign(new Error("Backup stat failed"), { code })
				}
				return actual.stat(backupPath)
			})
			const merge = vi.fn((existing: unknown) => existing)

			try {
				if (code === "ENOENT") {
					await safeWriteJson(currentTestFilePath, {}, { merge })
					expect(merge).toHaveBeenCalledWith({ committed: true }, {})
				} else {
					await expect(safeWriteJson(currentTestFilePath, {}, { merge })).rejects.toMatchObject({ code })
					expect(merge).not.toHaveBeenCalled()
					expect(await readFileContent(unreadableBackup)).toEqual({ stale: true })
					expect(await readFileContent(readableBackup)).toEqual({ committed: true })
				}
			} finally {
				vi.mocked(fs.stat).mockImplementation(previousStat ?? actual.stat)
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
			// Cleanup must run even when an assertion fails: a leaked mock registration
			// or console spy changes later tests. vi.doUnmock is the non-hoisted counterpart
			// of the vi.doMock above; vi.unmock is hoisted to the top of the file, so it would
			// not undo this registration from here.
			realpathSpy.mockRestore()
			vi.doUnmock("proper-lockfile")
			vi.resetModules()
			consoleErrorSpy.mockRestore()
		}
	})

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

			await expect(safeWriteJson(projectConfig, { mcpServers: {} }, { confineTo: projectDir })).rejects.toThrow(
				ConfinedPathEscapeError,
			)

			// The linked file is untouched and nothing was staged beside it.
			expect(JSON.parse(await fsSyncActual.promises.readFile(outside, "utf8"))).toEqual({ secret: "original" })
			const entries = await fs.readdir(tempDir)
			expect(entries).toContain("outside.json")
			expect(
				entries.filter(
					(entry) => entry.includes(".new_") || entry.includes("safeWriteText") || entry.endsWith(".lock"),
				),
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
			await safeWriteJson(
				alias,
				{ mcpServers: { local: { url: "http://localhost" } } },
				{ confineTo: projectDir },
			)

			expect(JSON.parse(await fsSyncActual.promises.readFile(referent, "utf8"))).toEqual({
				mcpServers: { local: { url: "http://localhost" } },
			})
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
	// The two failure paths of _copyTargetMode: a target whose mode cannot be read, and a staged
	// file whose mode cannot be set. Both have to log and let the write finish, because the
	// replacement protocol - not the mode - is what makes the publish atomic. They are driven
	// through the fs/promises mocks rather than a real EACCES/EPERM, because forcing either one
	// for real needs privileges a developer box and a CI runner neither have. That is also why
	// these two run on every platform while the symlink and mode rows above skip windows.
	test("logs and still publishes when the target's mode cannot be read", async () => {
		await fsPromisesActuals.writeFile!(currentTestFilePath, JSON.stringify({ before: true }))
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		// fs.stat is already vi.fn() in the factory above - vi.mocked keeps the real
		// implementation reachable once this single call is done.
		await vi.mocked(fs.stat).mockImplementationOnce(async () => {
			const error: NodeJS.ErrnoException = new Error(`EACCES: permission denied, stat '${currentTestFilePath}'`)
			error.code = "EACCES"
			throw error
		})

		await safeWriteJson(currentTestFilePath, { after: true })

		expect(await readFileContent(currentTestFilePath)).toEqual({ after: true })
		// The log must name the target it could not read; it must not be compared against
		// the caller's spelling. The writer resolves the target before logging, and on
		// Windows a path whose components carry 8.3 aliases resolves to a different
		// spelling than the one the caller handed it - measured on this row: a temp under
		// C:\work\ZOO-CO~1\TMP-AL~2 logged its target as ...\Zoo-Code-fork\.tmp-alias-vps2f\
		// on the same run. The mkdtemp directory name and the file's own name are the parts
		// that survive resolution, so the log is pinned to those.
		const loggedTargets = consoleErrorSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n")
		expect(loggedTargets).toContain(path.basename(path.dirname(currentTestFilePath)))
		expect(loggedTargets).toContain(path.basename(currentTestFilePath))
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining(path.basename(currentTestFilePath)),
			expect.anything(),
		)
		consoleErrorSpy.mockRestore()
	}, 20_000)

	test("logs and still publishes when the staged file's mode cannot be set", async () => {
		await fsPromisesActuals.writeFile!(currentTestFilePath, JSON.stringify({ before: true }))
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		// chmod is a vi.fn() in the factory above for the same reason.
		await vi.mocked(fs.chmod).mockImplementationOnce(async () => {
			const error: NodeJS.ErrnoException = new Error(
				`EPERM: operation not permitted, chmod '${currentTestFilePath}'`,
			)
			error.code = "EPERM"
			throw error
		})

		await safeWriteJson(currentTestFilePath, { after: true })

		expect(await readFileContent(currentTestFilePath)).toEqual({ after: true })
		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to copy mode"), expect.anything())
		consoleErrorSpy.mockRestore()
	}, 20_000)

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

	// A caller that declares a scope must never get the unconstrained path: an
	// empty confineTo is a declared scope, not an absent one. This value occurs in
	// practice - McpHub.confineForMcpWrite returns getWorkspacePath(), which is ""
	// while no workspace folder is open. The truthiness checks skipped both
	// confinement gates for "", so the write followed any symlink with no scope
	// check at all.
	test("rejects a declared-but-empty confineTo instead of writing unconstrained", async () => {
		const error = await safeWriteJson(currentTestFilePath, { mcpServers: {} }, { confineTo: "" }).then(
			() => undefined,
			(reason: unknown) => reason,
		)
		expect(error).toBeInstanceOf(ConfinedPathEscapeError)
		if (error instanceof ConfinedPathEscapeError) {
			// The rejection must name the declared empty root: a substituted root
			// (path.resolve("") is the process cwd) would mean confining the write
			// to a directory nobody declared.
			expect(error.confineTo).toBe("")
		}
		// The write did not proceed: the target keeps its pre-existing content.
		expect(await readFileContent(currentTestFilePath)).toEqual({ initial: "content" })
	})

	test("rejects an empty confineTo before creating the target parent directory", async () => {
		// The same fail-closed decision pinned at the ordering the pre-lock check
		// guarantees: a rejected confined write must not create the missing parent
		// directory of the target.
		const outside = path.join(tempDir, "empty-scope-missing-parent", "nested.json")

		const error = await safeWriteJson(outside, { mcpServers: {} }, { confineTo: "" }).then(
			() => undefined,
			(reason: unknown) => reason,
		)
		expect(error).toBeInstanceOf(ConfinedPathEscapeError)
		if (error instanceof ConfinedPathEscapeError) {
			expect(error.confineTo).toBe("")
		}

		const entries = await fs.readdir(tempDir)
		expect(entries).not.toContain("empty-scope-missing-parent")
		expect(entries.filter((entry) => entry.endsWith(".lock") || entry.includes(".new_"))).toEqual([])
	})

	test("rejects a whitespace-only confineTo and names the declared root", async () => {
		// path.resolve("   ") is a directory named "   " under the process cwd - a
		// scope nobody declared. Whitespace-only fails closed with the declared
		// root, the same decision as the empty string.
		const error = await safeWriteJson(currentTestFilePath, { mcpServers: {} }, { confineTo: "   " }).then(
			() => undefined,
			(reason: unknown) => reason,
		)
		expect(error).toBeInstanceOf(ConfinedPathEscapeError)
		if (error instanceof ConfinedPathEscapeError) {
			expect(error.confineTo).toBe("   ")
		}
		expect(await readFileContent(currentTestFilePath)).toEqual({ initial: "content" })
	})

	// The confinement option decides from the resolved publish target and stops at its final
	// component. An ancestor DIRECTORY replaced by a link in the window between that
	// decision and the commit rename is caught fail-closed: publication takes a path and
	// re-resolves the tree at rename time, so the confinement option re-resolves the
	// published path after the commit and undoes an escaped write. These two tests are
	// that contract as an executable pair - one per outcome of the window. The swap is driven from the merge
	// callback, which safeWriteJson invokes after the in-lock confinement check and before
	// anything is staged, so the ancestor moves inside the window rather than hopefully so.
	// A directory link needs no privilege on win32 as a junction; "dir" is the POSIX
	// spelling. Both make the ancestor itself the link, which is the shape under test.
	const ancestorLinkKind = process.platform === "win32" ? ("junction" as const) : ("dir" as const)

	function swapAncestorAfterTheCheck(ancestor: string, pointsAt: string): void {
		fsSyncActual.renameSync(ancestor, ancestor + "-moved-aside")
		fsSyncActual.symlinkSync(pointsAt, ancestor, ancestorLinkKind)
	}

	test("refuses and undoes the publish when an ancestor is swapped after the final check", async () => {
		const projectDir = path.join(tempDir, "swap-project")
		const ancestor = path.join(projectDir, "settings")
		await fs.mkdir(ancestor, { recursive: true })
		const target = path.join(ancestor, "mcp.json")
		await fs.writeFile(target, JSON.stringify({ inside: true }))
		// The swapped-in directory has no file at the target name yet: this is the half of the
		// window in which the commit itself succeeds and only the post-commit re-check sees
		// the escape.
		const swappedIn = path.join(tempDir, "elsewhere", "settings")
		await fs.mkdir(swappedIn, { recursive: true })

		// The confinement option now fails closed on the swapped ancestor: the
		// post-commit re-check re-resolves the published path, sees it outside the
		// declared scope, removes the escaped file, and reports the escape.
		await expect(
			safeWriteJson(
				target,
				{ written: "payload" },
				{
					confineTo: projectDir,
					merge: () => {
						swapAncestorAfterTheCheck(ancestor, swappedIn)
						return { written: "payload" }
					},
				},
			),
		).rejects.toBeInstanceOf(ConfinedPathEscapeError)

		// The escaped publication was undone: nothing remains outside the scope...
		expect(fsSyncActual.existsSync(path.join(swappedIn, "mcp.json"))).toBe(false)
		// ...and the file that was inside the scope keeps its pre-write bytes - the
		// publish did not reach it under the moved-aside name either.
		expect(JSON.parse(fsSyncActual.readFileSync(path.join(ancestor + "-moved-aside", "mcp.json"), "utf8"))).toEqual(
			{ inside: true },
		)
		// The scope was declared and active in this very fixture: with the ancestor left
		// alone, the same option refuses an out-of-scope target. Without this contrast the
		// escape above would also be the outcome of a confinement check that never ran.
		await expect(
			safeWriteJson(path.join(tempDir, "elsewhere", "other.json"), { other: true }, { confineTo: projectDir }),
		).rejects.toThrow(ConfinedPathEscapeError)
	})

	test("undoes an escaped publish only when the bytes on disk are still this write's bytes", async () => {
		const outside = path.join(tempDir, "undo-escaped")
		await fs.mkdir(outside, { recursive: true })
		const escaped = path.join(outside, "mcp.json")
		// A peer wrote its own file at the escaped name after our commit published ours and
		// before the post-commit re-check ran. Removing it on the name alone would delete the
		// peer's file; the byte comparison must leave it in place.
		fsSyncActual.writeFileSync(escaped, JSON.stringify({ peer: true }))

		await undoEscapedPublish(escaped, Buffer.from(JSON.stringify({ ours: true })))

		expect(fsSyncActual.existsSync(escaped)).toBe(true)
		expect(JSON.parse(fsSyncActual.readFileSync(escaped, "utf8"))).toEqual({ peer: true })

		// The bytes are still ours: the escaped publish is undone.
		await undoEscapedPublish(escaped, Buffer.from(JSON.stringify({ peer: true })))
		expect(fsSyncActual.existsSync(escaped)).toBe(false)

		// A missing file and an unreadable byte record are both no-ops, never a throw.
		await undoEscapedPublish(escaped, Buffer.from("{}"))
		await undoEscapedPublish(path.join(outside, "absent.json"), undefined)
	})

	// The confinement re-check inside the failure path at lines 481 to 490 of safeWriteJson.ts runs
	// while the write is already failing, and the review says a rejection there must not decide
	// what the teardown does: the backup rollback at lines 496 to 511 and the staged cleanup at
	// lines 514 to 529 are what keep the committed copy and the staged bytes from being left
	// behind. This row drives the same EPERM fallback the row at line 192 drives, so a backup
	// exists and the canonical path is absent when the catch block runs, and it breaks fs.realpath
	// only from the moment that backup rename lands, which is the state the catch block then reads.
	test("restores the committed file and drops the staged file when the failure-path confinement check cannot run", async () => {
		const initialData = { message: "Initial content, must survive a broken teardown check" }
		const newData = { message: "New content" }
		await fsPromisesActuals.writeFile!(currentTestFilePath, JSON.stringify(initialData))

		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		let teardownCheckBroken = false
		const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (target) => {
			if (teardownCheckBroken) {
				throw Object.assign(new Error("EPERM: operation not permitted, realpath"), { code: "EPERM" })
			}
			return String(target)
		})
		let renameCallCount = 0
		vi.mocked(fs.rename).mockImplementation(async (oldPath, newPath) => {
			renameCallCount++
			if (renameCallCount === 1) {
				// The single-rename commit fails with EPERM, which starts the two-step fallback.
				throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })
			}
			if (renameCallCount === 2) {
				// The backup lands here. From this point the failing write is what the catch block
				// sees, and the confinement re-check inside it is the thing under test.
				teardownCheckBroken = true
				return fsPromisesActuals.rename!(oldPath, newPath)
			}
			if (renameCallCount === 3) {
				throw new Error("Fallback replacement rename failed")
			}
			// The rollback rename, which is what this row is about.
			return fsPromisesActuals.rename!(oldPath, newPath)
		})

		try {
			// The write rejects with the failure that started the teardown, not with the realpath
			// rejection of a scope root that could not be canonicalized.
			await expect(safeWriteJson(currentTestFilePath, newData, { confineTo: tempDir })).rejects.toThrow(
				"Fallback replacement rename failed",
			)
			// The rollback ran: the committed copy is back at the canonical path.
			expect(await fileExists(currentTestFilePath)).toBe(true)
			expect(await readFileContent(currentTestFilePath)).toEqual(initialData)
			// Neither a backup nor a staged file outlives the failed write.
			const leftovers = (await fs.readdir(tempDir)).filter(
				(entry) => entry.includes(".bak_") || entry.includes(".new_"),
			)
			expect(leftovers).toEqual([])
			// A re-check that could not run is reported rather than silently skipped.
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining("could not run during the teardown"),
				expect.objectContaining({ code: "EPERM" }),
			)
		} finally {
			realpathSpy.mockRestore()
			consoleErrorSpy.mockRestore()
		}
	})

	// Line 343 is the recovery call, and this pull changed its argument from the caller's
	// spelling to the resolved publish target. The two spellings only differ when the
	// orphaned replacement files sit beside the referent rather than beside the alias, which
	// is the crash state below. Real symlinks are unavailable in this lane, so the link is
	// simulated by mocking fs.realpath the same way the staging and lock-key rows do.
	test("recovers an orphaned backup found beside the resolved target, not the caller alias", async () => {
		const referentDir = path.join(tempDir, "recover-referent")
		const aliasDir = path.join(tempDir, "recover-alias")
		await fs.mkdir(referentDir, { recursive: true })
		await fs.mkdir(aliasDir, { recursive: true })
		const callerPath = path.join(aliasDir, "history.json")
		const referentPath = path.join(referentDir, "history.json")
		// Crash state of the two-step replacement seen through the link: the committed bytes
		// live in an orphaned backup next to the referent, the referent itself is absent, and
		// the alias directory holds no replacement files at all.
		const backupPath = path.join(referentDir, ".history.json.bak_1_last.tmp")
		const committed = { history: ["committed before the interruption"] }
		await fs.writeFile(backupPath, JSON.stringify(committed))
		// Only the file resolves through the link; both directories are already canonical, so
		// the scan directory is the one place the two spellings disagree.
		const realpathSpy = vi
			.spyOn(fs, "realpath")
			.mockImplementation(async (target) => (target === callerPath ? referentPath : String(target)))
		const merge = vi.fn((existing: unknown, incoming: unknown) => ({
			...(existing as Record<string, unknown>),
			...(incoming as Record<string, unknown>),
		}))
		const trace = vi.fn()
		try {
			await safeWriteJson(callerPath, { added: true }, { merge, trace })
			// Recovery scanned the resolved target, so the merge callback read the committed
			// history instead of reporting an absent file.
			expect(merge).toHaveBeenCalledExactlyOnceWith(committed, { added: true })
			// The restore is reported through the same trace channel the writer already uses.
			expect(trace).toHaveBeenCalledWith({ stage: "recover", detail: backupPath })
			expect(await readFileContent(referentPath)).toEqual({
				history: ["committed before the interruption"],
				added: true,
			})
			// The restored backup was consumed: the leftover does not outlive the write.
			expect(fsSyncActual.existsSync(backupPath)).toBe(false)
		} finally {
			realpathSpy.mockRestore()
		}
	})
})
