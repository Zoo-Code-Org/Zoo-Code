import { execFile } from "node:child_process"
import { promisify } from "node:util"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createHostRuntime, readWorkspaceFiles } from "./launcher.ts"

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

it("rejects final workspace capture before launch", async () => {
	const runtime = createHostRuntime({ root: repoRoot, artifactsDir: os.tmpdir() })
	assert.ok(runtime.readFinalWorkspace)
	await assert.rejects(runtime.readFinalWorkspace(), /workspace not created/)
})

for (const scenario of ["nested", "oversized", "total", "count"] as const) {
	it(`captures bounded final workspace files: ${scenario}`, async () => {
		const dir = await tempDir("workspace-capture-")
		try {
			if (scenario === "nested") {
				for (const name of ["nested", "node_modules", ".git"]) {
					await fs.mkdir(path.join(dir, name))
					await fs.writeFile(path.join(dir, name, "file.js"), name)
				}
			} else {
				const count = scenario === "count" ? 4097 : scenario === "total" ? 9 : 1
				const content = scenario === "count" ? "x" : "x".repeat(scenario === "oversized" ? 1048577 : 1048576)
				await Promise.all(
					Array.from({ length: count }, (_, index) => fs.writeFile(path.join(dir, `${index}.js`), content)),
				)
			}
			const result = await readWorkspaceFiles(dir)
			assert.equal(result.truncated, scenario !== "nested")
			if (scenario === "nested") assert.deepEqual(result.files, [{ path: "nested/file.js", content: "nested" }])
			else assert.equal(result.files.length, scenario === "count" ? 4096 : scenario === "total" ? 8 : 0)
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
}

it("reads commit identity from the evaluated root despite an inherited GITHUB_SHA", async () => {
	const dir = await tempDir("identity-ci-")
	const saved = process.env.GITHUB_SHA
	try {
		process.env.GITHUB_SHA = "f".repeat(40)
		const { stdout } = await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: repoRoot })
		const identity = await createHostRuntime({ root: repoRoot, artifactsDir: dir }).readIdentity?.()
		assert.deepEqual(identity?.commit, { available: true, value: stdout.trim() })
	} finally {
		if (saved === undefined) delete process.env.GITHUB_SHA
		else process.env.GITHUB_SHA = saved
		await fs.rm(dir, { recursive: true, force: true })
	}
})

for (const scenario of ["file", "total"] as const) {
	it(`checks actual workspace bytes after stale ${scenario} stat results`, async (t) => {
		const dir = await tempDir("workspace-growth-")
		const stat = fs.stat
		try {
			const count = scenario === "file" ? 1 : 9
			for (let index = 0; index < count; index++)
				await fs.writeFile(path.join(dir, `${index}.js`), "x".repeat(scenario === "file" ? 1048577 : 1048576))
			t.mock.method(fs, "stat", async (file: string) => {
				const entry = await stat(file)
				entry.size = 0
				return entry
			})
			const snapshot = await readWorkspaceFiles(dir)
			assert.equal(snapshot.truncated, true)
			assert.equal(snapshot.files.length, scenario === "file" ? 0 : 8)
		} finally {
			t.mock.restoreAll()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
}

it("ignores poisoned caller VS Code caches and removes its fresh private cache", async () => {
	const dir = await tempDir("launcher-cache-poison-")
	const cache = path.join(dir, "apps/vscode-e2e/.vscode-test")
	const marker = path.join(dir, "poison-executed")
	let selectedCache: string | undefined
	const runtime = createHostRuntime({
		root: dir,
		artifactsDir: dir,
		downloadVSCode: async (options) => {
			assert.ok(typeof options === "object" && options !== null)
			selectedCache = options.cachePath
			assert.ok(selectedCache)
			// Mimic a cache hit: a regression selecting the caller's cache
			// executes the planted binary instead of attempting a download.
			const executable = path.join(selectedCache, "code")
			if (
				await fs.access(executable).then(
					() => true,
					() => false,
				)
			) {
				await promisify(execFile)(process.execPath, [executable, marker])
				return executable
			}
			assert.notEqual(selectedCache, cache)
			assert.equal(path.basename(selectedCache), "vscode-cache")
			assert.ok(path.basename(path.dirname(selectedCache)).startsWith("agent-evals-"))
			throw new Error("fresh cache requires download")
		},
	})
	try {
		await fs.mkdir(path.join(dir, "src"))
		await fs.writeFile(path.join(dir, "src/package.json"), "{}")
		await fs.mkdir(cache, { recursive: true })
		await fs.writeFile(path.join(dir, ".gitignore"), "apps/vscode-e2e/.vscode-test/\n")
		await fs.writeFile(
			path.join(dir, "apps/vscode-e2e/package.json"),
			JSON.stringify({ devDependencies: { "@types/vscode": "1.104.0" } }),
		)
		await fs.writeFile(path.join(cache, "code"), "require('node:fs').writeFileSync(process.argv[2], 'executed')")
		await assert.rejects(runtime.launch([]), /fresh cache requires download/)
		await assert.rejects(fs.access(marker))
		await fs.access(path.join(cache, "code"))
		assert.ok(selectedCache)
		await fs.mkdir(selectedCache)
		await runtime.cleanup()
		await assert.rejects(fs.access(selectedCache))
	} finally {
		await runtime.cleanup()
		await fs.rm(dir, { recursive: true, force: true })
	}
})

it("keeps provider credentials out of downloader extraction helpers", async () => {
	const dir = await tempDir("download-env-")
	const savedPath = process.env.PATH
	const savedKey = process.env.SOLHEIM_API_KEY
	try {
		const helper = path.join(dir, "tar")
		await fs.writeFile(helper, '#!/bin/sh\nif [ -n "$SOLHEIM_API_KEY" ]; then exit 9; fi\nprintf clean\n', {
			mode: 0o700,
		})
		const downloader = path.join(dir, "download.mjs")
		await fs.writeFile(
			downloader,
			`import { execFileSync } from 'node:child_process';
const result = execFileSync('tar', [], { encoding: 'utf8' });
if (result !== 'clean') throw new Error('extraction environment contaminated');
process.stdout.write(JSON.stringify(process.execPath));`,
		)
		process.env.PATH = `${dir}${path.delimiter}${savedPath ?? ""}`
		process.env.SOLHEIM_API_KEY = "test-provider-secret"
		const { downloadVSCodeIsolated } = await import("./launcher.ts")
		assert.equal(
			await downloadVSCodeIsolated({ version: "1.100.0", cachePath: dir }, pathToFileURL(downloader)),
			process.execPath,
		)
	} finally {
		if (savedPath === undefined) delete process.env.PATH
		else process.env.PATH = savedPath
		if (savedKey === undefined) delete process.env.SOLHEIM_API_KEY
		else process.env.SOLHEIM_API_KEY = savedKey
		await fs.rm(dir, { recursive: true, force: true })
	}
})

it("captures workspace files through the host runtime after launch", async () => {
	const dir = await tempDir("host-workspace-")
	const runtime = createHostRuntime({
		root: repoRoot,
		artifactsDir: dir,
		downloadVSCode: async () => process.execPath,
	})
	let host: Awaited<ReturnType<typeof runtime.launch>> | undefined
	try {
		const files = [{ path: "nested/answer.js", content: "export const answer = 42\n" }]
		host = await runtime.launch(files)
		assert.deepEqual(await runtime.readFinalWorkspace?.(), { files, truncated: false })
	} finally {
		host?.signal("SIGKILL")
		await runtime.cleanup()
		await fs.rm(dir, { recursive: true, force: true })
	}
})

it("does not expose authenticated proxy URLs from downloader failures", async () => {
	const dir = await tempDir("download-failure-")
	try {
		const downloader = path.join(dir, "download.mjs")
		await fs.writeFile(downloader, "throw new Error('http://user:proxy-secret@localhost:8080')")
		const { downloadVSCodeIsolated } = await import("./launcher.ts")
		await assert.rejects(
			downloadVSCodeIsolated({ cachePath: dir }, pathToFileURL(downloader)),
			(error: unknown) => {
				assert.ok(error instanceof Error)
				assert.equal(error.message, "VS Code download failed")
				assert.equal(error.cause, undefined)
				return true
			},
		)
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
})
