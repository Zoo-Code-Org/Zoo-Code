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
		await assert.rejects(
			download({ version: "test", cachePath: path.join(dir, "run3") }),
			/^Error: VS Code cache integrity mismatch$/,
		)
		await assert.rejects(fs.access(path.join(dir, "run3")))
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
})

it("retries a failed download on the next call", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-retry-"))
	let calls = 0
	try {
		const download = createPrivateVSCodeDownloader(path.join(dir, "private"), async ({ cachePath }) => {
			if (++calls === 1) throw new Error("transient download failure")
			await fs.writeFile(path.join(cachePath, "code"), "trusted")
			return path.join(cachePath, "code")
		})
		await assert.rejects(download({ version: "test", cachePath: path.join(dir, "first") }), /transient/)
		const executable = await download({ version: "test", cachePath: path.join(dir, "second") })
		assert.equal(await fs.readFile(executable, "utf8"), "trusted")
		assert.equal(calls, 2)
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
})

for (const target of ["code", "/outside/code", "../outside/code"]) {
	it(`validates cache symlink target ${target}`, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-link-"))
		try {
			const download = createPrivateVSCodeDownloader(path.join(dir, "private"), async ({ cachePath }) => {
				await fs.writeFile(path.join(cachePath, "code"), "trusted")
				await fs.symlink(target, path.join(cachePath, "link"))
				return path.join(cachePath, "code")
			})
			const result = download({ version: "test", cachePath: path.join(dir, "run") })
			if (target === "code")
				assert.equal(await fs.readFile(path.join(path.dirname(await result), "link"), "utf8"), "trusted")
			else await assert.rejects(result, /VS Code cache symlink escapes cache/)
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
}

it("rejects an executable outside the downloaded tree", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-path-"))
	try {
		const download = createPrivateVSCodeDownloader(path.join(dir, "private"), async () => path.join(dir, "outside"))
		await assert.rejects(
			download({ version: "test", cachePath: path.join(dir, "run") }),
			/VS Code executable outside cache/,
		)
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
})

it("rejects a corrupted copy with a distinct integrity error", async (t) => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-copy-"))
	const copy = fs.cp
	t.mock.method(fs, "cp", async (...args: Parameters<typeof fs.cp>) => {
		await copy(...args)
		await fs.writeFile(path.join(String(args[1]), "code"), "corrupted")
	})
	try {
		const download = createPrivateVSCodeDownloader(path.join(dir, "private"), async ({ cachePath }) => {
			await fs.writeFile(path.join(cachePath, "code"), "trusted")
			return path.join(cachePath, "code")
		})
		await assert.rejects(
			download({ version: "test", cachePath: path.join(dir, "run") }),
			/VS Code cache copy integrity mismatch/,
		)
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
})

it("rejects unsupported cache entries", async (t) => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-entry-"))
	const lstat = fs.lstat
	t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
		const stat = await lstat(...args)
		if (String(args[0]).endsWith(path.sep + "special")) {
			return Object.assign(stat, { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false })
		}
		return stat
	})
	try {
		const download = createPrivateVSCodeDownloader(path.join(dir, "private"), async ({ cachePath }) => {
			await fs.writeFile(path.join(cachePath, "special"), "fixture")
			return path.join(cachePath, "code")
		})
		await assert.rejects(
			download({ version: "test", cachePath: path.join(dir, "run") }),
			/unsupported VS Code cache entry/,
		)
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
})
