import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { createHostRuntime } from "./launcher.ts"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

const tempDir = async (prefix: string): Promise<string> => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
	return dir
}

describe("host runtime", () => {
	it("writes artifacts atomically and replaces them on rewrite", async () => {
		const dir = await tempDir("agent-evals-artifacts-")
		try {
			const runtime = createHostRuntime({ root: repoRoot, artifactsDir: dir })
			await runtime.writeArtifact("trace.json", { v: 1 })
			assert.equal(await fs.readFile(path.join(dir, "trace.json"), "utf8"), JSON.stringify({ v: 1 }, null, 2))
			await runtime.writeArtifact("trace.json", { v: 2 })
			assert.equal(JSON.parse(await fs.readFile(path.join(dir, "trace.json"), "utf8")).v, 2)
			const leftovers = (await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"))
			assert.deepEqual(leftovers, [])
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("contains artifact names inside the artifacts directory", async () => {
		const dir = await tempDir("agent-evals-artifacts-")
		try {
			const runtime = createHostRuntime({ root: repoRoot, artifactsDir: dir })
			await runtime.writeArtifact("../escape.json", { ok: true })
			assert.ok((await fs.stat(path.join(dir, "escape.json"))).isFile())
			assert.equal(
				await fs.stat(path.join(dir, "..", "escape.json")).then(
					() => true,
					() => false,
				),
				false,
			)
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("reports run identity from the repository, or bounded unavailability", async () => {
		const dir = await tempDir("agent-evals-identity-")
		try {
			const runtime = createHostRuntime({ root: repoRoot, artifactsDir: dir })
			const identity = await runtime.readIdentity?.()
			assert.ok(identity)
			assert.match(identity.nodeVersion, /^v\d+\./)
			assert.equal(["linux", "darwin", "win32"].includes(identity.platform), true)
			if (identity.commit.available) assert.match(identity.commit.value, /^[0-9a-f]{40}$/)
			if (identity.extensionVersion.available) assert.match(identity.extensionVersion.value, /^\d+\.\d+\.\d+/)
			if (identity.vscodeTarget.available) assert.match(identity.vscodeTarget.value, /^\d+\.\d+\.\d+/)
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})
