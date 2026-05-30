import { describe, it, expect, vi, beforeEach } from "vitest"
import * as fs from "fs/promises"
import * as path from "path"
import { EventEmitter } from "events"

// Mock fs/promises
vi.mock("fs/promises", () => ({
	mkdir: vi.fn().mockResolvedValue(undefined),
	access: vi.fn(),
	chmod: vi.fn().mockResolvedValue(undefined),
	unlink: vi.fn().mockResolvedValue(undefined),
	rm: vi.fn().mockResolvedValue(undefined),
}))

// Mock fs (createWriteStream)
const mockWriteStream = {
	on: vi.fn(),
	close: vi.fn(),
}
vi.mock("fs", () => ({
	createWriteStream: vi.fn(() => mockWriteStream),
}))

// Mock https
const mockRequest = new EventEmitter() as any
mockRequest.setTimeout = vi.fn()

const mockResponse = new EventEmitter() as any
mockResponse.statusCode = 200
mockResponse.headers = {}
mockResponse.pipe = vi.fn()
mockResponse.destroy = vi.fn()

vi.mock("https", () => ({
	get: vi.fn((_url: string, callback: (res: any) => void) => {
		setImmediate(() => callback(mockResponse))
		return mockRequest
	}),
}))

// Mock child_process spawn for tar/unzip extraction
const mockExtractProcess = new EventEmitter() as any
mockExtractProcess.stderr = new EventEmitter()

vi.mock("child_process", () => ({
	spawn: vi.fn(() => {
		// Simulate successful extraction
		setImmediate(() => mockExtractProcess.emit("close", 0))
		return mockExtractProcess
	}),
}))

import {
	isSembleSupportedPlatform,
	getSembleSupportedPlatforms,
	downloadSemble,
	getSembleBinaryPath,
} from "../semble-downloader"
import * as https from "https"
import { spawn } from "child_process"

