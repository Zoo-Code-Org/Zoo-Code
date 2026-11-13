import * as fsSyncActual from "fs"
import { Writable } from "stream"
import * as path from "path"
import * as os from "os"

import { ConfinedPathEscapeError, safeWriteJson } from "../safeWriteJson"

// Capture actual implementations before the vi.mock factory runs,
// so they are never wrapped by vi.fn() — avoids infinite recursion when
// test mockImplementation callbacks delegate to the real implementation.
const fsPromisesActuals = vi.hoisted(() => ({
	rename: undefined as (typeof import("fs/promises"))["rename"] | undefined,
	unlink: undefined as (typeof import("fs/promises"))["unlink"] | undefined,
	writeFile: undefined as (typeof import("fs/promises"))["writeFile"] | undefined,
}))

// The fs mock delegates createWriteStream to the implementation captured here, so a test can
// replace the mock for one call and still let the write reach the real filesystem.
const fsSyncActuals = vi.hoisted(() => ({
	createWriteStream: undefined as (typeof import("fs"))["createWriteStream"] | undefined,
	openSync: undefined as (typeof import("fs"))["openSync"] | undefined,
	fchmodSync: undefined as (typeof import("fs"))["fchmodSync"] | undefined,
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
	fsSyncActuals.createWriteStream = actualFs.createWriteStream
	// openSync and fchmodSync are doubled for the same reason createWriteStream is: the mode rows
	// below read what production passed, and the default delegates to the real call so the write
	// still lands on disk.
	fsSyncActuals.openSync = actualFs.openSync
	fsSyncActuals.fchmodSync = actualFs.fchmodSync
	return {
		...actualFs, // Spread actual implementations
		createWriteStream: vi.fn(actualFs.createWriteStream), // Default to actual, but mockable
		openSync: vi.fn(actualFs.openSync),
		fchmodSync: vi.fn(actualFs.fchmodSync),
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
	// Row 4507642592: the commit rename publishes the staging inode, so the mode the staging file is
	// created with becomes the target's mode. These rows pin that the staging file is created as
	// open or as private as the file it replaces, instead of with the process default.
	describe("staging file mode", () => {
		// Production states the mode twice, in the two places it has to be stated: the open, whose
		// creation mode the process umask narrows, and one fchmod on the descriptor, which is what
		// lands the mode exactly. Node's WriteStream also fills a missing mode in on the options
		// object it is handed, so a call log read afterwards shows a normalized object rather than
		// what was passed; both arguments here are recorded at the moment production passes them and
		// then handed to the real call, so the write still lands on disk. -1 in the open recording
		// stands for "no mode was passed"; no entry in the fchmod recording stands for "there was
		// no publish target to copy a mode from".
		type StagingModeCalls = { openedWith: number[]; chmoddedTo: number[] }
		function captureStagingModeCalls(): StagingModeCalls {
			const openedWith: number[] = []
			const chmoddedTo: number[] = []
			const realOpenSync = fsSyncActuals.openSync!
			const realFchmodSync = fsSyncActuals.fchmodSync!
			vi.mocked(fsSyncActual.openSync).mockImplementation(function (filePath, flags, mode) {
				const passed: unknown = mode
				openedWith.push(
					passed === undefined
						? -1
						: typeof passed === "string"
							? Number.parseInt(passed, 8)
							: Number(passed),
				)
				return realOpenSync(
					filePath as Parameters<typeof realOpenSync>[0],
					flags as Parameters<typeof realOpenSync>[1],
					mode,
				)
			})
			vi.mocked(fsSyncActual.fchmodSync).mockImplementation(function (filePath, mode) {
				chmoddedTo.push(Number(mode))
				return realFchmodSync(filePath, mode)
			})
			return { openedWith, chmoddedTo }
		}

		it("opens the staging file at the publish target's mode and chmods it to exactly that", async () => {
			await fs.chmod(currentTestFilePath, 0o600)
			// Read back the mode the filesystem reports for the target instead of asserting a literal:
			// Windows carries per-user rights in the DACL and reports a coarse mode, and the claim under
			// test is that the staging file is brought to the target's mode, on every platform.
			const targetMode = (await fs.stat(currentTestFilePath)).mode & 0o777
			const modeCalls = captureStagingModeCalls()

			await safeWriteJson(currentTestFilePath, { updated: "content" })

			expect(modeCalls.openedWith.length).toBe(1)
			expect(modeCalls.openedWith[0]).toBe(targetMode)
			// The fchmod is the half that survives the umask: the open alone can only ask for this
			// mode, and the filesystem answers at most what the mask leaves. One call, on the
			// descriptor the write is about to use.
			expect(modeCalls.chmoddedTo).toEqual([targetMode])
			expect(await readFileContent(currentTestFilePath)).toEqual({ updated: "content" })
		})

		it("opens the staging file with the creation default when the target does not exist yet", async () => {
			const missingTarget = path.join(tempDir, "not-written-yet.json")
			const modeCalls = captureStagingModeCalls()

			await safeWriteJson(missingTarget, { created: "content" })

			// Nothing is being replaced, so there is no mode to carry over, and a mode invented here
			// would be this write deciding how private a file it has not created yet should be. No
			// publish target means no fchmod either, which is the same rule safeWriteText applies to a
			// fresh target.
			expect(modeCalls.openedWith.length).toBe(1)
			expect(modeCalls.openedWith[0]).toBe(-1)
			expect(modeCalls.chmoddedTo).toEqual([])
			expect(await fileExists(missingTarget)).toBe(true)
		})

		// Row 4507855186. The target-mode read is the one stat in this writer whose failure has to stop the
		// write. A target that is not there yet has no mode to carry over, so absence is a verdict; any other
		// failure means the mode of the file being replaced is unknown, and defaulting on it publishes a
		// private target with the creation default. These rows inject the two non-absence codes at the
		// publish target itself - the writer stats the resolved path, so the match is made against both
		// spellings - and delegate every other stat to the real filesystem.
		async function blockTargetModeRead(code: string): Promise<{
			failure: Error
			statPaths: string[]
			restore: () => void
		}> {
			const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
			const statPaths: string[] = []
			const spellings = new Set<string>([currentTestFilePath])
			try {
				spellings.add(await actual.realpath(currentTestFilePath))
			} catch {
				// A target that cannot be realpath'd is matched by its own spelling only.
			}
			const failure = Object.assign(new Error(code + ": the target-mode stat could not read the mode"), {
				code,
			}) as Error
			const realStat = actual.stat
			vi.mocked(fs.stat).mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
				const keyed = String(args[0])
				statPaths.push(keyed)
				if (spellings.has(keyed)) {
					throw failure
				}
				return (realStat as typeof fs.stat)(...args)
			})
			// restoreAllMocks does not bring back an implementation that a test installed over a factory
			// double, so the delegation back to the real stat is put back here rather than left to the hook.
			return {
				failure,
				statPaths,
				restore: () => {
					vi.mocked(fs.stat).mockImplementation(((...args: Parameters<typeof fs.stat>) =>
						Reflect.apply(actual.stat, actual, args)) as typeof fs.stat)
				},
			}
		}

		async function runAgainstUnreadableMode(code: string): Promise<void> {
			const injected = await blockTargetModeRead(code)
			// Call counts are read as a delta: this suite restores mock implementations between rows but
			// the doubles keep the history of earlier rows, so an absolute not-to-have-been-called would be a
			// claim about the whole file rather than about this write.
			const streamsBefore = vi.mocked(fsSyncActual.createWriteStream).mock.calls.length
			const renamesBefore = vi.mocked(fs.rename).mock.calls.length
			const before = await readFileContent(currentTestFilePath)
			const stages: string[] = []
			let failure: unknown
			try {
				await safeWriteJson(
					currentTestFilePath,
					{ updated: "content" },
					{
						trace: (event: { stage: string }) => {
							stages.push(event.stage)
						},
					},
				)
			} catch (error: unknown) {
				failure = error
			} finally {
				injected.restore()
			}
			expect(failure).toBe(injected.failure)
			// The stage list records where the writer stopped. It announces the write before reading the mode,
			// so write-start is present; the load-bearing facts are that the staging stream is never opened
			// and the target is never renamed onto. The stat list is the proof that the injected failure landed
			// on the target-mode read and not on some other stat: that read is the only one this writer
			// makes before it fails, and it is the read that threw, because only a stat of the publish
			// target raises the injected error. The spelling is deliberately not asserted - on the hosted
			// lanes the temporary directory is reported under a different name by realpath than os.tmpdir
			// returned, which is a fact about the runner and not about this writer.
			expect(stages).toEqual(["write-start"])
			expect(injected.statPaths.length).toBe(1)
			expect(vi.mocked(fsSyncActual.createWriteStream).mock.calls.length).toBe(streamsBefore)
			expect(vi.mocked(fs.rename).mock.calls.length).toBe(renamesBefore)
			expect(await readFileContent(currentTestFilePath)).toEqual(before)
		}

		it("propagates an EACCES on the target-mode stat and publishes nothing", async () => {
			await runAgainstUnreadableMode("EACCES")
		})

		it("propagates an EIO on the target-mode stat and publishes nothing", async () => {
			await runAgainstUnreadableMode("EIO")
		})

		// The end-to-end mode assertion is made where modes mean what the assertion says they mean.
		it.runIf(process.platform !== "win32")("keeps a 0o600 file private through an update", async () => {
			await fs.chmod(currentTestFilePath, 0o600)

			await safeWriteJson(currentTestFilePath, { updated: "content" })

			const published = await fs.stat(currentTestFilePath)
			expect(published.mode & 0o777).toBe(0o600)
			expect(await readFileContent(currentTestFilePath)).toEqual({ updated: "content" })
		})
		// Row 4507851727. The direction the row above cannot see: a mask only takes bits away, so a
		// restrictive target lands unchanged whether or not the mode was applied exactly, and the
		// assertion that separates the two shapes is a group-writable target under a narrowing mask.
		// The mask is set for the row rather than relied on, because the value that narrows 0o664 to
		// 0o644 is the process's own and not something this row should inherit from a runner.
		// Executed by the ubuntu coverage lane, not verified locally: on Windows the creation mode
		// carries only the read-only bit, so 0o664 is not a mode a landed file can report and the
		// row answers as skipped there.
		it.runIf(process.platform !== "win32")(
			"keeps a 0o664 target group-writable through an update under a 0o022 umask",
			async () => {
				await fs.chmod(currentTestFilePath, 0o664)
				const umaskBefore = process.umask(0o022)
				try {
					await safeWriteJson(currentTestFilePath, { updated: "content" })
					const published = await fs.stat(currentTestFilePath)
					expect(published.mode & 0o777).toBe(0o664)
					expect(await readFileContent(currentTestFilePath)).toEqual({ updated: "content" })
				} finally {
					process.umask(umaskBefore)
				}
			},
		)
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

	// Test for best-effort backup deletion (the backup lifecycle now lives in safeWriteText)
	test("does not fail the write when backup deletion fails (orphaned backup is acceptable)", async () => {
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

		// The write must still succeed: backup cleanup is best-effort inside
		// safeWriteText and never masks the committed content.
		await safeWriteJson(currentTestFilePath, newData)

		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual(newData)

		// The orphaned backup is still on disk because its deletion failed. It is named from the
		// target's basename, which is the prefix the leftover scan reads.
		const entries = await fs.readdir(tempDir)
		const backupPrefix = `.${path.basename(currentTestFilePath)}.bak_`
		expect(entries.some((entry) => entry.startsWith(backupPrefix))).toBe(true)

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
		// vi.unmock is hoisted above the imports, so it would run before the doMock above and
		// leave the wrapper installed for every later import; doUnmock runs here, in order, the
		// way this file's other capture/undo pairs spell it.
		vi.doUnmock("proper-lockfile") // Ensure the mock is removed after this test
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
		// The counter belongs to the test, not to the write: the failed write above already spent
		// its four branches, so the merge write is measured as the difference it makes, and read
		// against the stage list the guard itself reports. The commit rename is the one rename the
		// write attempts on its own account; the failed write above left the committed content in a
		// backup with the canonical path gone, so the recovery pass at the start of this write is
		// allowed one more rename, the restore the guard reports as the recover stage.
		const mergeStages: string[] = []
		const renamesBeforeMerge = renameCallCount
		await safeWriteJson(currentTestFilePath, newData, {
			merge: (existing) => {
				expect(existing).toEqual(initialData)
				return newData
			},
			trace: ({ stage }) => mergeStages.push(stage),
		})

		// Exactly one rename was attempted on the write's own account, and it was the commit.
		expect(renameCallCount - renamesBeforeMerge).toBe(mergeStages.includes("recover") ? 2 : 1)

		// The recovery pass put the committed content back on the target before this write
		// merged onto it - that is what the merge callback saw - so the reader now sees the merged
		// value, and the recovered backup that made it possible is gone from the directory.
		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual(newData)
		const entries = await fs.readdir(tempDir)
		expect(entries.some((entry) => entry.includes(".bak_"))).toBe(false)

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
	// (A re-land above dropped "acquires the lock on the resolved referent, not the caller alias" and
	// "resolves the real proper-lockfile after the capture above is undone" as rows about a retired
	// spelling, while the lock key was being taken from the path the caller gave. The key is resolved
	// before the lock again (safeWriteJson.ts:327), so the referent question is live: it is answered in
	// safeWriteJson.lockKey.spec.ts, and the proper-lockfile row below stayed in this file and passes on
	// its own terms now that the undo runs in order rather than being hoisted above the imports.)

	// The undo in the case above has to be visible from the other side of the file: a later
	// test that imports proper-lockfile fresh must resolve the real module, not the wrapper
	// that case installed for its own import graph. This is the case that reddens when the
	// undo is written as vi.unmock -- Vitest hoists that call above the imports, so it is
	// registered before the vi.doMock above runs, the wrapper is never removed, and it is
	// what a later import resolves.
	test("resolves the real proper-lockfile after the capture above is undone", async () => {
		vi.resetModules()
		const realLockfile = await vi.importActual<typeof import("proper-lockfile")>("proper-lockfile")
		const imported = await import("proper-lockfile")

		expect(imported.lock).toBe(realLockfile.lock)
		expect(vi.isMockFunction(imported.lock)).toBe(false)
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

	test("treats an empty confineTo as a declared scope rather than as no scope", async () => {
		const cwd = process.cwd()
		// An empty string is a scope declaration: _resolveScopeRoot runs it through
		// path.resolve, which yields the process working directory. The temp target has
		// to sit outside that directory for this test to be about the scope rather than
		// about where the temp files happen to live, so the precondition is asserted.
		const outside = path.join(tempDir, "empty-scope.json")
		expect(path.resolve(outside).startsWith(cwd + path.sep)).toBe(false)
		expect(path.resolve(outside)).not.toBe(cwd)

		await expect(safeWriteJson(outside, { mcpServers: {} }, { confineTo: "" })).rejects.toBeInstanceOf(
			ConfinedPathEscapeError,
		)

		// Rejected the way every other confinement rejection is: nothing written.
		expect(await fs.readdir(tempDir)).not.toContain("empty-scope.json")
	})

	test("rejects an in-scope dangling symlink to an outside referent before the advisory lock", async () => {
		// The fixture needs a dangling link, and the two platforms build that shape
		// differently: an unprivileged Windows cannot create a file or directory symlink
		// at all (EPERM), while a junction needs no privilege, resolves through Node's
		// reparse handling and reports as a symbolic link to a path that does not exist -
		// the same lstat/realpath pair the POSIX file symlink produces. lstat of the
		// junction here reports isSymbolicLink true and realpath reports ENOENT, which is
		// the branch resolvePublishTarget and the lock-key walk take on either platform,
		// so the row runs everywhere instead of only where a file link is permitted.
		const projectDir = path.join(tempDir, "dangling-scope")
		await fs.mkdir(projectDir)
		const outsideDir = path.join(tempDir, "dangling-outside")
		await fs.mkdir(outsideDir)
		const link = path.join(projectDir, "link.json")
		// junction on win32, file symlink elsewhere; the type is what makes the same
		// dangling-link shape buildable on both lanes.
		const linkType: "junction" | "file" = process.platform === "win32" ? "junction" : "file"
		await fs.symlink(path.join(outsideDir, "gone.json"), link, linkType)

		const realLockfile = await vi.importActual<typeof import("proper-lockfile")>("proper-lockfile")
		const lockCalls: string[] = []
		const lockMock = vi.fn(async (file: unknown, options?: unknown) => {
			lockCalls.push(String(file))
			return realLockfile.lock(file as never, options as never)
		})
		vi.doMock("proper-lockfile", () => ({
			...realLockfile,
			lock: lockMock as unknown as typeof realLockfile.lock,
		}))

		vi.resetModules()
		const { safeWriteJson: reimported, ConfinedPathEscapeError: ReimportedError } = await import("../safeWriteJson")

		try {
			const outcome = await reimported(link, { mcpServers: {} }, { confineTo: projectDir }).then(
				function (value: unknown) {
					return { ok: true as const, value: value, error: undefined as unknown }
				},
				function (error: unknown) {
					return { ok: false as const, value: undefined as unknown, error: error }
				},
			)
			// A dangling link resolves to its referent for the lock key, and the referent
			// is outside the declared scope, so the second confinement check rejects
			// before the lock file - which proper-lockfile writes NEXT TO the key - is
			// ever attempted. Asserted first, because the point of the row is the
			// ordering: a rejection that arrives after a lock is a rejection that already
			// wrote outside the scope.
			expect(lockCalls).toEqual([])
			expect(outcome.ok).toBe(false)
			expect(outcome.error).toBeInstanceOf(ReimportedError)
			expect(
				(await fs.readdir(outsideDir)).filter(function (entry: string) {
					return entry.endsWith(".lock")
				}),
			).toEqual([])
			expect(
				(await fs.readdir(projectDir)).filter(function (entry: string) {
					return entry.endsWith(".lock")
				}),
			).toEqual([])
			expect((await fs.readdir(projectDir)).sort()).toEqual(["link.json"])
		} finally {
			vi.doUnmock("proper-lockfile")
			vi.resetModules()
		}
	})

	test("rejects an out-of-scope target before the advisory lock is taken", async () => {
		const projectDir = path.join(tempDir, "scope")
		await fs.mkdir(projectDir)
		const outside = path.join(tempDir, "elsewhere.json")

		// Capture every lock attempt without changing how locking works. The lock file
		// lives NEXT TO the key, so taking the lock on an out-of-scope referent already
		// writes outside the scope the caller declared - and an unwritable directory
		// there would surface a lock error instead of the confinement verdict.
		const realLockfile = await vi.importActual<typeof import("proper-lockfile")>("proper-lockfile")
		const lockCalls: string[] = []
		const lockMock = vi.fn(async (file: unknown, options?: unknown) => {
			lockCalls.push(String(file))
			return realLockfile.lock(file as never, options as never)
		})
		vi.doMock("proper-lockfile", () => ({
			...realLockfile,
			lock: lockMock as unknown as typeof realLockfile.lock,
		}))

		// Re-import the whole graph so the SUT AND its fileLock dependency pick up the
		// wrapped lock; without the reset, fileLock keeps the already-loaded real
		// proper-lockfile and the capture never sees a call. The error class is taken from
		// the same module instance the SUT came from.
		vi.resetModules()
		const { safeWriteJson: reimported, ConfinedPathEscapeError: ReimportedError } = await import("../safeWriteJson")

		try {
			await expect(reimported(outside, { mcpServers: {} }, { confineTo: projectDir })).rejects.toThrow(
				ReimportedError,
			)

			// The confinement verdict came first: no lock was ever attempted.
			expect(lockCalls).toEqual([])
			expect(
				(await fs.readdir(tempDir)).filter(function (entry: string) {
					return entry.endsWith(".lock")
				}),
			).toEqual([])
		} finally {
			vi.doUnmock("proper-lockfile")
			vi.resetModules()
		}
	})

	test("rejects an out-of-scope target before creating any directory", async () => {
		const projectDir = path.join(tempDir, "scope")
		await fs.mkdir(projectDir)
		// The target lives in a directory that does not exist. A confinement check that runs
		// after the mkdir -p would create that directory OUTSIDE the declared scope first -
		// the same side effect the pre-lock check exists to prevent, reached through a
		// symlinked ancestor in the reported case - and an unwritable referent would surface
		// the mkdir error instead of the confinement verdict.
		const missingParent = path.join(tempDir, "no-such-dir")
		const outside = path.join(missingParent, "elsewhere.json")

		await expect(safeWriteJson(outside, { mcpServers: {} }, { confineTo: projectDir })).rejects.toThrow(
			ConfinedPathEscapeError,
		)

		// Nothing was created outside the scope, and no lock was attempted there.
		expect(fsSyncActual.existsSync(missingParent)).toBe(false)
		expect(
			(await fs.readdir(tempDir)).filter(function (entry: string) {
				return entry.endsWith(".lock")
			}),
		).toEqual([])
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
		"publishes over a symlink referent that stays inside the confined directory",
		async () => {
			const projectDir = path.join(tempDir, "project-in")
			await fs.mkdir(projectDir)
			const referent = path.join(projectDir, "real-mcp.json")
			await fsSyncActual.promises.writeFile(referent, JSON.stringify({ mcpServers: {} }), "utf8")
			const alias = path.join(projectDir, "mcp.json")
			await fs.symlink(referent, alias)

			// Confining is about the scope, not about forbidding links: the write lands on the
			// target the under-lock resolution named -- the referent -- and not on the link node.
			// The alias therefore stays a link and reads through to the payload, while the referent
			// that holds the shared lock carries this writer's content in place of its seed.
			await safeWriteJson(
				alias,
				{ mcpServers: { local: { url: "http://localhost" } } },
				{ confineTo: projectDir },
			)

			expect(JSON.parse(await fsSyncActual.promises.readFile(alias, "utf8"))).toEqual({
				mcpServers: { local: { url: "http://localhost" } },
			})
			expect(JSON.parse(await fsSyncActual.promises.readFile(referent, "utf8"))).toEqual({
				mcpServers: { local: { url: "http://localhost" } },
			})
			expect(fsSyncActual.lstatSync(alias).isSymbolicLink()).toBe(true)
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
})
