import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import * as recovery from "../../../utils/jsonFileRecovery"
import { readFileWithMissingRetry } from "../readFileWithMissingRetry"

describe("readFileWithMissingRetry", () => {
	let dir: string
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "missing-retry-"))
	})
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("reads an existing file", async () => {
		const target = path.join(dir, "data.json")
		await fs.writeFile(target, "[]")
		await expect(readFileWithMissingRetry(target)).resolves.toBe("[]")
	})

	it("preserves ENOENT after the second read when nothing can be recovered", async () => {
		await expect(readFileWithMissingRetry(path.join(dir, "missing.json"))).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("propagates non-ENOENT errors", async () => {
		await expect(readFileWithMissingRetry(dir)).rejects.toMatchObject({ code: "EISDIR" })
	})

	// The callers of this reader classify the failure they receive by error code:
	// apiMessages.ts maps ENOENT to "no file yet" and anything else to io_error,
	// taskMessages.ts maps it to the "not_found" kind, and TaskHistoryStore.ts swallows
	// it into null. A recovery that rejects must therefore not reach the caller as the
	// read's error - the reader's own ENOENT is the failure those classifiers know.
	it("reports the missing file, not the recovery failure, when recovery itself rejects", async () => {
		const missing = path.join(dir, "api_mock_latest.json")
		const recoveryError = Object.assign(new Error("recovery scan failed"), { code: "EBUSY" })
		// The recovery puts the file back and then fails - it loses the lock too late to
		// report success. A rejection still cannot be read as "recovered": the reader cannot
		// tell whether the recovery finished, and every caller classifies this read by error
		// code. If the rejection counted as a recovery, the reader would return the planted
		// bytes and the row below would pass on a third read.
		const recoverySpy = vi.spyOn(recovery, "recoverMissingJsonFile").mockImplementation(async () => {
			await fs.writeFile(missing, JSON.stringify({ recoveredBySomeoneElse: true }))
			throw recoveryError
		})
		try {
			let failure: unknown
			const value = await readFileWithMissingRetry(missing).catch((reason: unknown) => {
				failure = reason
				return undefined
			})
			// The rejection carries EBUSY, which every caller above would report as an I/O
			// error on a file that is simply not there yet; the reader's own failure is the
			// ENOENT it already saw, and a resolved read of the planted bytes would be a third
			// outcome neither the caller nor this row expects.
			expect(failure).toBeDefined()
			expect(value).toBeUndefined()
			expect(failure).not.toBe(recoveryError)
			expect(failure).toMatchObject({ code: "ENOENT" })
			// The recovery was attempted exactly once, so the missing-file retry the rows
			// above assert is unchanged.
			expect(recoverySpy).toHaveBeenCalledTimes(1)
		} finally {
			recoverySpy.mockRestore()
		}
	})
})
