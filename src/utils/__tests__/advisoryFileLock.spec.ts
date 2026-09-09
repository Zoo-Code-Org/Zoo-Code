const lockMock = vi.hoisted(() => vi.fn())

vi.mock("proper-lockfile", () => ({ lock: lockMock }))

import { withAdvisoryFileLock } from "../advisoryFileLock"

describe("withAdvisoryFileLock", () => {
	beforeEach(() => {
		lockMock.mockReset()
	})

	it("propagates a compromised lock after the operation settles and releases the lock", async () => {
		const compromised = new Error("lock ownership lost")
		const release = vi.fn().mockResolvedValue(undefined)
		let onCompromised: ((error: Error) => void) | undefined
		lockMock.mockImplementation(async (_filePath: string, options: { onCompromised(error: Error): void }) => {
			onCompromised = options.onCompromised
			return release
		})

		const operation = withAdvisoryFileLock("/tmp/advisory-lock-test/data.json", async () => {
			onCompromised?.(compromised)
			return "completed"
		})

		await expect(operation).rejects.toBe(compromised)
		expect(release).toHaveBeenCalledOnce()
	})

	it("preserves the operation error when the lock is also compromised", async () => {
		const compromised = new Error("lock ownership lost")
		const operationError = new Error("operation failed")
		const release = vi.fn().mockResolvedValue(undefined)
		lockMock.mockImplementation(async (_filePath: string, options: { onCompromised(error: Error): void }) => {
			options.onCompromised(compromised)
			return release
		})

		await expect(
			withAdvisoryFileLock("/tmp/advisory-lock-test/data.json", async () => {
				throw operationError
			}),
		).rejects.toBe(operationError)
		expect(release).toHaveBeenCalledOnce()
	})

	it("preserves a successful operation result when lock release fails", async () => {
		const releaseError = new Error("release failed")
		const release = vi.fn().mockRejectedValue(releaseError)
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		lockMock.mockResolvedValue(release)

		await expect(withAdvisoryFileLock("/tmp/advisory-lock-test/data.json", async () => "completed")).resolves.toBe(
			"completed",
		)
		expect(release).toHaveBeenCalledOnce()
		expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("Failed to release lock"), releaseError)
		consoleError.mockRestore()
	})

	it("preserves the operation error when lock release also fails", async () => {
		const operationError = new Error("operation failed")
		const releaseError = new Error("release failed")
		const release = vi.fn().mockRejectedValue(releaseError)
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		lockMock.mockResolvedValue(release)

		await expect(
			withAdvisoryFileLock("/tmp/advisory-lock-test/data.json", async () => {
				throw operationError
			}),
		).rejects.toBe(operationError)
		expect(release).toHaveBeenCalledOnce()
		expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("Failed to release lock"), releaseError)
		consoleError.mockRestore()
	})
})
