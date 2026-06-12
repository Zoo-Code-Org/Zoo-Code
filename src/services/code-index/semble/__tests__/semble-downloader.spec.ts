import { describe, it, expect, vi, beforeEach } from "vitest"
import * as fs from "fs/promises"
import * as path from "path"
import { EventEmitter } from "events"

// Mock crypto — verifyChecksum reads the archive file (mocked via createReadStream)
// and computes a SHA-256. We make digest() dynamically return the expected checksum
// for the current process.platform/arch so verification always passes in unit tests.
const CHECKSUMS: Record<string, string> = {
	"linux-x64": "2bd4117dbd1ff7a26ed5ef44dad8d43162a4b9f431ec0bcc9dd2f9c6f5952e28",
	"linux-arm64": "177d14f41d3272594844a2635d59d97ad20400868a874a59169fd26a868c32a5",
	"darwin-arm64": "9130f447ff2c21803853a9aee58268f0e05134326384ac23d8b74ed22905e118",
	"win32-x64": "c8ae86f3703675e356824e08cf79c8a20c41c602296d2a5bff15bf35d762a46b",
}
vi.mock("crypto", () => ({
	createHash: vi.fn(() => ({
		update: vi.fn().mockReturnThis(),
		digest: vi.fn(() => CHECKSUMS[`${process.platform}-${process.arch}`] ?? "no-match"),
	})),
}))

// Mock fs/promises
vi.mock("fs/promises", () => ({
	mkdir: vi.fn().mockResolvedValue(undefined),
	access: vi.fn(),
	chmod: vi.fn().mockResolvedValue(undefined),
	unlink: vi.fn().mockResolvedValue(undefined),
	rm: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn(),
	writeFile: vi.fn().mockResolvedValue(undefined),
	rename: vi.fn().mockResolvedValue(undefined),
}))

// Mock fs (createWriteStream and createReadStream for checksum verification)
const mockWriteStream = {
	on: vi.fn(),
	close: vi.fn(),
}
vi.mock("fs", () => ({
	createWriteStream: vi.fn(() => mockWriteStream),
	createReadStream: vi.fn(() => {
		const { EventEmitter } = require("events")
		const stream = new EventEmitter()
		setImmediate(() => {
			stream.emit("data", Buffer.from("fake-archive-content"))
			stream.emit("end")
		})
		return stream
	}),
}))

// Mock https — fresh emitters per invocation to avoid listener leaks across tests
let mockRequest: any
let mockResponse: any

