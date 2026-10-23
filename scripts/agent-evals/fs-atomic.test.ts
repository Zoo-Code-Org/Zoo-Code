import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { writeFileAtomic, writeJsonAtomic } from "./fs-atomic.ts"

describe("atomic file publication", () => {
	it("publishes the content and leaves no temp files", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-atomic-test-"))
		try {
			const target = path.join(dir, "report.json")
			await writeFileAtomic(target, '{"a":1}')
			assert.equal(await fs.readFile(target, "utf8"), '{"a":1}')
			const entries = await fs.readdir(dir)
			assert.deepEqual(entries, ["report.json"])
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("replaces an existing file in place", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-atomic-test-"))
		try {
			const target = path.join(dir, "side-results.json")
			await writeJsonAtomic(target, { version: 1 })
			await writeJsonAtomic(target, { version: 2 })
			assert.equal(await fs.readFile(target, "utf8"), JSON.stringify({ version: 2 }, null, 2))
			const entries = await fs.readdir(dir)
			assert.deepEqual(entries, ["side-results.json"])
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("preserves the previous file and leaves no temp residue when a write fails", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-atomic-test-"))
		try {
			const target = path.join(dir, "run-record.json")
			await writeFileAtomic(target, "previous")
			// The temp file is created before the rename; a rename into a
			// missing directory fails and must clean its temp file while the
			// original stays intact.
			await assert.rejects(writeFileAtomic(path.join(dir, "missing", "run-record.json"), "next"))
			assert.equal(await fs.readFile(target, "utf8"), "previous")
			const entries = await fs.readdir(dir)
			assert.deepEqual(entries, ["run-record.json"])
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})
