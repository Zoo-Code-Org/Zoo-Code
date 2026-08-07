import { EventEmitter } from "events"
import type { PathLike } from "fs"
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest"

import { safeWriteJson, safeUpdateJson } from "../safeWriteJson"

// In-memory file state so mocked fs operations behave consistently across the
// read-modify-write flow without touching the real filesystem.
const mockFiles = new Map<string, string>()
const mockDirs = new Set<string>("/mock")

interface MockStream extends EventEmitter {
	path: string
	bytesWritten: number
	pending: boolean
	write: (chunk: string | Buffer) => boolean
	end: () => void
	close: () => void
	destroy: () => void
}

function makeEnoentError(path: string) {
	const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException
	error.code = "ENOENT"
	return error
}

function ensureDir(path: string) {
	const parts = path.split("/").filter(Boolean)
	let current = ""
	for (const part of parts) {
		current += `/${part}`
		mockDirs.add(current)
	}
}

function createMockWriteStream(path: string): MockStream {
	const chunks: (string | Buffer)[] = []
	const stream = new EventEmitter() as MockStream
	stream.path = path
	stream.bytesWritten = 0
	stream.pending = false
	stream.write = vi.fn((chunk: string | Buffer) => {
		chunks.push(chunk)
		return true
	})
	stream.end = vi.fn(() => {
		const content =
			chunks.length > 0 && Buffer.isBuffer(chunks[0])
				? Buffer.concat(chunks as Buffer[]).toString("utf8")
				: chunks.join("")
		mockFiles.set(path, content)
		process.nextTick(() => stream.emit("finish"))
	})
	stream.close = vi.fn()
	stream.destroy = vi.fn()
	return stream
}

interface StringifyStream extends EventEmitter {
	pipe: (destination: MockStream) => MockStream
}

// Mock the streaming JSON dependency so tests can control success/failure.
vi.mock("json-stream-stringify", () => ({
	JsonStreamStringify: vi.fn(function (data: unknown) {
		const stream = new EventEmitter() as StringifyStream
		const content = JSON.stringify(data === undefined ? null : data)
		stream.pipe = vi.fn((destination: MockStream) => {
			destination.write(content)
			destination.end()
			return destination
		})
		return stream
	}),
}))

const releaseLock = vi.fn()

vi.mock("proper-lockfile", () => ({
	lock: vi.fn(async () => releaseLock),
}))

vi.mock("path", async () => {
	const actual = await vi.importActual<typeof import("path")>("path")
	return {
		...actual,
		resolve: vi.fn((...args: string[]) => actual.posix.resolve(...args)),
		dirname: vi.fn((p: string) => actual.posix.dirname(p)),
		basename: vi.fn((p: string) => actual.posix.basename(p)),
		join: vi.fn((...args: string[]) => actual.posix.join(...args)),
	}
})

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	return {
		...actual,
		createWriteStream: vi.fn((path: string) => createMockWriteStream(path)),
	}
})

vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	return {
		...actual,
		mkdir: vi.fn(async (dirPath: string, options?: { recursive?: boolean }) => {
			if (options?.recursive) {
				ensureDir(dirPath)
			} else {
				mockDirs.add(dirPath)
			}
		}),
		access: vi.fn(async (targetPath: string) => {
			if (!mockDirs.has(targetPath) && !mockFiles.has(targetPath)) {
				throw makeEnoentError(targetPath)
			}
		}),
		readFile: vi.fn(async (targetPath: string) => {
			if (!mockFiles.has(targetPath)) {
				throw makeEnoentError(targetPath)
			}
			return mockFiles.get(targetPath)!
		}),
		rename: vi.fn(async (oldPath: PathLike, newPath: PathLike) => {
			const oldKey = String(oldPath)
			const newKey = String(newPath)
			if (!mockFiles.has(oldKey) && !mockDirs.has(oldKey)) {
				throw makeEnoentError(oldKey)
			}
			if (mockFiles.has(oldKey)) {
				mockFiles.set(newKey, mockFiles.get(oldKey)!)
				mockFiles.delete(oldKey)
			}
		}),
		unlink: vi.fn(async (targetPath: PathLike) => {
			mockFiles.delete(String(targetPath))
		}),
	}
})

import * as fs from "fs/promises"

