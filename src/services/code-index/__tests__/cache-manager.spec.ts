import type { Mock } from "vitest"
import * as vscode from "vscode"
import { createHash } from "crypto"
import debounce from "lodash.debounce"
import { CacheManager, CacheReadError } from "../cache-manager"

import { clearAllMocks } from "../../../test-utils/reset"

// Mock safeWriteJson utility
vitest.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: vitest.fn().mockResolvedValue(undefined),
}))

vitest.mock("../../../i18n", () => ({ t: (key: string) => key }))

// Import the mocked version
import { safeWriteJson } from "../../../utils/safeWriteJson"

// Mock vscode
vitest.mock("vscode", () => ({
	Uri: {
		joinPath: vitest.fn(),
	},
	workspace: {
		fs: {
			readFile: vitest.fn(),
			writeFile: vitest.fn(),
			delete: vitest.fn(),
		},
	},
}))

// Mock debounce to execute immediately
vitest.mock("lodash.debounce", () => ({
	default: vitest.fn(function (fn) {
		return fn
	}),
}))

// Mock TelemetryService
vitest.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureEvent: vitest.fn(),
		},
	},
}))

describe("CacheManager", () => {
	let mockContext: vscode.ExtensionContext
	let mockWorkspacePath: string
	let mockCachePath: vscode.Uri
	let cacheManager: CacheManager

	beforeEach(() => {
		// Reset all mocks
		clearAllMocks()

		// Mock context
		mockWorkspacePath = "/mock/workspace"
		mockCachePath = { fsPath: "/mock/storage/cache.json" } as vscode.Uri
		mockContext = {
			globalStorageUri: { fsPath: "/mock/storage" } as vscode.Uri,
		} as vscode.ExtensionContext

		// Mock Uri.joinPath
		;(vscode.Uri.joinPath as Mock).mockReturnValue(mockCachePath)

		// Create cache manager instance
		cacheManager = new CacheManager(mockContext, mockWorkspacePath)
	})

	describe("constructor", () => {
		it("should correctly set up cachePath using Uri.joinPath and crypto.createHash", () => {
			const expectedHash = createHash("sha256").update(mockWorkspacePath).digest("hex")

			expect(vscode.Uri.joinPath).toHaveBeenCalledWith(
				mockContext.globalStorageUri,
				`roo-index-cache-${expectedHash}.json`,
			)
		})

		it("should set up debounced save function", () => {
			expect(debounce).toHaveBeenCalledWith(expect.any(Function), 1500)
		})
	})

	describe("initialize", () => {
		it("should load existing cache file successfully", async () => {
			const mockCache = { "file1.ts": "hash1", "file2.ts": "hash2" }
			const mockBuffer = Buffer.from(JSON.stringify(mockCache))
			;(vscode.workspace.fs.readFile as Mock).mockResolvedValue(mockBuffer)

			await cacheManager.initialize()

			expect(vscode.workspace.fs.readFile).toHaveBeenCalledWith(mockCachePath)
			expect(cacheManager.getAllHashes()).toEqual(mockCache)
		})

		it.each([
			["missing (ENOENT)", () => Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" }))],
			[
				"missing (FileNotFound)",
				() => Promise.reject(Object.assign(new Error("gone"), { code: "FileNotFound" })),
			],
			["invalid JSON", () => Promise.resolve(Buffer.from("{not json"))],
			["a non-object", () => Promise.resolve(Buffer.from("[1, 2]"))],
			["non-string hashes", () => Promise.resolve(Buffer.from('{"a.ts": 3}'))],
		])("CI-CM-01: treats a %s cache as empty", async (_label, read) => {
			;(vscode.workspace.fs.readFile as Mock).mockImplementation(read)
			await cacheManager.initialize()
			expect(cacheManager.getAllHashes()).toEqual({})
		})

		it("CI-CM-01: an unreadable cache throws CacheReadError and keeps nothing in memory changed", async () => {
			cacheManager.updateHash("kept.ts", "hash")
			const denied = Object.assign(new Error("denied"), { code: "EACCES" })
			;(vscode.workspace.fs.readFile as Mock).mockRejectedValue(denied)
			const error = await cacheManager.initialize().catch((caught: unknown) => caught)
			expect(error).toBeInstanceOf(CacheReadError)
			expect((error as CacheReadError).cause).toBe(denied)
			expect(cacheManager.getAllHashes()).toEqual({ "kept.ts": "hash" })
			expect(safeWriteJson).not.toHaveBeenCalledWith(expect.anything(), {})
		})
	})

	describe("hash management", () => {
		it("should update hash and trigger save", () => {
			const filePath = "test.ts"
			const hash = "testhash"

			cacheManager.updateHash(filePath, hash)

			expect(cacheManager.getHash(filePath)).toBe(hash)
			expect(safeWriteJson).toHaveBeenCalled()
		})

		it("should delete hash and trigger save", () => {
			const filePath = "test.ts"
			const hash = "testhash"

			cacheManager.updateHash(filePath, hash)
			cacheManager.deleteHash(filePath)

			expect(cacheManager.getHash(filePath)).toBeUndefined()
			expect(safeWriteJson).toHaveBeenCalled()
		})

		it("should return shallow copy of hashes", () => {
			const filePath = "test.ts"
			const hash = "testhash"

			cacheManager.updateHash(filePath, hash)
			const hashes = cacheManager.getAllHashes()

			// Modify the returned object
			hashes[filePath] = "modified"

			// Original should remain unchanged
			expect(cacheManager.getHash(filePath)).toBe(hash)
		})
	})

	describe("saving", () => {
		it("should save cache to disk with correct data", async () => {
			const filePath = "test.ts"
			const hash = "testhash"

			cacheManager.updateHash(filePath, hash)

			expect(safeWriteJson).toHaveBeenCalledWith(mockCachePath.fsPath, expect.any(Object))

			// Verify the saved data
			const savedData = (safeWriteJson as Mock).mock.calls[0][1]
			expect(savedData).toEqual({ [filePath]: hash })
		})

		it("should handle save errors gracefully", async () => {
			const consoleErrorSpy = vitest.spyOn(console, "error").mockImplementation(function () {})
			;(safeWriteJson as Mock).mockRejectedValue(new Error("Save failed"))

			cacheManager.updateHash("test.ts", "hash")

			// Wait for any pending promises
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(consoleErrorSpy).toHaveBeenCalledWith("Failed to save cache:", expect.any(Error))

			consoleErrorSpy.mockRestore()
		})
	})

	describe("clearCacheFile", () => {
		it("should clear cache file and reset state", async () => {
			cacheManager.updateHash("test.ts", "hash")

			// Reset the mock to ensure safeWriteJson succeeds for clearCacheFile
			;(safeWriteJson as Mock).mockClear()
			;(safeWriteJson as Mock).mockResolvedValue(undefined)

			await cacheManager.clearCacheFile()

			expect(safeWriteJson).toHaveBeenCalledWith(mockCachePath.fsPath, {})
			expect(cacheManager.getAllHashes()).toEqual({})
		})

		it("should handle clear errors gracefully", async () => {
			const consoleErrorSpy = vitest.spyOn(console, "error").mockImplementation(function () {})
			;(safeWriteJson as Mock).mockRejectedValue(new Error("Save failed"))

			await cacheManager.clearCacheFile()

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"Failed to clear cache file:",
				expect.any(Error),
				mockCachePath,
			)

			consoleErrorSpy.mockRestore()
		})
	})
})
