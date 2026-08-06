// npx vitest run src/utils/__tests__/safeUpdateJson.test.ts

import * as fsSyncActual from "fs"
import type { WriteStream } from "fs"
import { Writable } from "stream"
import * as path from "path"
import * as os from "os"

import { safeUpdateJson } from "../safeWriteJson"

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
	// Start with all actual implementations, then selectively wrap the
	// functions that tests need to mock with vi.fn(). This ensures that
	// other fs.promises functions used by the SUT (like proper-lockfile's
	// internals) keep their actual implementations.
	return {
		...actual,
		writeFile: vi.fn(actual.writeFile),
		readFile: vi.fn(actual.readFile),
		rename: vi.fn(actual.rename),
		unlink: vi.fn(actual.unlink),
		access: vi.fn(actual.access),
		mkdtemp: vi.fn(actual.mkdtemp),
		rm: vi.fn(actual.rm),
		readdir: vi.fn(actual.readdir),
		mkdir: vi.fn(actual.mkdir),
	}
})

// Mock the 'fs' module for fsSync.createWriteStream
vi.mock("fs", async () => {
	const actualFs = await vi.importActual<typeof import("fs")>("fs")
	return {
		...actualFs, // Spread actual implementations
		createWriteStream: vi.fn(actualFs.createWriteStream), // Default to actual, but mockable
	}
})

// The proper-lockfile mock is scoped to a single test via vi.doMock; the
// top-level unmock restores the real module for every other test.
vi.unmock("proper-lockfile")

import * as fs from "fs/promises" // This will now be the mocked version