describe("semble-downloader", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		// Reset response defaults
		mockResponse.statusCode = 200
		mockResponse.headers = {}
		mockResponse.pipe = vi.fn()
		mockResponse.destroy = vi.fn()
		mockWriteStream.on = vi.fn()
		mockWriteStream.close = vi.fn()
	})

	describe("isSembleSupportedPlatform", () => {
		it("should return true for linux-x64", () => {
			expect(isSembleSupportedPlatform("linux", "x64")).toBe(true)
		})

		it("should return true for linux-arm64", () => {
			expect(isSembleSupportedPlatform("linux", "arm64")).toBe(true)
		})

		it("should return true for darwin-arm64", () => {
			expect(isSembleSupportedPlatform("darwin", "arm64")).toBe(true)
		})

		it("should return true for win32-x64", () => {
			expect(isSembleSupportedPlatform("win32", "x64")).toBe(true)
		})

		it("should return false for darwin-x64 (Intel Mac not supported)", () => {
			expect(isSembleSupportedPlatform("darwin", "x64")).toBe(false)
		})

		it("should return false for win32-arm64", () => {
			expect(isSembleSupportedPlatform("win32", "arm64")).toBe(false)
		})

		it("should return false for freebsd-x64", () => {
			expect(isSembleSupportedPlatform("freebsd", "x64")).toBe(false)
		})

		it("should use process.platform and process.arch when no args provided", () => {
			const result = isSembleSupportedPlatform()
			expect(typeof result).toBe("boolean")
		})
	})

	describe("getSembleSupportedPlatforms", () => {
		it("should return all supported platform-arch combinations", () => {
			const platforms = getSembleSupportedPlatforms()

			expect(platforms).toContain("linux-x64")
			expect(platforms).toContain("linux-arm64")
			expect(platforms).toContain("darwin-arm64")
			expect(platforms).toContain("win32-x64")
			expect(platforms).toHaveLength(4)
		})
	})

	describe("downloadSemble", () => {
		it("should return undefined on unsupported platform", async () => {
			const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
			const originalArch = Object.getOwnPropertyDescriptor(process, "arch")

			Object.defineProperty(process, "platform", { value: "freebsd", configurable: true })
			Object.defineProperty(process, "arch", { value: "x64", configurable: true })

			try {
				const result = await downloadSemble("/some/dir")
				expect(result).toBeUndefined()
			} finally {
				if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform)
				if (originalArch) Object.defineProperty(process, "arch", originalArch)
			}
		})

		it("should return existing binary path if already extracted", async () => {
			const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
			const originalArch = Object.getOwnPropertyDescriptor(process, "arch")

			Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
			Object.defineProperty(process, "arch", { value: "arm64", configurable: true })

			// fs.access resolves => file exists
			;(fs.access as any).mockResolvedValue(undefined)

			try {
				const result = await downloadSemble("/storage")

				expect(result).toBe(path.join("/storage", "semble", "semble"))
				expect(fs.mkdir).toHaveBeenCalledWith("/storage", { recursive: true })
				expect(fs.chmod).toHaveBeenCalledWith(path.join("/storage", "semble", "semble"), 0o755)
				// Should NOT attempt to download
				expect(https.get).not.toHaveBeenCalled()
			} finally {
				if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform)
				if (originalArch) Object.defineProperty(process, "arch", originalArch)
			}
		})

		it("should download and extract archive when not present", async () => {
			const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
			const originalArch = Object.getOwnPropertyDescriptor(process, "arch")

			Object.defineProperty(process, "platform", { value: "linux", configurable: true })
			Object.defineProperty(process, "arch", { value: "x64", configurable: true })

			// fs.access rejects => file not present
			;(fs.access as any).mockRejectedValue(new Error("ENOENT"))

			// Simulate successful download: pipe is called, then "finish" fires
			mockWriteStream.on.mockImplementation((event: string, cb: () => void) => {
				if (event === "finish") {
					setImmediate(cb)
				}
			})

			try {
				const result = await downloadSemble("/storage")

				expect(result).toBe(path.join("/storage", "semble", "semble"))
				expect(https.get).toHaveBeenCalledWith(
					expect.stringContaining("semble-linux-x64-fast.tar.gz"),
					expect.any(Function),
				)
				// Should call tar for extraction
				expect(spawn).toHaveBeenCalledWith(
					"tar",
					[
						"-xzf",
						path.join("/storage", "semble-linux-x64-fast.tar.gz"),
						"-C",
						path.join("/storage", "semble"),
					],
					expect.any(Object),
				)
				expect(fs.chmod).toHaveBeenCalledWith(path.join("/storage", "semble", "semble"), 0o755)
				// Archive should be cleaned up
				expect(fs.unlink).toHaveBeenCalledWith(path.join("/storage", "semble-linux-x64-fast.tar.gz"))
			} finally {
				if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform)
				if (originalArch) Object.defineProperty(process, "arch", originalArch)
			}
		})

		it("should not chmod on windows", async () => {
			const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
			const originalArch = Object.getOwnPropertyDescriptor(process, "arch")

			Object.defineProperty(process, "platform", { value: "win32", configurable: true })
			Object.defineProperty(process, "arch", { value: "x64", configurable: true })

			// fs.access resolves => file exists
			;(fs.access as any).mockResolvedValue(undefined)

			try {
				const result = await downloadSemble("/storage")

				expect(result).toBe(path.join("/storage", "semble", "semble.exe"))
				expect(fs.chmod).not.toHaveBeenCalled()
			} finally {
				if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform)
				if (originalArch) Object.defineProperty(process, "arch", originalArch)
			}
		})

		it("should throw and clean up on download failure", async () => {
			const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
			const originalArch = Object.getOwnPropertyDescriptor(process, "arch")

			Object.defineProperty(process, "platform", { value: "linux", configurable: true })
			Object.defineProperty(process, "arch", { value: "arm64", configurable: true })

			// fs.access rejects => file not present
			;(fs.access as any).mockRejectedValue(new Error("ENOENT"))

			// Simulate HTTP error response
			mockResponse.statusCode = 404

			try {
				await expect(downloadSemble("/storage")).rejects.toThrow("Failed to download semble")
				expect(fs.unlink).toHaveBeenCalledWith(path.join("/storage", "semble-linux-arm64-fast.tar.gz"))
				expect(fs.rm).toHaveBeenCalledWith(path.join("/storage", "semble"), { recursive: true, force: true })
			} finally {
				if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform)
				if (originalArch) Object.defineProperty(process, "arch", originalArch)
			}
		})

		it("should follow redirects", async () => {
			const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
			const originalArch = Object.getOwnPropertyDescriptor(process, "arch")

			Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
			Object.defineProperty(process, "arch", { value: "arm64", configurable: true })

			// fs.access rejects => file not present
			;(fs.access as any).mockRejectedValue(new Error("ENOENT"))

			// First call returns a redirect, second call returns 200
			let callCount = 0
			;(https.get as any).mockImplementation((_url: string, callback: (res: any) => void) => {
				callCount++
				const res = new EventEmitter() as any
				if (callCount === 1) {
					res.statusCode = 302
					res.headers = { location: "https://cdn.example.com/semble-macos-arm64-fast.tar.gz" }
					res.destroy = vi.fn()
				} else {
					res.statusCode = 200
					res.headers = {}
					res.pipe = vi.fn()
					res.destroy = vi.fn()
				}
				setImmediate(() => callback(res))

				const req = new EventEmitter() as any
				req.setTimeout = vi.fn()
				return req
			})

			// Simulate successful download on the second response
			mockWriteStream.on.mockImplementation((event: string, cb: () => void) => {
				if (event === "finish") {
					setImmediate(cb)
				}
			})

			try {
				const result = await downloadSemble("/storage")

				expect(result).toBe(path.join("/storage", "semble", "semble"))
				expect(https.get).toHaveBeenCalledTimes(2)
			} finally {
				if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform)
				if (originalArch) Object.defineProperty(process, "arch", originalArch)
			}
		})
	})

	describe("getSembleBinaryPath", () => {
		it("should return path when binary exists", async () => {
			const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
			const originalArch = Object.getOwnPropertyDescriptor(process, "arch")

			Object.defineProperty(process, "platform", { value: "linux", configurable: true })
			Object.defineProperty(process, "arch", { value: "x64", configurable: true })
			;(fs.access as any).mockResolvedValue(undefined)

			try {
				const result = await getSembleBinaryPath("/storage")
				expect(result).toBe(path.join("/storage", "semble", "semble"))
			} finally {
				if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform)
				if (originalArch) Object.defineProperty(process, "arch", originalArch)
			}
		})

		it("should return undefined when binary does not exist", async () => {
			const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
			const originalArch = Object.getOwnPropertyDescriptor(process, "arch")

			Object.defineProperty(process, "platform", { value: "linux", configurable: true })
			Object.defineProperty(process, "arch", { value: "x64", configurable: true })
			;(fs.access as any).mockRejectedValue(new Error("ENOENT"))

			try {
				const result = await getSembleBinaryPath("/storage")
				expect(result).toBeUndefined()
			} finally {
				if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform)
				if (originalArch) Object.defineProperty(process, "arch", originalArch)
			}
		})

		it("should return undefined on unsupported platform", async () => {
			const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
			const originalArch = Object.getOwnPropertyDescriptor(process, "arch")

			Object.defineProperty(process, "platform", { value: "freebsd", configurable: true })
			Object.defineProperty(process, "arch", { value: "x64", configurable: true })

			try {
				const result = await getSembleBinaryPath("/storage")
				expect(result).toBeUndefined()
			} finally {
				if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform)
				if (originalArch) Object.defineProperty(process, "arch", originalArch)
			}
		})
	})
})
