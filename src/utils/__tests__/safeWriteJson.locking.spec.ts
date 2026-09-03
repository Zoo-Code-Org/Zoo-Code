import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

const lockMock = vi.hoisted(() => vi.fn())

vi.mock("proper-lockfile", () => ({ lock: lockMock }))

import { lockJsonFile, safeWriteJson } from "../safeWriteJson"

describe("lockJsonFile", () => {
	beforeEach(() => {
		lockMock.mockReset()
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

	it("rejects with an underlying release error", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "safe-write-lock-"))
		const filePath = path.join(tempDir, "history_item.json")
		const releaseError = new Error("unlock failed")
		lockMock.mockResolvedValueOnce(vi.fn().mockRejectedValueOnce(releaseError))

		try {
			const release = await lockJsonFile(filePath)

			await expect(release()).rejects.toBe(releaseError)
		} finally {
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

	it("preserves the original write error when the lock is later compromised", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "safe-write-lock-"))
		const filePath = path.join(tempDir, "history_item.json")
		const writeError = new Error("merge failed")
		const compromised = new Error("lock ownership lost")
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		lockMock.mockImplementationOnce(async (_target: string, options: { onCompromised: (error: Error) => void }) => {
			return async () => {
				options.onCompromised(compromised)
			}
		})

		try {
			const write = safeWriteJson(
				filePath,
				{ completed: true },
				{
					merge: () => {
						throw writeError
					},
				},
			)

			await expect(write).rejects.toBe(writeError)
			expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("Failed to release lock"), compromised)
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
