import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

const lockMock = vi.hoisted(() => vi.fn())

vi.mock("proper-lockfile", () => ({ lock: lockMock }))

import { lockJsonFile } from "../safeWriteJson"

describe("lockJsonFile", () => {
	it("logs and propagates a compromised parent transition lock", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "safe-write-lock-"))
		const filePath = path.join(tempDir, "history_item.json")
		const compromised = new Error("lock ownership lost")
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		lockMock.mockImplementationOnce(async (_target: string, options: { onCompromised: (error: Error) => void }) => {
			options.onCompromised(compromised)
			return async () => {}
		})

		try {
			await expect(lockJsonFile(filePath)).rejects.toBe(compromised)
			expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("was compromised"), compromised)
		} finally {
			consoleError.mockRestore()
			await fs.rm(tempDir, { recursive: true, force: true })
		}
	})
})