vi.mock("https", () => ({
	get: vi.fn((_url: string, callback: (res: any) => void) => {
		mockRequest = Object.assign(new EventEmitter(), { setTimeout: vi.fn() })
		mockResponse = Object.assign(new EventEmitter(), {
			statusCode: 200,
			headers: {},
			pipe: vi.fn(),
			destroy: vi.fn(),
		})
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
		mockWriteStream.on = vi.fn()
		mockWriteStream.close = vi.fn()

		// Restore the default https.get mock so tests that override it don't leak
		;(https.get as any).mockImplementation((_url: string, callback: (res: any) => void) => {
			mockRequest = Object.assign(new EventEmitter(), { setTimeout: vi.fn() })
			mockResponse = Object.assign(new EventEmitter(), {
				statusCode: 200,
				headers: {},
				pipe: vi.fn(),
				destroy: vi.fn(),
			})
			setImmediate(() => callback(mockResponse))
			return mockRequest
		})
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
			// Version file matches current version
			;(fs.readFile as any).mockResolvedValue("v0.3.1")

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

			// fs.access resolves — only called for staged binary verification
			// (version is undefined so the binaryPath check is skipped)
			;(fs.access as any).mockResolvedValue(undefined)
			// No version file exists
			;(fs.readFile as any).mockRejectedValue(new Error("ENOENT"))

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
				// Should call tar for extraction into staging directory
				expect(spawn).toHaveBeenCalledWith(
					"tar",
					[
						"-xzf",
						path.join("/storage", "semble-linux-x64-fast.tar.gz"),
						"-C",
						path.join("/storage", "semble.new"),
						"--no-same-owner",
						"--no-overwrite-dir",
					],
					expect.any(Object),
				)
				expect(fs.chmod).toHaveBeenCalledWith(path.join("/storage", "semble.new", "semble"), 0o755)
				// Should rename staging to final
				expect(fs.rename).toHaveBeenCalledWith(
					path.join("/storage", "semble.new"),
					path.join("/storage", "semble"),
				)
				// Version file should be written
				expect(fs.writeFile).toHaveBeenCalledWith(
					path.join("/storage", "semble", ".semble-version"),
					"v0.3.1",
					"utf-8",
				)
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
			// Version file matches
			;(fs.readFile as any).mockResolvedValue("v0.3.1")

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
			// No version file
			;(fs.readFile as any).mockRejectedValue(new Error("ENOENT"))

			// Simulate HTTP error response
			;(https.get as any).mockImplementation((_url: string, callback: (res: any) => void) => {
				const res = Object.assign(new EventEmitter(), {
					statusCode: 404,
					headers: {},
					pipe: vi.fn(),
					destroy: vi.fn(),
				})
				setImmediate(() => callback(res))
				const req = Object.assign(new EventEmitter(), { setTimeout: vi.fn() })
				return req
			})

			try {
				await expect(downloadSemble("/storage")).rejects.toThrow("Failed to download semble")
				expect(fs.unlink).toHaveBeenCalledWith(path.join("/storage", "semble-linux-arm64-fast.tar.gz"))
				// Should clean up staging directory, not the original
				expect(fs.rm).toHaveBeenCalledWith(path.join("/storage", "semble.new"), {
					recursive: true,
					force: true,
				})
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

			// fs.access resolves — only called for staged binary verification
			;(fs.access as any).mockResolvedValue(undefined)
			// No version file
			;(fs.readFile as any).mockRejectedValue(new Error("ENOENT"))

			// First call returns a redirect, second call returns 200
			let callCount = 0
			;(https.get as any).mockImplementation((_url: string, callback: (res: any) => void) => {
				callCount++
				const res = new EventEmitter() as any
				if (callCount === 1) {
					res.statusCode = 302
					res.headers = {
						location: "https://objects.githubusercontent.com/semble-macos-arm64-fast.tar.gz",
					}
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

		it("should block redirects to untrusted domains", async () => {
			const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
			const originalArch = Object.getOwnPropertyDescriptor(process, "arch")

			Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
			Object.defineProperty(process, "arch", { value: "arm64", configurable: true })

			// fs.access rejects => file not present
			;(fs.access as any).mockRejectedValue(new Error("ENOENT"))
			// No version file
			;(fs.readFile as any).mockRejectedValue(new Error("ENOENT"))

			// Redirect to an untrusted domain
			;(https.get as any).mockImplementation((_url: string, callback: (res: any) => void) => {
				const res = new EventEmitter() as any
				res.statusCode = 302
				res.headers = { location: "https://evil.example.com/malicious-binary.tar.gz" }
				res.destroy = vi.fn()
				setImmediate(() => callback(res))

				const req = new EventEmitter() as any
				req.setTimeout = vi.fn()
				return req
			})

			try {
				await expect(downloadSemble("/storage")).rejects.toThrow("untrusted domain")
			} finally {
				if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform)
				if (originalArch) Object.defineProperty(process, "arch", originalArch)
			}
		})

		it("should block redirects to domains that suffix-match trusted domains (e.g. evilgithub.com)", async () => {
			const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
			const originalArch = Object.getOwnPropertyDescriptor(process, "arch")

			Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
			Object.defineProperty(process, "arch", { value: "arm64", configurable: true })

			// fs.access rejects => file not present
			;(fs.access as any).mockRejectedValue(new Error("ENOENT"))
			// No version file
			;(fs.readFile as any).mockRejectedValue(new Error("ENOENT"))

			// Redirect to a domain that suffix-matches "github.com" without a dot boundary
			;(https.get as any).mockImplementation((_url: string, callback: (res: any) => void) => {
				const res = new EventEmitter() as any
				res.statusCode = 302
				res.headers = { location: "https://evilgithub.com/malicious-binary.tar.gz" }
				res.destroy = vi.fn()
				setImmediate(() => callback(res))

				const req = new EventEmitter() as any
				req.setTimeout = vi.fn()
				return req
			})

			try {
				await expect(downloadSemble("/storage")).rejects.toThrow("untrusted domain")
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

		it("should use correct binary name for windows", async () => {
			const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
			const originalArch = Object.getOwnPropertyDescriptor(process, "arch")

			Object.defineProperty(process, "platform", { value: "win32", configurable: true })
			Object.defineProperty(process, "arch", { value: "x64", configurable: true })
			;(fs.access as any).mockResolvedValue(undefined)

			try {
				const result = await getSembleBinaryPath("/storage")
				expect(result).toBe(path.join("/storage", "semble", "semble.exe"))
			} finally {
				if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform)
				if (originalArch) Object.defineProperty(process, "arch", originalArch)
			}
		})
	})

	describe("downloadSemble - zip extraction on Windows", () => {
		it("should use PowerShell Expand-Archive on Windows", async () => {
			const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
			const originalArch = Object.getOwnPropertyDescriptor(process, "arch")

			Object.defineProperty(process, "platform", { value: "win32", configurable: true })
			Object.defineProperty(process, "arch", { value: "x64", configurable: true })

			// fs.access resolves — only called for staged binary verification
			// (version is undefined so the binaryPath check is skipped)
			;(fs.access as any).mockResolvedValue(undefined)
			// No version file
			;(fs.readFile as any).mockRejectedValue(new Error("ENOENT"))

			// Simulate successful download
			mockWriteStream.on.mockImplementation((event: string, cb: () => void) => {
				if (event === "finish") {
					setImmediate(cb)
				}
			})

			try {
				const result = await downloadSemble("/storage")

				expect(result).toBe(path.join("/storage", "semble", "semble.exe"))
				// Should call PowerShell for zip extraction
				expect(spawn).toHaveBeenCalledWith(
					"powershell",
					expect.arrayContaining(["-NoProfile", "-Command", expect.stringContaining("Expand-Archive")]),
					expect.any(Object),
				)
				// Should NOT call chmod on windows
				expect(fs.chmod).not.toHaveBeenCalled()
			} finally {
				if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform)
				if (originalArch) Object.defineProperty(process, "arch", originalArch)
			}
		})
	})

	describe("downloadSemble - error handling edge cases", () => {
		it("should not throw when archive cleanup fails after successful extraction", async () => {
			const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
			const originalArch = Object.getOwnPropertyDescriptor(process, "arch")

			Object.defineProperty(process, "platform", { value: "linux", configurable: true })
			Object.defineProperty(process, "arch", { value: "x64", configurable: true })

			// fs.access resolves — only called for staged binary verification
			// (version is undefined so the binaryPath check is skipped)
			;(fs.access as any).mockResolvedValue(undefined)
			// No version file
			;(fs.readFile as any).mockRejectedValue(new Error("ENOENT"))

			// Simulate successful download
			mockWriteStream.on.mockImplementation((event: string, cb: () => void) => {
				if (event === "finish") {
					setImmediate(cb)
				}
			})

			// Archive cleanup fails but should not throw (only archive removal after extraction)
			;(fs.unlink as any).mockRejectedValue(new Error("unlink cleanup failed"))

			try {
				const result = await downloadSemble("/storage")
				// Should still succeed — archive cleanup failure is ignored
				expect(result).toBe(path.join("/storage", "semble", "semble"))
			} finally {
				if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform)
				if (originalArch) Object.defineProperty(process, "arch", originalArch)
			}
		})
	})

	describe("downloadSemble - version tracking", () => {
		it("should re-download when installed version differs from SEMBLE_VERSION", async () => {
			const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
			const originalArch = Object.getOwnPropertyDescriptor(process, "arch")

			Object.defineProperty(process, "platform", { value: "linux", configurable: true })
			Object.defineProperty(process, "arch", { value: "x64", configurable: true })

			// Version file has an old version
			;(fs.readFile as any).mockResolvedValue("v0.2.0")
			// fs.access resolves — only called for staged binary verification
			// (version mismatch means binaryPath check is skipped)
			;(fs.access as any).mockResolvedValue(undefined)

			// Simulate successful download
			mockWriteStream.on.mockImplementation((event: string, cb: () => void) => {
				if (event === "finish") {
					setImmediate(cb)
				}
			})

			try {
				const result = await downloadSemble("/storage")

				expect(result).toBe(path.join("/storage", "semble", "semble"))
				// Should remove old installation during atomic swap
				expect(fs.rm).toHaveBeenCalledWith(path.join("/storage", "semble"), {
					recursive: true,
					force: true,
				})
				// Should rename staging dir to final
				expect(fs.rename).toHaveBeenCalledWith(
					path.join("/storage", "semble.new"),
					path.join("/storage", "semble"),
				)
				// Should download the new version
				expect(https.get).toHaveBeenCalledWith(expect.stringContaining("v0.3.1"), expect.any(Function))
				// Should write the new version file
				expect(fs.writeFile).toHaveBeenCalledWith(
					path.join("/storage", "semble", ".semble-version"),
					"v0.3.1",
					"utf-8",
				)
			} finally {
				if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform)
				if (originalArch) Object.defineProperty(process, "arch", originalArch)
			}
		})

		it("should skip download when installed version matches SEMBLE_VERSION and binary exists", async () => {
			const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
			const originalArch = Object.getOwnPropertyDescriptor(process, "arch")

			Object.defineProperty(process, "platform", { value: "linux", configurable: true })
			Object.defineProperty(process, "arch", { value: "x64", configurable: true })

			// Version matches
			;(fs.readFile as any).mockResolvedValue("v0.3.1")
			// Binary exists
			;(fs.access as any).mockResolvedValue(undefined)

			try {
				const result = await downloadSemble("/storage")

				expect(result).toBe(path.join("/storage", "semble", "semble"))
				// Should NOT download
				expect(https.get).not.toHaveBeenCalled()
				// Should NOT remove the extract dir
				expect(fs.rm).not.toHaveBeenCalled()
			} finally {
				if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform)
				if (originalArch) Object.defineProperty(process, "arch", originalArch)
			}
		})

		it("should re-download when version matches but binary is missing", async () => {
			const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
			const originalArch = Object.getOwnPropertyDescriptor(process, "arch")

			Object.defineProperty(process, "platform", { value: "linux", configurable: true })
			Object.defineProperty(process, "arch", { value: "x64", configurable: true })

			// Version matches
			;(fs.readFile as any).mockResolvedValue("v0.3.1")
			// But binary is missing
			let accessCallCount = 0
			;(fs.access as any).mockImplementation(() => {
				accessCallCount++
				// First call: binary path check (miss), subsequent: staged binary verify (pass)
				if (accessCallCount === 1) {
					return Promise.reject(new Error("ENOENT"))
				}
				return Promise.resolve(undefined)
			})

			// Simulate successful download
			mockWriteStream.on.mockImplementation((event: string, cb: () => void) => {
				if (event === "finish") {
					setImmediate(cb)
				}
			})

			try {
				const result = await downloadSemble("/storage")

				expect(result).toBe(path.join("/storage", "semble", "semble"))
				// Should download since binary was missing
				expect(https.get).toHaveBeenCalled()
				// Should rename staging to final
				expect(fs.rename).toHaveBeenCalledWith(
					path.join("/storage", "semble.new"),
					path.join("/storage", "semble"),
				)
				// Should write version file again
				expect(fs.writeFile).toHaveBeenCalledWith(
					path.join("/storage", "semble", ".semble-version"),
					"v0.3.1",
					"utf-8",
				)
			} finally {
				if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform)
				if (originalArch) Object.defineProperty(process, "arch", originalArch)
			}
		})

		it("should download when no version file exists (first install)", async () => {
			const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
			const originalArch = Object.getOwnPropertyDescriptor(process, "arch")

			Object.defineProperty(process, "platform", { value: "linux", configurable: true })
			Object.defineProperty(process, "arch", { value: "x64", configurable: true })

			// No version file
			;(fs.readFile as any).mockRejectedValue(new Error("ENOENT"))
			// fs.access resolves — only called for staged binary verification
			;(fs.access as any).mockResolvedValue(undefined)

			// Simulate successful download
			mockWriteStream.on.mockImplementation((event: string, cb: () => void) => {
				if (event === "finish") {
					setImmediate(cb)
				}
			})

			try {
				const result = await downloadSemble("/storage")

				expect(result).toBe(path.join("/storage", "semble", "semble"))
				expect(https.get).toHaveBeenCalled()
				// Should rename staging to final
				expect(fs.rename).toHaveBeenCalledWith(
					path.join("/storage", "semble.new"),
					path.join("/storage", "semble"),
				)
				// Should write version file
				expect(fs.writeFile).toHaveBeenCalledWith(
					path.join("/storage", "semble", ".semble-version"),
					"v0.3.1",
					"utf-8",
				)
			} finally {
				if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform)
				if (originalArch) Object.defineProperty(process, "arch", originalArch)
			}
		})
	})
})