describe("safeUpdateJson", () => {
	const filePath = "/mock/stats.json"

	beforeEach(() => {
		mockFiles.clear()
		mockDirs.clear()
		mockDirs.add("/mock")
		vi.clearAllMocks()
		vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	test("read fails before temp write with a non-ENOENT error", async () => {
		const readError = new Error("EACCES: permission denied") as NodeJS.ErrnoException
		readError.code = "EACCES"
		vi.mocked(fs.readFile).mockRejectedValueOnce(readError)

		const updater = vi.fn(() => ({ updated: true }))

		await expect(safeUpdateJson(filePath, updater)).rejects.toThrow("EACCES: permission denied")

		expect(updater).not.toHaveBeenCalled()
		expect(fs.rename).not.toHaveBeenCalled()
	})

	test("temp write succeeds but rename fails, and temp file is removed", async () => {
		mockFiles.set(filePath, JSON.stringify({ count: 1 }))

		let renameCall = 0
		vi.mocked(fs.rename).mockImplementation(async (oldPath: PathLike, newPath: PathLike) => {
			const oldKey = String(oldPath)
			const newKey = String(newPath)
			renameCall++
			if (renameCall === 2) {
				// The temp -> target commit step fails.
				throw new Error("Rename temp to target failed")
			}
			// Otherwise delegate to the default in-memory rename.
			if (mockFiles.has(oldKey)) {
				mockFiles.set(newKey, mockFiles.get(oldKey)!)
				mockFiles.delete(oldKey)
			}
		})

		const updater = vi.fn((current) => ({ ...current, count: (current?.count ?? 0) + 1 }))

		await expect(safeUpdateJson(filePath, updater)).rejects.toThrow("Rename temp to target failed")

		// Rollback should have restored the original file from backup.
		expect(mockFiles.get(filePath)).toBe(JSON.stringify({ count: 1 }))

		// The temporary .new file should have been cleaned up.
		const unlinkedTemp = vi.mocked(fs.unlink).mock.calls.find((call) => String(call[0]).includes(".new_"))
		expect(unlinkedTemp).toBeTruthy()
	})

	test("backup rename fails during rollback, graceful handling", async () => {
		mockFiles.set(filePath, JSON.stringify({ count: 1 }))

		let renameCall = 0
		vi.mocked(fs.rename).mockImplementation(async (oldPath: PathLike, newPath: PathLike) => {
			const oldKey = String(oldPath)
			const newKey = String(newPath)
			renameCall++
			if (renameCall === 2) {
				throw new Error("Primary rename failed")
			}
			if (renameCall === 3) {
				// Rollback backup -> target also fails.
				throw new Error("Rollback rename failed")
			}
			if (mockFiles.has(oldKey)) {
				mockFiles.set(newKey, mockFiles.get(oldKey)!)
				mockFiles.delete(oldKey)
			}
		})

		const updater = vi.fn((current) => ({ ...current, count: (current?.count ?? 0) + 1 }))

		await expect(safeUpdateJson(filePath, updater)).rejects.toThrow("Primary rename failed")

		// The original error should be re-thrown, not the rollback error.
		expect(updater).toHaveBeenCalled()

		// The temp .new file should still be cleaned up.
		const unlinkedTemp = vi.mocked(fs.unlink).mock.calls.find((call) => String(call[0]).includes(".new_"))
		expect(unlinkedTemp).toBeTruthy()

		// The orphaned backup should be unlinked when rollback fails.
		const unlinkedBackup = vi.mocked(fs.unlink).mock.calls.find((call) => String(call[0]).includes(".bak_"))
		expect(unlinkedBackup).toBeTruthy()

		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("Failed to restore backup"),
			expect.any(Error),
		)
	})

	test("throws when the target file does not exist and allowCreate is false", async () => {
		const updater = vi.fn(() => ({ count: 2 }))

		await expect(safeUpdateJson(filePath, updater)).rejects.toThrow(
			"safeUpdateJson: file does not exist and allowCreate is false",
		)

		expect(updater).not.toHaveBeenCalled()
	})

	test("returns the updater result on success", async () => {
		mockFiles.set(filePath, JSON.stringify({ count: 1 }))

		const result = await safeUpdateJson<{ count: number }>(filePath, (current) => ({
			count: (current?.count ?? 0) + 1,
		}))

		expect(result).toEqual({ count: 2 })
		expect(mockFiles.get(filePath)).toBe(JSON.stringify({ count: 2 }))
	})

	test("creates the file when allowCreate is true and it does not exist", async () => {
		const result = await safeUpdateJson<{ count: number }>(
			filePath,
			(current) => ({ count: (current?.count ?? 0) + 1 }),
			{ allowCreate: true },
		)

		expect(result).toEqual({ count: 1 })
		expect(mockFiles.get(filePath)).toBe(JSON.stringify({ count: 1 }))
	})

	test("logs an error but succeeds when backup cleanup fails", async () => {
		mockFiles.set(filePath, JSON.stringify({ count: 1 }))

		vi.mocked(fs.unlink).mockImplementation(async (targetPath: PathLike) => {
			const key = String(targetPath)
			if (key.includes(".bak_")) {
				throw new Error("Backup cleanup failed")
			}
			mockFiles.delete(key)
		})

		const result = await safeUpdateJson<{ count: number }>(filePath, (current) => ({
			count: (current?.count ?? 0) + 1,
		}))

		expect(result).toEqual({ count: 2 })
		expect(mockFiles.get(filePath)).toBe(JSON.stringify({ count: 2 }))
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Successfully wrote"), expect.any(Error))
	})
})

describe("safeWriteJson", () => {
	const filePath = "/mock/new.json"

	beforeEach(() => {
		mockFiles.clear()
		mockDirs.clear()
		mockDirs.add("/mock")
		vi.clearAllMocks()
		vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	test("success path writes data to a non-existent file", async () => {
		const data = { hello: "world" }

		await safeWriteJson(filePath, data)

		expect(mockFiles.get(filePath)).toBe(JSON.stringify(data))
	})
})
