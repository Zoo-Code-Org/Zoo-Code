import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { it } from "node:test"
import { acquireSideOutputLock } from "./output-lock.ts"
import { executeSideGeneration } from "./coding-side-flow.ts"

for (const active of [false, true]) {
	it(`rejects nested outputs while the parent is ${active ? "active" : "completed"}`, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "side-nested-"))
		const alias = `${dir}-alias`
		try {
			const nested = path.join(dir, "artifacts", "b")
			const rejectNested = async () => {
				await assert.rejects(acquireSideOutputLock(nested), /managed artifacts tree/)
				await assert.rejects(acquireSideOutputLock(path.join(alias, "b")), /managed artifacts tree/)
				await assert.rejects(fs.access(nested))
				assert.equal(await fs.readFile(path.join(dir, "side-results.json"), "utf8"), "complete")
			}
			await executeSideGeneration({
				out: dir,
				isInterrupted: () => false,
				run: async () => {
					await fs.mkdir(path.join(dir, "artifacts"))
					await fs.symlink(path.join(dir, "artifacts"), alias)
					await fs.writeFile(path.join(dir, "side-results.json"), "complete")
					if (active) await rejectNested()
				},
				cleanup: async () => {},
			})
			if (!active) await rejectNested()
			// Ordinary nested directories remain valid independent outputs.
			const release = await acquireSideOutputLock(path.join(dir, "other", "b"))
			release()
		} finally {
			await fs.rm(alias, { force: true })
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
}

it("shares locks across TMPDIR values and recovers an expired lock after owner death", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "side-crash-lock-"))
	const { NODE_TEST_CONTEXT: _context, ...env } = process.env
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			"--input-type=module",
			"-e",
			`
import { acquireSideOutputLock } from ${JSON.stringify(new URL("./output-lock.ts", import.meta.url).href)}
await acquireSideOutputLock(${JSON.stringify(dir)})
process.stdout.write("ready")
setInterval(() => {}, 1000)
`,
		],
		{ env: { ...env, TMPDIR: dir }, stdio: ["ignore", "pipe", "inherit"] },
	)
	const closed = new Promise<void>((resolve, reject) => {
		child.once("close", () => resolve())
		child.once("error", reject)
	})
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("lock owner readiness timeout")), 5000)
			child.stdout.once("data", () => {
				clearTimeout(timer)
				resolve()
			})
			void closed.then(() => {
				clearTimeout(timer)
				reject(new Error("lock owner exited"))
			}, reject)
		})
		await assert.rejects(acquireSideOutputLock(dir), /cannot acquire side output lock/)
		// Keep the separate owner alive beyond the stale interval. Without
		// heartbeat renewal a contender could take over this live generation.
		await new Promise((resolve) => setTimeout(resolve, 31_000))
		await assert.rejects(acquireSideOutputLock(dir), /cannot acquire side output lock/)
		child.kill("SIGKILL")
		await closed
		const canonical = await fs.realpath(dir)
		const key = createHash("sha256").update(canonical).digest("hex")
		const lock = path.join(path.dirname(canonical), `.coding-side-${key}.lock`)
		// Advance the abandoned heartbeat past expiry without slowing the suite.
		const expired = new Date(Date.now() - 60_000)
		await fs.utimes(lock, expired, expired)
		const release = await acquireSideOutputLock(dir)
		release()
	} finally {
		child.kill("SIGKILL")
		await closed
		await fs.rm(dir, { recursive: true, force: true })
	}
})

it("waits through a fresh abandoned lock before cleanup acquires it", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "side-wait-lock-"))
	const key = createHash("sha256")
		.update(await fs.realpath(dir))
		.digest("hex")
	const lock = path.join(path.dirname(dir), `.coding-side-${key}.lock`)
	try {
		await fs.mkdir(lock)
		let acquired = false
		const pending = acquireSideOutputLock(dir, 1000).then((release) => {
			acquired = true
			return release
		})
		await new Promise((resolve) => setTimeout(resolve, 100))
		assert.equal(acquired, false, "a fresh lock must still exclude cleanup")
		await fs.utimes(lock, new Date(0), new Date(0))
		const release = await pending
		try {
			assert.equal(acquired, true)
		} finally {
			release()
		}
	} finally {
		await fs.rm(lock, { recursive: true, force: true })
		await fs.rm(dir, { recursive: true, force: true })
	}
})
