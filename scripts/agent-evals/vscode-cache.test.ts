import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { it } from "node:test"
import { createPrivateVSCodeDownloader } from "./vscode-cache.ts"

it("downloads once, isolates run mutations, and rejects a poisoned reusable cache", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-cache-test-"))
	let calls = 0
	let source = ""
	const download = createPrivateVSCodeDownloader(path.join(dir, "private"), async ({ cachePath }) => {
		calls++
		source = cachePath
		const executable = path.join(cachePath, "code")
		await fs.writeFile(executable, "trusted", { mode: 0o700 })
		return executable
	})
	try {
		const first = await download({ version: "test", cachePath: path.join(dir, "run1") })
		await fs.writeFile(first, "poisoned by evaluated run")
		const second = await download({ version: "test", cachePath: path.join(dir, "run2") })
		assert.equal(await fs.readFile(second, "utf8"), "trusted")
		assert.equal(calls, 1)
		await fs.writeFile(path.join(source, "code"), "poisoned source")
		await assert.rejects(download({ version: "test", cachePath: path.join(dir, "run3") }), /integrity mismatch/)
		await assert.rejects(fs.access(path.join(dir, "run3")))
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
})
