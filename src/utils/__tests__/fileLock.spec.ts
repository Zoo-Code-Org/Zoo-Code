// pnpm --filter roo-cline test utils/__tests__/fileLock.spec.ts

import * as path from "path"

import { acquireFileLock, withFileLock } from "../fileLock"

const { lockMock } = vi.hoisted(() => ({ lockMock: vi.fn() }))

vi.mock("proper-lockfile", () => ({ lock: lockMock, default: { lock: lockMock } }))

interface CapturedLockOptions {
	onCompromised: (error: Error) => void
}

function requireCapturedLockOptions(): CapturedLockOptions {
	if (!capturedOptions) {
		throw new Error("proper-lockfile options were not captured")
	}
	return capturedOptions
}

let capturedOptions: CapturedLockOptions | undefined

describe("fileLock", () => {
	const absoluteFilePath = path.resolve("/virtual/dir/target.json")
	let underlyingRelease: ReturnType<typeof vi.fn>
	let consoleError: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		underlyingRelease = vi.fn().mockResolvedValue(undefined)
		capturedOptions = undefined
		lockMock.mockImplementation(async (_filePath: string, options: CapturedLockOptions) => {
			capturedOptions = options
			return underlyingRelease
		})
	})

	afterEach(() => {
		consoleError.mockRestore()
		vi.clearAllMocks()
	})

	it("records the compromise without throwing from the renewal callback", () => {
		const compromiseError = Object.assign(new Error("lock renewal failed"), { code: "ECOMPROMISED" })

		return acquireFileLock(absoluteFilePath).then((release) => {
			expect(() => requireCapturedLockOptions().onCompromised(compromiseError)).not.toThrow()
			return release().catch(() => {})
		})
	})

	it("rejects the owning operation with the recorded compromise error", async () => {
		const compromiseError = Object.assign(new Error("lock renewal failed"), { code: "ECOMPROMISED" })
		const operation = vi.fn(async () => {
			// Simulate the proper-lockfile renewal timer reporting a
			// compromise while the operation still holds the lock.
			requireCapturedLockOptions().onCompromised(compromiseError)
			return "done"
		})

		await expect(withFileLock(absoluteFilePath, operation)).rejects.toBe(compromiseError)
		expect(operation).toHaveBeenCalledTimes(1)
		// proper-lockfile already marked the lock released, so the wrapper
		// must not call the underlying release after a compromise.
		expect(underlyingRelease).not.toHaveBeenCalled()
	})

	it("keeps the operation error when the operation fails after a compromise", async () => {
		const compromiseError = Object.assign(new Error("lock renewal failed"), { code: "ECOMPROMISED" })
		const operationError = new Error("operation failed")
		const operation = vi.fn(async () => {
			requireCapturedLockOptions().onCompromised(compromiseError)
			throw operationError
		})

		await expect(withFileLock(absoluteFilePath, operation)).rejects.toBe(operationError)
	})

	it("rejects a direct release with the recorded compromise error", async () => {
		const compromiseError = Object.assign(new Error("lock renewal failed"), { code: "ECOMPROMISED" })
		const release = await acquireFileLock(absoluteFilePath)

		requireCapturedLockOptions().onCompromised(compromiseError)

		await expect(release()).rejects.toBe(compromiseError)
		expect(underlyingRelease).not.toHaveBeenCalled()
	})

	it("releases normally without a compromise", async () => {
		const operation = vi.fn(async () => "done")

		await expect(withFileLock(absoluteFilePath, operation)).resolves.toBe("done")
		expect(underlyingRelease).toHaveBeenCalledTimes(1)
	})

	it("keeps reporting success when an unrelated release error occurs", async () => {
		const unlockError = new Error("unlock failed")
		underlyingRelease.mockRejectedValue(unlockError)

		await expect(
			withFileLock(
				absoluteFilePath,
				vi.fn(async () => "done"),
			),
		).resolves.toBe("done")
		expect(consoleError).toHaveBeenCalledWith(`Failed to release lock for ${absoluteFilePath}:`, unlockError)
	})
})