describe("safeUpdateJson", () => {
	let tempDir: string
	let currentTestFilePath: string

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "safeUpdateJson-test-"))
		currentTestFilePath = path.join(tempDir, "test-file.json")
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	async function readFileContent(filePath: string): Promise<unknown> {
		const readContent = await fs.readFile(filePath, "utf-8")
		return JSON.parse(readContent)
	}

	async function fileExists(filePath: string): Promise<boolean> {
		try {
			await fs.access(filePath)
			return true
		} catch {
			return false
		}
	}

	// ────────────────────────────── Success scenarios ──────────────────────────────

	test("creates a new file when allowCreate is true and the file does not exist", async () => {
		const updated = await safeUpdateJson(
			currentTestFilePath,
			(current: { created?: boolean } | undefined) => ({ ...(current ?? {}), created: true }),
			{ allowCreate: true },
		)

		expect(updated).toEqual({ created: true })
		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual({ created: true })
	})

	test("throws when the file does not exist and allowCreate is false", async () => {
		await expect(
			safeUpdateJson(currentTestFilePath, (current: { nope?: boolean } | undefined) => ({ ...(current ?? {}), nope: true })),
		).rejects.toThrow("safeUpdateJson: file does not exist and allowCreate is false")

		// The file must not have been created.
		expect(await fileExists(currentTestFilePath)).toBe(false)
	})

	test("reads the current content and writes the updater result back", async () => {
		await fs.writeFile(currentTestFilePath, JSON.stringify({ counter: 1 }))

		const updated = await safeUpdateJson(
			currentTestFilePath,
			(current: { counter: number } | undefined) => ({
				...current,
				counter: (current?.counter ?? 0) + 1,
			}),
		)

		expect(updated).toEqual({ counter: 2 })
		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual({ counter: 2 })
	})

	test("supports prettyPrint output", async () => {
		await fs.writeFile(currentTestFilePath, JSON.stringify({ a: 1 }))

		await safeUpdateJson(
			currentTestFilePath,
			(current: { a?: number; b?: number } | undefined) => ({ ...current, b: 2 }),
			{ prettyPrint: true },
		)

		const raw = await fs.readFile(currentTestFilePath, "utf8")
		expect(raw).toContain("\n\t")
		expect(await readFileContent(currentTestFilePath)).toEqual({ a: 1, b: 2 })
	})

	test("creates parent directories when they do not exist", async () => {
		const deepPath = path.join(tempDir, "level1", "level2", "deep.json")

		await safeUpdateJson(
			deepPath,
			(current: { deep?: boolean } | undefined) => ({ ...(current ?? {}), deep: true }),
			{ allowCreate: true },
		)

		expect(await readFileContent(deepPath)).toEqual({ deep: true })
	})

	// ────────────────────────────── Updater behavior ──────────────────────────────

	test("leaves the file unchanged when the updater throws", async () => {
		await fs.writeFile(currentTestFilePath, JSON.stringify({ original: true }))

		await expect(
			safeUpdateJson(currentTestFilePath, () => {
				throw new Error("updater failed")
			}),
		).rejects.toThrow("updater failed")

		// The original content must survive.
		expect(await readFileContent(currentTestFilePath)).toEqual({ original: true })
	})

	test("propagates a JSON parse error without calling the updater", async () => {
		await fs.writeFile(currentTestFilePath, "not json", "utf8")

		const updater = vi.fn()
		await expect(safeUpdateJson(currentTestFilePath, updater)).rejects.toThrow()

		expect(updater).not.toHaveBeenCalled()
		// The malformed file is left untouched.
		expect(await fs.readFile(currentTestFilePath, "utf8")).toBe("not json")
	})

	// ────────────────────────────── Failure & rollback scenarios ──────────────────────────────

	test("leaves the original file unchanged when the final rename fails", async () => {
		const initialData = { message: "Initial content, should be restored" }
		await fs.writeFile(currentTestFilePath, JSON.stringify(initialData))

		// fs.rename is already vi.fn() — use vi.mocked to avoid double-wrapping via vi.spyOn
		vi.mocked(fs.rename).mockImplementationOnce(async () => {
			throw new Error("Rename from temp to final failed")
		})

		await expect(
			safeUpdateJson(
				currentTestFilePath,
				(current: { message?: string; changed?: boolean } | undefined) => ({ ...current, changed: true }),
			),
		).rejects.toThrow("Rename from temp to final failed")

		// The file was never moved, so its initial content is intact.
		expect(await readFileContent(currentTestFilePath)).toEqual(initialData)
	})

	test("releases the lock even when the write fails mid-operation", async () => {
		await fs.writeFile(currentTestFilePath, JSON.stringify({ initial: "content" }))

		// Construct a minimal fake WriteStream whose writes always fail. The
		// double assertion is required because `new Writable()` is not a
		// `WriteStream` (missing path/pending/bytesWritten), and there is no
		// typed alternative for a deliberately broken stream.
		const errorStream = new Writable() as unknown as WriteStream
		errorStream._write = (_chunk, _encoding, callback) => {
			callback(new Error("Stream write error"))
		}
		errorStream.close = vi.fn()
		errorStream.bytesWritten = 0
		errorStream.path = ""
		errorStream.pending = false

		vi.mocked(fsSyncActual.createWriteStream).mockImplementationOnce((_path, _options) => errorStream)

		await expect(
			safeUpdateJson(
				currentTestFilePath,
				(current: { initial?: string; changed?: boolean } | undefined) => ({ ...current, changed: true }),
			),
		).rejects.toThrow("Stream write error")

		// If the lock wasn't released, this second attempt would fail with a lock error.
		// Instead, it should succeed (proving the lock was released).
		await expect(
			safeUpdateJson(
				currentTestFilePath,
				(current: { initial?: string; second?: boolean } | undefined) => ({ ...current, second: true }),
			),
		).resolves.toEqual({ initial: "content", second: true })
	})

	test("throws when the lock cannot be acquired", async () => {
		vi.resetModules() // Clear module cache to ensure fresh imports for this test

		const lockTestFilePath = path.join(tempDir, "lock-test-file.json")
		await fs.writeFile(lockTestFilePath, JSON.stringify({ initial: "lock test content" }))

		vi.doMock("proper-lockfile", () => ({
			...vi.importActual("proper-lockfile"),
			lock: vi.fn().mockRejectedValueOnce(new Error("Failed to get lock.")),
		}))

		// Re-import safeUpdateJson to use the mocked proper-lockfile
		const { safeUpdateJson: mockedSafeUpdateJson } = await import("../safeWriteJson")

		await expect(
			mockedSafeUpdateJson(lockTestFilePath, (current: { changed?: boolean } | undefined) => ({ ...(current ?? {}), changed: true })),
		).rejects.toThrow("Failed to get lock.")

		// Clean up
		await fs.unlink(lockTestFilePath).catch(() => {})
	})
})
