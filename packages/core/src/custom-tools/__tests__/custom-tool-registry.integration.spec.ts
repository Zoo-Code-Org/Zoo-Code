// pnpm --filter @roo-code/core test src/custom-tools/__tests__/custom-tool-registry.integration.spec.ts

import fs from "fs"
import os from "os"
import { createHash } from "crypto"
import path from "path"
import { fileURLToPath } from "url"

import { CustomToolRegistry } from "../custom-tool-registry.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const TEST_FIXTURES_DIR = path.join(__dirname, "fixtures")
const TEST_FIXTURES_OVERRIDE_DIR = path.join(__dirname, "fixtures-override")

describe.sequential("CustomToolRegistry integration", () => {
	let registry: CustomToolRegistry

	beforeEach(() => {
		registry = new CustomToolRegistry()
	})

	describe.skipIf(process.platform === "win32")("cache security", () => {
		let sandbox: string
		let toolDir: string
		let cacheDir: string
		let entryDir: string

		beforeEach(() => {
			sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tool-cache-security-"))
			toolDir = path.join(sandbox, "tools")
			cacheDir = path.join(sandbox, "cache")
			fs.mkdirSync(toolDir)
			const source = path.join(toolDir, "safe.ts")
			fs.writeFileSync(
				source,
				'export default { name: "safe", description: "trusted", execute: async () => "ok" }',
			)
			fs.writeFileSync(path.join(toolDir, ".env"), "SYNTHETIC_TEST_VALUE=example")
			const key = `${source}:${fs.statSync(source).mtimeMs}`
			entryDir = path.join(cacheDir, createHash("sha256").update(key).digest("hex").slice(0, 16))
			registry = new CustomToolRegistry({ cacheDir })
		})

		afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }))

		it("creates a private cache, reuses bundles across instances, and clears it", async () => {
			expect((await registry.loadFromDirectory(toolDir)).loaded).toEqual(["safe"])
			for (const location of [
				cacheDir,
				entryDir,
				path.join(entryDir, "bundle.mjs"),
				path.join(entryDir, ".env"),
			]) {
				expect(fs.statSync(location).mode & 0o077).toBe(0)
			}
			const bundle = path.join(entryDir, "bundle.mjs")
			const modified = fs.statSync(bundle).mtimeMs
			const second = new CustomToolRegistry({ cacheDir })
			expect((await second.loadFromDirectory(toolDir)).loaded).toEqual(["safe"])
			expect(fs.statSync(bundle).mtimeMs).toBe(modified)
			second.clearCache()
			expect(fs.readdirSync(cacheDir)).toEqual([])
		})

		it.each(["root", "entry", "bundle", "symlink-root", "symlink-entry", "symlink-bundle", "hardlink-bundle"])(
			"rejects an unsafe %s before importing attacker code",
			async (kind) => {
				fs.mkdirSync(entryDir, { recursive: true, mode: 0o700 })
				const payload = path.join(sandbox, "payload.mjs")
				const marker = path.join(sandbox, "executed")
				fs.writeFileSync(
					payload,
					`import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "bad")`,
				)
				const bundle = path.join(entryDir, "bundle.mjs")
				fs.copyFileSync(payload, bundle)
				fs.chmodSync(bundle, 0o600)
				const target = kind.endsWith("root") ? cacheDir : kind.endsWith("entry") ? entryDir : bundle
				if (kind.startsWith("symlink")) {
					fs.rmSync(target, { recursive: true, force: true })
					fs.symlinkSync(kind === "symlink-bundle" ? payload : toolDir, target)
				} else if (kind === "hardlink-bundle") {
					fs.linkSync(bundle, path.join(sandbox, "linked.mjs"))
				} else {
					fs.chmodSync(target, kind === "bundle" ? 0o666 : 0o777)
				}
				const result = await registry.loadFromDirectory(toolDir)
				expect(result.loaded).toEqual([])
				expect(result.failed[0]?.error).toContain("Unsafe custom tool cache")
				expect(fs.existsSync(marker)).toBe(false)
			},
		)

		it("rejects a cache owned by another account", async () => {
			fs.mkdirSync(cacheDir, { mode: 0o700 })
			const stat = fs.lstatSync(cacheDir)
			stat.uid += 1
			// The first lstat is the existing parent, then the cache root.
			const spy = vi.spyOn(fs, "lstatSync").mockReturnValueOnce(fs.statSync(sandbox)).mockReturnValueOnce(stat)
			try {
				expect((await registry.loadFromDirectory(toolDir)).failed[0]?.error).toContain(
					"Unsafe custom tool cache",
				)
			} finally {
				spy.mockRestore()
			}
		})

		it("creates nested configured cache directories privately", async () => {
			const nested = path.join(cacheDir, "nested", "cache")
			const nestedRegistry = new CustomToolRegistry({ cacheDir: nested })
			expect((await nestedRegistry.loadFromDirectory(toolDir)).loaded).toEqual(["safe"])
			expect(fs.statSync(nested).mode & 0o077).toBe(0)
		})

		it("rechecks permissions before using the in-memory cache", async () => {
			expect((await registry.loadFromDirectory(toolDir)).loaded).toEqual(["safe"])
			fs.chmodSync(entryDir, 0o777)
			expect((await registry.loadFromDirectory(toolDir)).failed[0]?.error).toContain("Unsafe custom tool cache")
		})

		it("rejects cache paths beneath a replaceable parent", async () => {
			fs.chmodSync(sandbox, 0o777)
			expect((await registry.loadFromDirectory(toolDir)).failed[0]?.error).toContain(
				"Unsafe custom tool cache parent",
			)
		})
	})

	describe("loadFromDirectory", () => {
		it("should load tools from TypeScript files", async () => {
			const result = await registry.loadFromDirectory(TEST_FIXTURES_DIR)

			expect(result.loaded).toContain("simple")
			expect(registry.has("simple")).toBe(true)
		}, 300_000)

		it("should handle named exports", async () => {
			const result = await registry.loadFromDirectory(TEST_FIXTURES_DIR)

			expect(result.loaded).toContain("multi_toolA")
			expect(result.loaded).toContain("multi_toolB")
		}, 30_000)

		it("should report validation failures", async () => {
			const result = await registry.loadFromDirectory(TEST_FIXTURES_DIR)

			const invalidFailure = result.failed.find((failure) => failure.file === "invalid.ts")
			expect(invalidFailure).toBeDefined()
			expect(invalidFailure?.error).toContain("Invalid tool definition")
		}, 30_000)

		it("should return empty results for non-existent directory", async () => {
			const result = await registry.loadFromDirectory("/nonexistent/path")

			expect(result.loaded).toHaveLength(0)
			expect(result.failed).toHaveLength(0)
		})

		it("should skip non-tool exports silently", async () => {
			const result = await registry.loadFromDirectory(TEST_FIXTURES_DIR)

			expect(result.loaded).toContain("mixed_validTool")
			expect(result.loaded).not.toContain("mixed_someString")
			expect(result.loaded).not.toContain("mixed_someNumber")
			expect(result.loaded).not.toContain("mixed_someObject")
		}, 30_000)

		it("should support args as alias for parameters", async () => {
			const result = await registry.loadFromDirectory(TEST_FIXTURES_DIR)

			expect(result.loaded).toContain("legacy")

			const tool = registry.get("legacy")
			expect(tool?.parameters).toBeDefined()
		}, 30_000)
	})

	describe("clearCache", () => {
		it("should clear the TypeScript compilation cache", async () => {
			await registry.loadFromDirectory(TEST_FIXTURES_DIR)
			registry.clearCache()

			registry.clear()
			const result = await registry.loadFromDirectory(TEST_FIXTURES_DIR)

			expect(result.loaded).toContain("cached")
		}, 300_000)
	})

	describe("loadFromDirectories", () => {
		it("should load tools from multiple directories", async () => {
			const result = await registry.loadFromDirectories([TEST_FIXTURES_DIR, TEST_FIXTURES_OVERRIDE_DIR])

			expect(result.loaded).toContain("simple")
			expect(result.loaded).toContain("unique_override")
			expect(result.loaded).toContain("multi_toolA")
		}, 60_000)

		it("should allow later directories to override earlier ones", async () => {
			await registry.loadFromDirectories([TEST_FIXTURES_DIR, TEST_FIXTURES_OVERRIDE_DIR])

			const simpleTool = registry.get("simple")
			expect(simpleTool).toBeDefined()
			expect(simpleTool?.description).toBe("Simple tool - OVERRIDDEN")
		}, 60_000)

		it("should preserve order: first directory loaded first, second overrides", async () => {
			await registry.loadFromDirectories([TEST_FIXTURES_OVERRIDE_DIR, TEST_FIXTURES_DIR])

			const simpleTool = registry.get("simple")
			expect(simpleTool).toBeDefined()
			expect(simpleTool?.description).toBe("Simple tool")
		}, 60_000)

		it("should handle non-existent directories in the array", async () => {
			const result = await registry.loadFromDirectories([
				"/nonexistent/path",
				TEST_FIXTURES_DIR,
				"/another/nonexistent",
			])

			expect(result.loaded).toContain("simple")
			expect(result.failed).toHaveLength(1)
		}, 60_000)

		it("should handle empty array", async () => {
			const result = await registry.loadFromDirectories([])

			expect(result.loaded).toHaveLength(0)
			expect(result.failed).toHaveLength(0)
		})

		it("should combine results from all directories", async () => {
			const result = await registry.loadFromDirectories([TEST_FIXTURES_DIR, TEST_FIXTURES_OVERRIDE_DIR])

			const simpleCount = result.loaded.filter((name) => name === "simple").length
			expect(simpleCount).toBe(2)
		}, 60_000)
	})

	describe("loadFromDirectoriesIfStale", () => {
		it("should load tools from multiple directories when stale", async () => {
			const result = await registry.loadFromDirectoriesIfStale([TEST_FIXTURES_DIR, TEST_FIXTURES_OVERRIDE_DIR])

			expect(result.loaded).toContain("simple")
			expect(result.loaded).toContain("unique_override")
		}, 60_000)

		it("should not reload if directories are not stale", async () => {
			await registry.loadFromDirectoriesIfStale([TEST_FIXTURES_DIR])
			registry.clear()

			const result = await registry.loadFromDirectoriesIfStale([TEST_FIXTURES_DIR])

			expect(result.loaded).toEqual([])
		}, 30_000)

		it("should handle mixed stale and non-stale directories", async () => {
			await registry.loadFromDirectoriesIfStale([TEST_FIXTURES_DIR])

			const result = await registry.loadFromDirectoriesIfStale([TEST_FIXTURES_DIR, TEST_FIXTURES_OVERRIDE_DIR])

			expect(result.loaded).toContain("simple")
			expect(result.loaded).toContain("unique_override")
		}, 60_000)
	})
})
