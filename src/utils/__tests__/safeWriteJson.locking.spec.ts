import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

const lockMock = vi.hoisted(() => vi.fn())

vi.mock("proper-lockfile", () => ({ lock: lockMock }))

import { LOCK_STALE_MS, lockJsonFile, safeWriteJson } from "../safeWriteJson"

describe("lockJsonFile", () => {
	beforeEach(() => {
		lockMock.mockReset()
	})

	it("acquires the lock with bounded retries and compromise handling", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "safe-write-lock-"))
		const filePath = path.join(tempDir, "history_item.json")
		const underlyingRelease = vi.fn(async () => {})
		lockMock.mockResolvedValueOnce(underlyingRelease)

		try {
			const release = await lockJsonFile(filePath)

			expect(lockMock).toHaveBeenCalledWith(path.resolve(filePath), {
				stale: LOCK_STALE_MS,
				update: 10000,
				realpath: false,
				retries: {
					retries: 5,
					factor: 2,
					minTimeout: 100,
					maxTimeout: 1000,
				},
				onCompromised: expect.any(Function),
			})
			await release()
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true })
		}
	})

	it("defers a delayed compromise until release without throwing from the callback", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "safe-write-lock-"))
		const filePath = path.join(tempDir, "history_item.json")
		const compromised = new Error("lock ownership lost")
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		const underlyingRelease = vi.fn(async () => {})
		let onCompromised: ((error: Error) => void) | undefined
		lockMock.mockImplementationOnce(async (_target: string, options: { onCompromised: (error: Error) => void }) => {
			onCompromised = options.onCompromised
			return underlyingRelease
		})

		try {
			const release = await lockJsonFile(filePath)

			expect(() => onCompromised?.(compromised)).not.toThrow()
			onCompromised?.(new Error("later compromise"))
			await expect(release()).rejects.toBe(compromised)
			expect(underlyingRelease).toHaveBeenCalledOnce()
			expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("was compromised"), compromised)
		} finally {
			consoleError.mockRestore()
			await fs.rm(tempDir, { recursive: true, force: true })
		}
	})

	it("surfaces a release error without logging an operation-failure arbitration message", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "safe-write-lock-"))
		const filePath = path.join(tempDir, "history_item.json")
		const releaseError = new Error("unlock failed")
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		lockMock.mockResolvedValueOnce(vi.fn().mockRejectedValueOnce(releaseError))

		try {
			await expect(safeWriteJson(filePath, { completed: true })).rejects.toBe(releaseError)
			expect(consoleError).not.toHaveBeenCalled()
		} finally {
			consoleError.mockRestore()
			await fs.rm(tempDir, { recursive: true, force: true })
		}
	})

	it("logs an underlying release error but rejects with the earlier compromise", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "safe-write-lock-"))
		const filePath = path.join(tempDir, "history_item.json")
		const absoluteFilePath = path.resolve(filePath)
		const compromised = new Error("lock ownership lost")
		const releaseError = new Error("unlock failed")
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		lockMock.mockImplementationOnce(async (_target: string, options: { onCompromised: (error: Error) => void }) => {
			return async () => {
				options.onCompromised(compromised)
				throw releaseError
			}
		})

		try {
			const release = await lockJsonFile(filePath)

			await expect(release()).rejects.toBe(compromised)
			expect(consoleError).toHaveBeenNthCalledWith(
				2,
				`Failed to release compromised lock for ${absoluteFilePath}:`,
				releaseError,
			)
		} finally {
			consoleError.mockRestore()
			await fs.rm(tempDir, { recursive: true, force: true })
		}
	})

	it("logs the target path and acquisition error before propagating it", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "safe-write-lock-"))
		const filePath = path.join(tempDir, "history_item.json")
		const absoluteFilePath = path.resolve(filePath)
		const acquisitionError = new Error("lock unavailable")
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		lockMock.mockRejectedValueOnce(acquisitionError)

		try {
			await expect(safeWriteJson(filePath, { completed: true })).rejects.toBe(acquisitionError)
			expect(consoleError).toHaveBeenCalledOnce()
			expect(consoleError).toHaveBeenCalledWith(
				`Failed to acquire lock for ${absoluteFilePath}:`,
				acquisitionError,
			)
		} finally {
			consoleError.mockRestore()
			await fs.rm(tempDir, { recursive: true, force: true })
		}
	})

	it("rejects a successful write when the lock is compromised before release", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "safe-write-lock-"))
		const filePath = path.join(tempDir, "history_item.json")
		const compromised = new Error("lock ownership lost")
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		lockMock.mockImplementationOnce(async (_target: string, options: { onCompromised: (error: Error) => void }) => {
			return async () => {
				options.onCompromised(compromised)
			}
		})

		try {
			await expect(safeWriteJson(filePath, { completed: true })).rejects.toBe(compromised)
		} finally {
			consoleError.mockRestore()
			await fs.rm(tempDir, { recursive: true, force: true })
		}
	})

	it("preserves an operation error when release also fails", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "safe-write-lock-"))
		const filePath = path.join(tempDir, "history_item.json")
		const absoluteFilePath = path.resolve(filePath)
		const operationError = new Error("merge failed")
		const releaseError = new Error("unlock failed")
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		lockMock.mockResolvedValueOnce(vi.fn().mockRejectedValueOnce(releaseError))

		try {
			const write = safeWriteJson(
				filePath,
				{ completed: true },
				{
					merge: () => {
						throw operationError
					},
				},
			)

			await expect(write).rejects.toBe(operationError)
			expect(consoleError).toHaveBeenCalledWith(
				`Operation failed for ${absoluteFilePath}: [Original Error Caught]`,
				operationError,
			)
			expect(consoleError).toHaveBeenCalledWith(`Failed to release lock for ${absoluteFilePath}:`, releaseError)
		} finally {
			consoleError.mockRestore()
			await fs.rm(tempDir, { recursive: true, force: true })
		}
	})

	it("resolves after a normal release", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "safe-write-lock-"))
		const filePath = path.join(tempDir, "history_item.json")
		const underlyingRelease = vi.fn(async () => {})
		lockMock.mockResolvedValueOnce(underlyingRelease)

		try {
			const release = await lockJsonFile(filePath)

			await expect(release()).resolves.toBeUndefined()
			expect(underlyingRelease).toHaveBeenCalledOnce()
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true })
		}
	})
})
