import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

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
})
