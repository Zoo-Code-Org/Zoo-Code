import * as fsSyncActual from "fs"
import { Writable } from "stream"
import * as path from "path"
import * as os from "os"

import { AncestorReplacedError, TargetMovedError } from "../../services/file-safety/safeWriteText"
import { ConfinedPathEscapeError, safeWriteJson } from "../safeWriteJson"
import * as fileLockModule from "../fileLock"

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
		// Create a temporary directory for each test, in the spelling the writer itself uses.
		// safeWriteJson works on a path that fs.realpath returned (the lock key, and now the
		// recovery scan keyed to it, are realpath results), and every path-keyed double in this
		// file compares against strings derived from tempDir. On the windows CI runner os.tmpdir()
		// reports the profile directory in its 8.3 form - C:\Users\RUNNER~1\AppData\Local\Temp -
		// while fs.realpath reports C:\Users\runneradmin\AppData\Local\Temp for the same
		// directory, and six rows here (three of them pre-existing) failed on that runner for
		// nothing but the spelling: the doubles that inject a failure at a named path never saw
		// that path, and the fsync row never saw the directory handle it opened. Canonicalising
		// the fixture root makes the fixture's paths and the product's paths one string.
		tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "safeWriteJson-test-")))

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

	// The ancestor-swap tests below drive the swap from the merge callback, which
	// safeWriteJson invokes after the in-lock confinement check and before anything is
	// staged, so the ancestor moves inside the window rather than hopefully so.
	// A directory link needs no privilege on win32 as a junction; "dir" is the POSIX
	// spelling. Both make the ancestor itself the link, which is the shape under test.
	const ancestorLinkKind = process.platform === "win32" ? ("junction" as const) : ("dir" as const)

	function swapAncestorAfterTheCheck(ancestor: string, pointsAt: string): void {
		fsSyncActual.renameSync(ancestor, ancestor + "-moved-aside")
		fsSyncActual.symlinkSync(pointsAt, ancestor, ancestorLinkKind)
	}

	function removeAncestorLink(ancestor: string): void {
		// The undo of the link above, and the two platforms remove it differently. Measured on
		// this box (node 22.23.4, win32): lstatSync reports a junction as a symbolic link, and
		// unlinkSync does remove the junction while leaving the target directory's contents
		// alone - but while another handle is still open on that directory the unlink only marks
		// the name for deletion, and the rename that puts the directory back then answers
		// "EPERM: operation not permitted", which is what this row reported after switching to
		// unlink. rmdir takes a junction cleanly. On POSIX the entry is a real directory symlink
		// and rmdir will not take it: the ubuntu coverage lane answered
		// "ENOTDIR: not a directory, rmdir '.../midwrite-swap-project/settings'" for this
		// restoration, so unlink is the removal there. The branch follows the same platform fact
		// the link was created with, rather than pretending one call serves both shapes.
		if (process.platform === "win32") {
			fsSyncActual.rmdirSync(ancestor)
		} else {
			fsSyncActual.unlinkSync(ancestor)
		}
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

	// Four variants the chain carried against its own write mechanism are not ported here,
	// because the mechanism they describe is not the one this module ships:
	//   - "a failed commit keeps the previous content at the target and removes the backup
	//     copy" pinned a single-rename flow (renameCallCount === 1) and a
	//     "safeWriteText.bak_" backup name; this protocol backs up with a rename of the
	//     target and its own ".bak_" spelling, and main's
	//     "should keep the committed file when the commit rename fails with a non-EPERM
	//     error" already asserts the surviving behaviour - previous content at the target,
	//     staging artifacts removed - against that mechanism.
	//   - the chain's re-titling of main's rename-failure tests ("... backup copy taken",
	//     "the commit rename fails (filePath exists)") is a naming change over a different
	//     rename sequence; main's versions are kept verbatim.
	//   - the fsync variant below keeps the regression it guards (published content intact,
	//     consumed staging path untouched) but asserts the contract this protocol has:
	//     report and continue, not reject.

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
	test("fails closed when the confined scope cannot be canonicalized", async () => {
		const scope = path.join(tempDir, "project")
		await fs.mkdir(scope)
		const target = path.join(scope, "mcp.json")
		const merge = vi.fn()
		// Only ENOENT means "walk up and re-join". EACCES means the scope root is unknown,
		// and continuing with a partly lexical root would let the confinement check compare
		// against a scope that may disagree with the canonical target.
		const failure = Object.assign(new Error("EACCES"), { code: "EACCES" })
		const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async () => {
			throw failure
		})
		try {
			await expect(safeWriteJson(target, { mcpServers: {} }, { confineTo: scope, merge })).rejects.toThrow(
				"EACCES",
			)
		} finally {
			realpathSpy.mockRestore()
		}

		// Nothing was merged, staged, locked or published.
		expect(merge).not.toHaveBeenCalled()
		expect(await fs.readdir(scope)).toEqual([])
		const root = await fs.readdir(tempDir)
		expect(root.filter((entry) => entry.includes(".new_") || entry.endsWith(".lock"))).toEqual([])
	})
	test("fails closed when a missing scope cannot be resolved through its ancestors", async () => {
		const scope = path.join(tempDir, "missing", "nested")
		const target = path.join(tempDir, "mcp.json")
		const merge = vi.fn()
		// The scope itself is missing, so the resolver walks up. The ancestor lookup then
		// fails for a non-ENOENT reason (a symlink loop), which is not a "missing path" signal:
		// the write has to fail rather than fall back to the lexical scope.
		const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (candidate) => {
			if (String(candidate).includes("missing")) {
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
			}
			throw Object.assign(new Error("ELOOP"), { code: "ELOOP" })
		})
		try {
			await expect(safeWriteJson(target, { mcpServers: {} }, { confineTo: scope, merge })).rejects.toThrow(
				"ELOOP",
			)
		} finally {
			realpathSpy.mockRestore()
		}

		expect(merge).not.toHaveBeenCalled()
		const root = await fs.readdir(tempDir)
		expect(root.filter((entry) => entry.includes(".new_") || entry.endsWith(".lock"))).toEqual([])
		expect(root).not.toContain("mcp.json")
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
	test("re-checks confinement after the lock when a peer moves the referent out of scope", async () => {
		const projectDir = path.join(tempDir, "race-project")
		await fs.mkdir(projectDir)
		const target = path.join(projectDir, "mcp.json")
		await fsPromisesActuals.writeFile!(target, JSON.stringify({ mcpServers: {} }), "utf8")
		const outsideDir = path.join(tempDir, "race-outside")
		await fs.mkdir(outsideDir)
		const merge = vi.fn()
		// The pre-lock check canonicalizes the lock key and sees the file inside the scope.
		// A peer writer then moves it out, so every lookup made after the advisory lock is
		// held - the publish-target resolution and the in-lock re-check - sees the referent
		// elsewhere. A confinement check that ran only before the lock would publish onto the
		// moved file outside the scope.
		const movedTarget = path.join(outsideDir, "mcp.json")
		// The move is tied to the lock rather than to a call count: everything the pre-lock
		// canonicalization sees is still inside the scope, and everything resolved while the
		// lock is held - the publish target and the in-lock re-check - sees it elsewhere.
		let lockHeld = false
		// Captured before the spy is installed: calling the namespace property from inside the
		// implementation would recurse through the spy itself.
		const realAcquire = fileLockModule.acquireFileLock
		const lockSpy = vi.spyOn(fileLockModule, "acquireFileLock").mockImplementation(async (key: string) => {
			const release = await realAcquire(key)
			lockHeld = true
			return release
		})
		const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (candidate) => {
			const p = String(candidate)
			if (p === target) {
				return lockHeld ? movedTarget : target
			}
			return p
		})
		let captured: unknown = null
		try {
			await safeWriteJson(target, { mcpServers: {} }, { confineTo: projectDir, merge })
		} catch (error: unknown) {
			captured = error
		} finally {
			realpathSpy.mockRestore()
			lockSpy.mockRestore()
		}

		expect(captured).toBeInstanceOf(ConfinedPathEscapeError)
		// The rejection came from the check inside the protected block, not from the
		// pre-lock one: the advisory lock had already been taken. (mockRestore in the
		// finally clears the spy's call history, so the flag carries the evidence.)
		expect(lockHeld).toBe(true)
		// The rejection happens before the merge read and before anything is staged, and the
		// advisory lock is released rather than left to the stale timeout.
		expect(merge).not.toHaveBeenCalled()
		expect(await fs.readdir(projectDir)).toEqual(["mcp.json"])
		expect(await fs.readdir(outsideDir)).toEqual([])
		const root = await fs.readdir(tempDir)
		expect(root.filter((entry) => entry.includes(".new_") || entry.endsWith(".lock"))).toEqual([])
	})
	test("refuses the write when an ancestor is swapped for a link before staging, after the merge read", async () => {
		const projectDir = path.join(tempDir, "swap-project")
		const ancestor = path.join(projectDir, "settings")
		await fs.mkdir(ancestor, { recursive: true })
		// The target does not exist yet, so the publish has to be stopped by the ancestor pin:
		// nothing about the target NAME changes, and a create into the swapped-in directory
		// would land outside the declared scope.
		const target = path.join(ancestor, "mcp.json")
		const swappedIn = path.join(tempDir, "elsewhere", "settings")
		await fs.mkdir(swappedIn, { recursive: true })

		const error = await safeWriteJson(
			target,
			{ written: "payload" },
			{
				confineTo: projectDir,
				merge: () => {
					swapAncestorAfterTheCheck(ancestor, swappedIn)
					return { written: "payload" }
				},
			},
		).then(
			() => undefined,
			(reason: unknown) => reason,
		)

		// Fail closed on the swapped ancestor, not on the target path: the name still resolves
		// to itself, only the directory it lives in was replaced.
		expect(error).toBeInstanceOf(AncestorReplacedError)
		expect(error).not.toBeInstanceOf(ConfinedPathEscapeError)
		expect(path.basename((error as AncestorReplacedError).directory)).toBe("settings")
		expect((error as AncestorReplacedError).message).toContain("nothing was published")
		// Nothing landed outside the declared scope. The staged temp file is created through
		// the swapped ancestor (staging is path based), and the failure cleanup removes it
		// instead of leaving it beside the swapped-in directory.
		expect(await fs.readdir(swappedIn)).toEqual([])
		// Nothing landed through the moved-aside name either. (The advisory lock directory is
		// created under the pre-swap name by proper-lockfile; when the ancestor moves aside
		// the release targets the path, which now resolves through the link, so that empty
		// lock directory can be left in the moved-aside copy. It holds no published content.)
		expect((await fs.readdir(ancestor + "-moved-aside")).filter((entry) => entry === "mcp.json")).toEqual([])
		// The scope was declared and active in this very fixture: with the ancestor left
		// alone, the same option refuses an out-of-scope target. Without this contrast the
		// rejection above would also be the outcome of a confinement check that never ran.
		await expect(
			safeWriteJson(path.join(tempDir, "elsewhere", "other.json"), { other: true }, { confineTo: projectDir }),
		).rejects.toThrow(ConfinedPathEscapeError)
	})
	test("fails the publish when an existing target now resolves through a swapped ancestor", async () => {
		const projectDir = path.join(tempDir, "swap-project-clash")
		const ancestor = path.join(projectDir, "settings")
		await fs.mkdir(ancestor, { recursive: true })
		const target = path.join(ancestor, "mcp.json")
		await fs.writeFile(target, JSON.stringify({ inside: true }))
		const swappedIn = path.join(tempDir, "elsewhere-clash", "settings")
		await fs.mkdir(swappedIn, { recursive: true })
		await fs.writeFile(path.join(swappedIn, "mcp.json"), JSON.stringify({ outside: true }))

		const error = await safeWriteJson(
			target,
			{ written: "payload" },
			{
				confineTo: projectDir,
				merge: () => {
					swapAncestorAfterTheCheck(ancestor, swappedIn)
					return { written: "payload" }
				},
			},
		).then(
			() => undefined,
			(reason: unknown) => reason,
		)

		// An existing target makes the swap visible in the resolved name itself, so the
		// publish stops at the target pin before anything is staged.
		expect(error).toBeInstanceOf(TargetMovedError)
		expect(error).not.toBeInstanceOf(ConfinedPathEscapeError)
		// Nothing was written on either side of the swap.
		expect(JSON.parse(fsSyncActual.readFileSync(path.join(swappedIn, "mcp.json"), "utf8"))).toEqual({
			outside: true,
		})
		expect(JSON.parse(fsSyncActual.readFileSync(path.join(ancestor + "-moved-aside", "mcp.json"), "utf8"))).toEqual(
			{ inside: true },
		)
	})
	test("publishes a confined write through a pinned ancestor chain and releases the lock", async () => {
		const projectDir = path.join(tempDir, "pinned-project")
		const nested = path.join(projectDir, "settings")
		await fs.mkdir(nested, { recursive: true })
		const target = path.join(nested, "mcp.json")

		// The pins must not reject a directory chain that did not move: the write publishes
		// and every artifact of it (lock, staged temp, staging directory) is gone afterwards.
		await safeWriteJson(target, { mcpServers: {} }, { confineTo: projectDir })

		expect(JSON.parse(fsSyncActual.readFileSync(target, "utf8"))).toEqual({ mcpServers: {} })
		expect(await fs.readdir(nested)).toEqual(["mcp.json"])
		expect(await fs.readdir(projectDir)).toEqual(["settings"])
	})

	test("refuses the commit when an ancestor is swapped while the staged write is in flight", async () => {
		const projectDir = path.join(tempDir, "midwrite-swap-project")
		const ancestor = path.join(projectDir, "settings")
		await fs.mkdir(ancestor, { recursive: true })
		const target = path.join(ancestor, "mcp.json")
		const swappedIn = path.join(tempDir, "midwrite-elsewhere", "settings")
		await fs.mkdir(swappedIn, { recursive: true })
		// The verification that runs before staging already passed by the time this hook
		// fires: trace reports write-start at the point where the staged file is about to be
		// written, so the ancestor moves inside the publish rather than hopefully so. The
		// commit rename is the statement that acts on the confinement decision, and it names
		// the path this write resolved before the swap.
		let swapped = false
		const error = await safeWriteJson(
			target,
			{ written: "payload" },
			{
				confineTo: projectDir,
				trace: (event) => {
					if (event.stage !== "write-start" || swapped) return
					swapped = true
					swapAncestorAfterTheCheck(ancestor, swappedIn)
				},
			},
		).then(
			() => undefined,
			(reason: unknown) => reason,
		)

		expect(error).toBeInstanceOf(AncestorReplacedError)
		expect(path.basename((error as AncestorReplacedError).directory)).toBe("settings")
		expect((error as AncestorReplacedError).message).toContain("nothing was published")
		// Nothing published into the swapped-in directory - not the target, and not the staged
		// file the swap had already redirected: the failure cleanup names the staged file
		// through the same path, which now resolves into the swapped-in copy.
		expect(await fs.readdir(swappedIn)).toEqual([])
		expect((await fs.readdir(ancestor + "-moved-aside")).filter((entry) => entry === "mcp.json")).toEqual([])

		// Contrast in the same fixture: put the directory back and the same write publishes.
		// Without this, the rejection above would also be the outcome of a publish that never
		// reached the rename. The name currently holds the link swapAncestorAfterTheCheck put
		// there - a junction on win32, a directory symlink on POSIX, where the helper calls the
		// same kind "dir" - and removeAncestorLink undoes it the way this platform removes that
		// shape. rmdirSync alone was wrong: the ubuntu coverage lane reported "ENOTDIR: not a
		// directory, rmdir '.../midwrite-swap-project/settings'".
		removeAncestorLink(ancestor)
		fsSyncActual.renameSync(ancestor + "-moved-aside", ancestor)
		// The failed write's lock release named the path, which at release time resolved through
		// the link, so the empty lock directory stayed in the moved-aside copy and came back with
		// the directory (the row above documents the same effect). Sweep it so the contrast write
		// is not queued behind a lock nobody holds.
		for (const entry of fsSyncActual.readdirSync(ancestor)) {
			if (entry.includes(".lock")) {
				fsSyncActual.rmSync(path.join(ancestor, entry), { recursive: true, force: true })
			}
		}
		await safeWriteJson(target, { written: "payload" }, { confineTo: projectDir })
		expect(JSON.parse(fsSyncActual.readFileSync(target, "utf8"))).toEqual({ written: "payload" })
	})
	test("refuses the commit when a moved ancestor's old name is replaced by a link back to it", async () => {
		const projectDir = path.join(tempDir, "moved-back-project")
		const ancestor = path.join(projectDir, "settings")
		await fs.mkdir(ancestor, { recursive: true })
		const target = path.join(ancestor, "mcp.json")
		// A directory rename preserves the inode, and a link placed at the old name points at
		// the moved directory, so a stat through the old name reports the SAME dev+ino the pin
		// recorded and the identity comparison passes. The publish takes path strings, so it
		// follows that link to wherever the directory went: what has to stop it is the
		// requirement that the authorized name still resolve to where it was walked.
		let swapped = false
		const error = await safeWriteJson(
			target,
			{ written: "payload" },
			{
				confineTo: projectDir,
				trace: (event) => {
					if (event.stage !== "write-start" || swapped) return
					swapped = true
					fsSyncActual.renameSync(ancestor, ancestor + "-moved-aside")
					fsSyncActual.symlinkSync(ancestor + "-moved-aside", ancestor, ancestorLinkKind)
				},
			},
		).then(
			() => undefined,
			(reason: unknown) => reason,
		)

		expect(error).toBeInstanceOf(AncestorReplacedError)
		expect(path.basename((error as AncestorReplacedError).directory)).toBe("settings")
		// The reason names the resolution rather than the identity, because the identity
		// comparison passed: this is the same directory, no longer at the location the
		// confinement check walked.
		expect((error as AncestorReplacedError).message).toContain("no longer resolves to the location")
		expect((await fs.readdir(ancestor + "-moved-aside")).filter((entry) => entry === "mcp.json")).toEqual([])
	})
	test("propagates a transient ancestor lookup failure instead of reporting a replaced ancestor", async () => {
		const projectDir = path.join(tempDir, "transient-project")
		const ancestor = path.join(projectDir, "settings")
		await fs.mkdir(ancestor, { recursive: true })
		const target = path.join(ancestor, "mcp.json")
		const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
		// Captured from the real module: the mocked namespace's stat is the property the spy
		// replaces, so delegating to it would recurse.
		const realStat = (await vi.importActual<typeof import("fs/promises")>("fs/promises")).stat
		let stagingStarted = false
		const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (candidate) => {
			const lookedUp = String(candidate)
			// Only the pinned directory, and only after the staged write began: the lookup
			// that fails here is the re-verification that runs immediately before the commit
			// rename. A permission error says nothing about whether the directory was
			// replaced, so it must reach the caller unchanged.
			if (stagingStarted && path.resolve(lookedUp) === path.resolve(ancestor)) {
				throw eacces
			}
			return realStat(lookedUp)
		})
		try {
			await expect(
				safeWriteJson(
					target,
					{ written: "payload" },
					{
						confineTo: projectDir,
						trace: (event) => {
							if (event.stage === "write-start") stagingStarted = true
						},
					},
				),
			).rejects.toBe(eacces)
		} finally {
			statSpy.mockRestore()
		}
		// Nothing published: the write stopped rather than guessing that a directory it could
		// not look at had been replaced and reporting that as a containment failure.
		expect(await fs.readdir(ancestor)).toEqual([])
	})
	test("reports what the target resolves to now when it no longer resolves to the pinned target", async () => {
		const projectDir = path.join(tempDir, "moved-target-project")
		const ancestor = path.join(projectDir, "settings")
		await fs.mkdir(ancestor, { recursive: true })
		const target = path.join(ancestor, "mcp.json")
		await fs.writeFile(target, JSON.stringify({ inside: true }), "utf8")
		// The resolution the confinement decision was made against, captured while it is still
		// the resolution on disk.
		const pinnedResolution = fsSyncActual.realpathSync(target)
		const swappedIn = path.join(tempDir, "moved-target-elsewhere", "settings")
		await fs.mkdir(swappedIn, { recursive: true })
		await fs.writeFile(path.join(swappedIn, "mcp.json"), JSON.stringify({ outside: true }), "utf8")

		const error = await safeWriteJson(
			target,
			{ written: "payload" },
			{
				confineTo: projectDir,
				merge: () => {
					swapAncestorAfterTheCheck(ancestor, swappedIn)
					return { written: "payload" }
				},
			},
		).then(
			() => undefined,
			(reason: unknown) => reason,
		)

		expect(error).toBeInstanceOf(TargetMovedError)
		// The error carries the resolution the write was authorized against and the resolution
		// the path has NOW, so the reader can tell which side of the swap each name means
		// instead of being shown the authorized path twice.
		expect((error as TargetMovedError).authorizedPath).toBe(pinnedResolution)
		expect((error as TargetMovedError).resolvedPath).toBe(
			fsSyncActual.realpathSync(path.join(swappedIn, "mcp.json")),
		)
		expect((error as TargetMovedError).resolvedPath).not.toBe((error as TargetMovedError).authorizedPath)
		expect(JSON.parse(fsSyncActual.readFileSync(path.join(swappedIn, "mcp.json"), "utf8"))).toEqual({
			outside: true,
		})
	})
	test("holds the confined scope to the directory named before the lock when a peer replaces that name", async () => {
		const projectDir = path.join(tempDir, "pinned-scope-project")
		await fs.mkdir(projectDir)
		const target = path.join(projectDir, "mcp.json")
		const arrivedDir = path.join(tempDir, "pinned-scope-arrived")
		await fs.mkdir(arrivedDir)
		// Captured before the spy is installed: calling the namespace property from inside the
		// implementation would recurse through the spy itself.
		const realAcquire = fileLockModule.acquireFileLock
		// Everything the pre-lock check sees is inside projectDir. While this writer waits for
		// the advisory lock, projectDir is moved aside and a link to a different directory is
		// left at its name, so every lookup made with the lock held finds the scope somewhere
		// else. Re-resolving confineTo there would bless the directory that arrived: the write
		// is confined to the directory the caller named.
		const lockSpy = vi.spyOn(fileLockModule, "acquireFileLock").mockImplementation(async (key: string) => {
			const release = await realAcquire(key)
			fsSyncActual.renameSync(projectDir, projectDir + "-moved-aside")
			fsSyncActual.symlinkSync(arrivedDir, projectDir, ancestorLinkKind)
			return release
		})
		let captured: unknown = null
		try {
			captured = await safeWriteJson(target, { written: "payload" }, { confineTo: projectDir }).then(
				() => null,
				(reason: unknown) => reason,
			)
		} finally {
			lockSpy.mockRestore()
		}

		expect(captured).toBeInstanceOf(ConfinedPathEscapeError)
		// Nothing was published into the directory that arrived at the scope's name.
		expect(await fs.readdir(arrivedDir)).toEqual([])
		// Nor into the directory the caller named, which is now behind a link. (The advisory
		// lock lives beside the key and moves with the directory; it holds no published content.)
		expect((await fs.readdir(projectDir + "-moved-aside")).filter((entry) => !entry.endsWith(".lock"))).toEqual([])
	})
	test("does not recover an interrupted write through an ancestor that was replaced while the lock was waited for", async () => {
		const projectDir = path.join(tempDir, "recovery-confined-project")
		const ancestor = path.join(projectDir, "settings")
		await fs.mkdir(ancestor, { recursive: true })
		const swappedIn = path.join(tempDir, "recovery-elsewhere", "settings")
		await fs.mkdir(swappedIn, { recursive: true })
		// An orphaned backup from an interrupted write, belonging to whatever file lives in the
		// directory behind the ancestor's name now. Recovery renames a backup like this into the
		// target's directory, so it is the step that can publish outside the scope.
		const leftover = `.mcp.json.bak_${Date.now()}_abcdef.tmp`
		await fs.writeFile(path.join(swappedIn, leftover), JSON.stringify({ previous: true }), "utf8")
		const target = path.join(ancestor, "mcp.json")
		const realAcquire = fileLockModule.acquireFileLock
		const lockSpy = vi.spyOn(fileLockModule, "acquireFileLock").mockImplementation(async (key: string) => {
			const release = await realAcquire(key)
			// The swap lands while this writer waits for the lock, so the recovery step is the
			// first thing that touches the tree with the swapped directory already in place.
			swapAncestorAfterTheCheck(ancestor, swappedIn)
			return release
		})
		let captured: unknown = null
		try {
			captured = await safeWriteJson(target, { written: "payload" }, { confineTo: projectDir }).then(
				() => null,
				(reason: unknown) => reason,
			)
		} finally {
			lockSpy.mockRestore()
		}

		expect(captured).toBeInstanceOf(ConfinedPathEscapeError)
		// The backup is still where it was found, and no file was published into the directory
		// outside the scope. Running recovery before the confinement decision was re-verified
		// would have renamed this backup onto the target name, moving a file the caller never
		// authorized out of the scope and consuming it as if it were this file's own history.
		expect(await fs.readdir(swappedIn)).toEqual([leftover])
	})
	test("creates the staged JSON private and puts the target's own mode on it before publishing", async () => {
		const target = path.join(tempDir, "mode-target.json")
		await fs.writeFile(target, JSON.stringify({ existing: true }), "utf8")
		await fs.chmod(target, 0o600)
		// The mode as this platform reports it: Windows synthesizes the mode from the read-only
		// attribute, so a 0o600 file is reported as writable there. The mode the publish copies is
		// whatever stat reports, and the assertions below read it back rather than assuming the
		// spelling.
		const targetMode = (await fs.stat(target)).mode & 0o777
		// Captured from the real module: createWriteStream on the mocked namespace is the
		// property the spy replaces, and fs.stat is the mocked stat.
		const realCreate = (await vi.importActual<typeof import("fs")>("fs")).createWriteStream
		const staged: { path: string; creationMode: number | undefined; modeWhileStaged: number | undefined }[] = []
		const createSpy = vi.spyOn(fsSyncActual, "createWriteStream").mockImplementation(((
			filePath: string,
			options: { mode?: number } = {},
		) => {
			const stream = realCreate(filePath, options)
			const record = {
				path: filePath,
				creationMode: options.mode,
				modeWhileStaged: undefined as number | undefined,
			}
			// createWriteStream opens the file lazily, so the staged file's own mode is read
			// when the open lands - before the content is streamed and long before the rename
			// buries the name in the target.
			stream.on("open", () => {
				record.modeWhileStaged = fsSyncActual.statSync(filePath).mode & 0o777
			})
			staged.push(record)
			return stream
		}) as never)
		const chmodSpy = vi.spyOn(fs, "chmod")
		// Read from the spy before mockRestore: restoring clears the call history, and the
		// assertions below run after the finally block.
		let chmodCalls: { stagedPath: string; mode: number }[] = []
		let failure: unknown = null
		try {
			failure = await safeWriteJson(target, { written: "payload" }, { confineTo: tempDir }).then(
				() => null,
				(reason: unknown) => reason,
			)
			chmodCalls = chmodSpy.mock.calls.map((call) => ({ stagedPath: String(call[0]), mode: call[1] as number }))
		} finally {
			createSpy.mockRestore()
			chmodSpy.mockRestore()
		}

		expect(failure).toBeNull()
		expect(staged).toHaveLength(1)
		// The staged file is created private. It holds the caller's content for the whole time
		// it takes to stream, flush and copy the target's mode onto it, and a mode copy can only
		// narrow a file that is already restricted - a file created with the process umask is
		// group- and world-readable for that whole window.
		expect(staged[0].creationMode).toBe(0o600)
		// The target's own mode is still the mode that gets published.
		// The target's own mode, whatever this platform reports it as, is copied onto the staged
		// file, which is the file the rename publishes.
		expect(
			chmodCalls.some(
				(call) => path.resolve(call.stagedPath) === path.resolve(staged[0].path) && call.mode === targetMode,
			),
		).toBe(true)
		if (process.platform !== "win32") {
			// Windows derives the mode from the read-only attribute, so the observed mode is
			// only evidence on platforms that store one.
			expect(staged[0].modeWhileStaged).toBe(0o600)
			expect((await fs.stat(target)).mode & 0o777).toBe(targetMode)
		}
		expect(JSON.parse(fsSyncActual.readFileSync(target, "utf8"))).toEqual({ written: "payload" })
	})
	test("publishes over a target whose mode is wider than the staged file's", async () => {
		const target = path.join(tempDir, "mode-wider-target.json")
		await fs.writeFile(target, JSON.stringify({ existing: true }), "utf8")
		await fs.chmod(target, 0o664)
		// Both sides of the mode test above are 0o600, so an implementation that published the
		// staged file's private mode onto the target - the copy running the wrong way round - still
		// passed it. Here the target starts wider than the staged file, so only a copy in the right
		// direction can leave a group-readable target behind: a hardcoded 0o600 would quietly take
		// group read away from a file the caller had deliberately left group-readable.
		const targetMode = (await fs.stat(target)).mode & 0o777
		const chmodSpy = vi.spyOn(fs, "chmod")
		let chmodModes: number[] = []
		let failure: unknown = null
		try {
			failure = await safeWriteJson(target, { written: "payload" }, { confineTo: tempDir }).then(
				() => null,
				(reason: unknown) => reason,
			)
			// Read from the spy before mockRestore: restoring clears the call history.
			chmodModes = chmodSpy.mock.calls.map((call) => call[1] as number)
		} finally {
			chmodSpy.mockRestore()
		}
		expect(failure).toBeNull()
		expect(JSON.parse(fsSyncActual.readFileSync(target, "utf8"))).toEqual({ written: "payload" })
		// The mode handed to chmod is the target's own mode, read back rather than assumed, so the
		// copy is pinned to the right direction on every platform. Windows synthesizes the reported
		// mode from the read-only attribute, so the number here is 0o666 for a 0o664 request; the
		// point is that it is not the staged file's 0o600.
		expect(chmodModes).toContain(targetMode)
		if (process.platform !== "win32") {
			// The end state, on a platform that actually stores a mode: the target is still
			// group-readable after the publish, at the mode the caller put on it.
			expect((await fs.stat(target)).mode & 0o777).toBe(0o664)
		}
	})
	test("aborts the publish when the staged file cannot take the target's mode", async () => {
		const target = path.join(tempDir, "chmod-fail-target.json")
		await fs.writeFile(target, JSON.stringify({ existing: true }), "utf8")
		await fs.chmod(target, 0o600)
		const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
		const realChmod = (await vi.importActual<typeof import("fs/promises")>("fs/promises")).chmod
		const chmodSpy = vi.spyOn(fs, "chmod").mockImplementation(async (candidate, mode) => {
			const stagedPath = String(candidate)
			if (stagedPath.includes(".new_")) {
				// The staged file is what becomes the target. Publishing it with its own mode
				// would replace a 0o600 file with a wider one, which is the failure this step
				// exists to prevent.
				throw eacces
			}
			return realChmod(stagedPath, mode as number)
		})
		let captured: unknown = null
		try {
			captured = await safeWriteJson(target, { written: "payload" }, { confineTo: tempDir }).then(
				() => null,
				(reason: unknown) => reason,
			)
		} finally {
			chmodSpy.mockRestore()
		}

		expect(captured).toBeInstanceOf(Error)
		expect((captured as Error).message).toContain("could not copy mode")
		// The committed target still holds the content it had, at the mode it had.
		expect(JSON.parse(fsSyncActual.readFileSync(target, "utf8"))).toEqual({ existing: true })
		expect((await fs.readdir(tempDir)).filter((entry) => entry.includes(".new_"))).toEqual([])
	})
	test("aborts the publish when the target's mode cannot be read", async () => {
		const target = path.join(tempDir, "stat-fail-target.json")
		await fs.writeFile(target, JSON.stringify({ existing: true }), "utf8")
		const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
		const realStat = (await vi.importActual<typeof import("fs/promises")>("fs/promises")).stat
		const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (candidate) => {
			if (path.resolve(String(candidate)) === path.resolve(target)) {
				// The target is there but unreadable-by-us: its mode is unknown, so the mode the
				// publish would land cannot be checked, and proceeding with the staged file's own
				// mode is the one answer that can widen a restrictive file.
				throw eacces
			}
			return realStat(String(candidate))
		})
		let captured: unknown = null
		try {
			captured = await safeWriteJson(target, { written: "payload" }, { confineTo: tempDir }).then(
				() => null,
				(reason: unknown) => reason,
			)
		} finally {
			statSpy.mockRestore()
		}

		expect(captured).toBeInstanceOf(Error)
		expect((captured as Error).message).toContain("could not read the mode")
		expect(JSON.parse(fsSyncActual.readFileSync(target, "utf8"))).toEqual({ existing: true })
		expect((await fs.readdir(tempDir)).filter((entry) => entry.includes(".new_"))).toEqual([])
	})
	it("keeps the published target with its new content when the post-commit directory fsync fails", async () => {
		const fsSyncMod = await import("fs")
		const realFsync = fsSyncMod.fsyncSync
		// The parent-directory fsync is the only fsync that runs after the commit rename.
		// Watching the rename itself - rather than fabricating a descriptor - keeps the SUT
		// in charge of opening and closing its own real directory handle, so the injected
		// fsync failure is the only error in flight on every platform.
		const fsyncFailure = new Error("EIO fsync")
		let committed = false
		// One entry per fsyncSync call, recording which descriptor was flushed and whether the
		// commit rename had already landed. Watching the calls rather than the log is what makes
		// the assertion below able to tell a failed directory fsync from a directory that was
		// never opened at all: both paths end in the same warning.
		const fsyncCalls: { fd: number; afterCommit: boolean }[] = []
		const actualRename = fsPromisesActuals.rename!
		vi.mocked(fs.rename).mockImplementation((async (from: string, to: string) => {
			await actualRename(from, to)
			committed = true
		}) as typeof fs.rename)
		vi.spyOn(process, "platform", "get").mockReturnValue("linux")
		// Spied without replacing: the directory handle this write opens is the evidence that
		// the descriptor the fsync below names belongs to the committed target's parent.
		const openSpy = vi.spyOn(fsSyncMod, "openSync")
		vi.spyOn(fsSyncMod, "fsyncSync").mockImplementation(((fd: number) => {
			fsyncCalls.push({ fd, afterCommit: committed })
			if (committed) {
				throw fsyncFailure
			}
			return (realFsync as (f: number) => unknown)(fd)
		}) as never)
		// Earlier tests in this file leave unlink history on the shared mock.
		vi.mocked(fs.unlink).mockClear()
		const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const failure: unknown = await safeWriteJson(currentTestFilePath, { fresh: "content" }).then(
			() => null,
			(error: unknown) => error,
		)
		// The protocol that ships here treats the post-commit parent-directory fsync as best
		// effort: the publish already happened, so a failed directory fsync is reported and the
		// write completes. (The chain's earlier mechanism wrapped it in PostCommitDurabilityError
		// and rejected; that wrapper is not part of this protocol - see the merge note above.)
		expect(failure).toBeNull()
		const parentDir = path.dirname(path.resolve(currentTestFilePath))
		const directoryHandles = openSpy.mock.calls.flatMap((call, index) =>
			path.resolve(String(call[0])) === parentDir ? [openSpy.mock.results[index]?.value as number] : [],
		)
		// The directory the published file now lives in was opened, ...
		expect(directoryHandles.length).toBeGreaterThan(0)
		// ... and a fsync actually ran on that handle after the commit rename. Without this, the
		// warning below is satisfied by the same log line that reports "the directory could not
		// be opened", in which case no fsync ever executed.
		expect(fsyncCalls.some((call) => call.afterCommit && directoryHandles.includes(call.fd))).toBe(true)
		// The warning names the directory that was not flushed.
		expect(consoleWarnSpy.mock.calls.some((call) => /fsync/.test(String(call[0])))).toBe(true)
		// The rename committed: the target must still hold the new JSON, not be unlinked away
		// by the catch cleanup of the consumed staging path.
		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual({ fresh: "content" })
		// The cleanup must not unlink the consumed staging path: after the commit rename it is
		// no longer this write's file to remove.
		const stagingUnlinks = vi.mocked(fs.unlink).mock.calls.filter((call) => /\.new_.*\.tmp$/.test(String(call[0])))
		expect(stagingUnlinks).toHaveLength(0)
		consoleWarnSpy.mockRestore()
	})
})
