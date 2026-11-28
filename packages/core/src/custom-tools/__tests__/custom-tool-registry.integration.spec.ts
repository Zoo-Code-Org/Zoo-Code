// pnpm --filter @roo-code/core test src/custom-tools/__tests__/custom-tool-registry.integration.spec.ts

import fs from "fs"
import { execFileSync } from "child_process"
import os from "os"
import { createHash } from "crypto"
import path from "path"
import { fileURLToPath } from "url"

import { CustomToolRegistry } from "../custom-tool-registry.js"
import * as esbuildRunner from "../esbuild-runner.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const TEST_FIXTURES_DIR = path.join(__dirname, "fixtures")
const TEST_FIXTURES_OVERRIDE_DIR = path.join(__dirname, "fixtures-override")

describe.sequential("CustomToolRegistry integration", () => {
	let registry: CustomToolRegistry
	let testCacheRoot: string

	beforeAll(() => {
		testCacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "registry-test-"))
	})

	beforeEach(() => {
		if (process.platform === "win32") {
			vi.spyOn(os, "homedir").mockReturnValue(testCacheRoot)
			registry = new CustomToolRegistry()
		} else {
			registry = new CustomToolRegistry({ cacheDir: path.join(testCacheRoot, "cache") })
		}
	})

	afterEach(() => vi.restoreAllMocks())
	afterAll(() => fs.rmSync(testCacheRoot, { recursive: true, force: true }))

	describe.skipIf(process.platform === "win32")("cache security", () => {
		let sandbox: string
		let toolDir: string
		let cacheDir: string
		let entryDir: string

		beforeEach(() => {
			sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tool-cache-security-")))
			toolDir = path.join(sandbox, "tools")
			cacheDir = path.join(sandbox, "cache")
			fs.mkdirSync(toolDir)
			const source = path.join(toolDir, "safe.ts")
			fs.writeFileSync(
				source,
				'export default { name: "safe", description: "trusted", execute: async () => "ok" }',
			)
			fs.writeFileSync(path.join(toolDir, ".env"), "SYNTHETIC_TEST_VALUE=example")
			const key = `v2:${source}:${fs.statSync(source).mtimeMs}`
			entryDir = path.join(cacheDir, createHash("sha256").update(key).digest("hex").slice(0, 16))
			registry = new CustomToolRegistry({ cacheDir })
		})

		afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }))

		it.each(["#", "%23", " "].flatMap((character) => ["js", "ts"].map((ext) => ({ character, ext }))))(
			"loads $ext tools with $character in their paths",
			async ({ character, ext }) => {
				const directory = path.join(sandbox, `tools${character}source`)
				fs.mkdirSync(directory)
				fs.writeFileSync(
					path.join(directory, `tool.${ext}`),
					'export default { name: "encoded", description: "path test", execute: async () => "ok" }',
				)
				const options = { cacheDir: path.join(sandbox, `cache${character}root`) }
				// Use Node directly. The Vitest loader cannot resolve encoded hash characters.
				const runtime = path.join(sandbox, "registry.mjs")
				await esbuildRunner.runEsbuild({
					entryPoint: path.join(__dirname, "../custom-tool-registry.ts"),
					outfile: runtime,
					bundle: true,
					platform: "node",
					format: "esm",
					banner: esbuildRunner.COMMONJS_REQUIRE_BANNER,
					external: esbuildRunner.NODE_BUILTIN_MODULES,
				})
				execFileSync(process.execPath, [
					"--input-type=module",
					"--eval",
					`
					import { pathToFileURL } from "node:url";
					import { deepStrictEqual } from "node:assert";
					const [runtime, directory, cacheDir] = process.argv.slice(1);
					const { CustomToolRegistry } = await import(pathToFileURL(runtime).href);
					for (let attempt = 0; attempt < 2; attempt++) {
						const registry = new CustomToolRegistry({ cacheDir });
						deepStrictEqual(await registry.loadFromDirectory(directory), { loaded: ["encoded"], failed: [] });
					}
					`,
					runtime,
					directory,
					options.cacheDir,
				])
			},
			// Allow cold compiler and native Node startup under CI coverage.
			30_000,
		)

		it.each(["EACCES", "EIO"])("does not rebuild after a bundle lookup fails with %s", async (code) => {
			expect((await registry.loadFromDirectory(toolDir)).loaded).toEqual(["safe"])
			const original = fs.lstatSync
			const error = Object.assign(new Error(`lookup failed: ${code}`), { code })
			vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
				if (args[0] === path.join(entryDir, "bundle.mjs")) throw error
				return original(...args)
			})
			const build = vi.spyOn(esbuildRunner, "runEsbuild")
			const result = await registry.loadFromDirectory(toolDir)
			expect(result.loaded).toEqual([])
			expect(result.failed[0]?.error).toBe(error.message)
			expect(build).not.toHaveBeenCalled()
		})

		it("checks a cached bundle with one lstat call", async () => {
			expect((await registry.loadFromDirectory(toolDir)).loaded).toEqual(["safe"])
			const lstat = vi.spyOn(fs, "lstatSync")
			expect((await registry.loadFromDirectory(toolDir)).loaded).toEqual(["safe"])
			const bundle = path.join(entryDir, "bundle.mjs")
			expect(lstat.mock.calls.filter(([location]) => location === bundle)).toHaveLength(1)
		})

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

		it.each(["", "/.", "/./.", "/nested/..", "/missing/.."])(
			"clears only the configured cache with suffix %s",
			(suffix) => {
				fs.mkdirSync(cacheDir, { mode: 0o700 })
				fs.mkdirSync(path.join(cacheDir, "nested"))
				const cachedBundle = path.join(cacheDir, "bundle.mjs")
				const sibling = path.join(toolDir, "sentinel")
				fs.writeFileSync(cachedBundle, "cached")
				fs.writeFileSync(sibling, "keep")
				new CustomToolRegistry({ cacheDir: `${cacheDir}${suffix}` }).clearCache()
				expect(fs.existsSync(cachedBundle)).toBe(false)
				expect(fs.existsSync(path.join(cacheDir, "nested"))).toBe(false)
				expect(fs.readFileSync(sibling, "utf8")).toBe("keep")
			},
		)

		it.each(["permissions", "symlink", "symlink-dot"])("does not clear an unsafe cache root: %s", (kind) => {
			fs.mkdirSync(cacheDir, { mode: 0o700 })
			let sentinel: string
			if (kind.startsWith("symlink")) {
				fs.rmdirSync(cacheDir)
				fs.symlinkSync(toolDir, cacheDir)
				sentinel = path.join(toolDir, "bundle.mjs")
			} else {
				fs.chmodSync(cacheDir, 0o777)
				sentinel = path.join(cacheDir, "bundle.mjs")
			}
			fs.writeFileSync(sentinel, "keep")
			const error = vi.spyOn(console, "error").mockImplementation(() => {})
			try {
				new CustomToolRegistry({ cacheDir: kind === "symlink-dot" ? `${cacheDir}/.` : cacheDir }).clearCache()
				expect(fs.readFileSync(sentinel, "utf8")).toBe("keep")
				expect(error).toHaveBeenCalledWith(expect.stringContaining("clearCache failed to clean disk cache"))
			} finally {
				error.mockRestore()
			}
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

		it.each(["root", "entry", "bundle"].flatMap((kind) => [0o070, 0o007].map((bits) => ({ kind, bits }))))(
			"rejects isolated permission bits $bits on $kind",
			async ({ kind, bits }) => {
				expect((await registry.loadFromDirectory(toolDir)).loaded).toEqual(["safe"])
				const target =
					kind === "root" ? cacheDir : kind === "entry" ? entryDir : path.join(entryDir, "bundle.mjs")
				fs.chmodSync(target, (kind === "bundle" ? 0o600 : 0o700) | bits)
				const result = await registry.loadFromDirectory(toolDir)
				expect(result.loaded).toEqual([])
				expect(result.failed[0]?.error).toContain(`Unsafe custom tool cache path: ${target}`)
			},
		)

		it.each(["root", "entry", "bundle"])("rejects a wrong filesystem type at %s", async (kind) => {
			fs.mkdirSync(entryDir, { recursive: true, mode: 0o700 })
			const target = kind === "root" ? cacheDir : kind === "entry" ? entryDir : path.join(entryDir, "bundle.mjs")
			fs.rmSync(target, { recursive: true, force: true })
			if (kind === "bundle") fs.mkdirSync(target, { mode: 0o700 })
			else fs.writeFileSync(target, "not a directory", { mode: 0o600 })
			const result = await registry.loadFromDirectory(toolDir)
			expect(result.loaded).toEqual([])
			expect(result.failed[0]?.error).toContain(
				kind === "bundle" ? `Unsafe custom tool cache path: ${target}` : "EEXIST",
			)
		})

		it.each(["mode", "symlink", "hardlink", "owner"])(
			"rejects a swapped bundle after a first load: %s",
			async (kind) => {
				expect((await registry.loadFromDirectory(toolDir)).loaded).toEqual(["safe"])
				const bundle = path.join(entryDir, "bundle.mjs")
				if (kind === "mode") fs.chmodSync(bundle, 0o640)
				if (kind === "hardlink") fs.linkSync(bundle, path.join(sandbox, "linked.mjs"))
				if (kind === "symlink") {
					const other = path.join(sandbox, "other.mjs")
					fs.renameSync(bundle, other)
					fs.symlinkSync(other, bundle)
				}
				if (kind === "owner") {
					const original = fs.lstatSync
					const canonical = fs.realpathSync(bundle)
					vi.spyOn(fs, "lstatSync").mockImplementation((location, options) => {
						const stat = original(location, options)
						if (String(location) === canonical && stat) {
							stat.uid = typeof stat.uid === "bigint" ? stat.uid + 1n : stat.uid + 1
						}
						return stat
					})
				}
				const result = await registry.loadFromDirectory(toolDir)
				expect(result.loaded).toEqual([])
				expect(result.failed[0]?.error).toContain(
					`Unsafe custom tool cache path: ${fs.realpathSync(entryDir)}/bundle.mjs`,
				)
			},
		)

		it.each([
			{ mode: 0o720, accepted: false },
			{ mode: 0o702, accepted: false },
			{ mode: 0o777, accepted: false },
			{ mode: 0o1777, accepted: true },
			{ mode: 0o755, accepted: true },
		])("checks grandparent mode $mode (accepted: $accepted)", async ({ mode, accepted }) => {
			fs.mkdirSync(path.join(sandbox, "parent"), { mode: 0o700 })
			fs.chmodSync(sandbox, mode)
			const instance = new CustomToolRegistry({ cacheDir: path.join(sandbox, "parent", "cache") })
			const result = await instance.loadFromDirectory(toolDir)
			expect(result.loaded).toEqual(accepted ? ["safe"] : [])
			if (!accepted) expect(result.failed[0]?.error).toContain("Unsafe custom tool cache parent")
		})

		it.each(["current", "root", "foreign"])("checks ancestor ownership: %s", async (owner) => {
			const canonical = fs.realpathSync(sandbox)
			const original = fs.statSync
			vi.spyOn(fs, "statSync").mockImplementation((location, options) => {
				const stat = original(location, options)
				if (String(location) === canonical && stat) {
					stat.uid = owner === "root" ? 0 : owner === "current" ? process.getuid!() : process.getuid!() + 1234
				}
				return stat
			})
			const result = await registry.loadFromDirectory(toolDir)
			expect(result.loaded).toEqual(owner === "foreign" ? [] : ["safe"])
			if (owner === "foreign")
				expect(result.failed[0]?.error).toContain(`Unsafe custom tool cache parent: ${canonical}`)
		})

		it.each(["direct", "symlink-parent"])("rejects a cache owned by another account via %s", async (kind) => {
			fs.mkdirSync(cacheDir, { mode: 0o700 })
			if (kind === "symlink-parent") {
				const alias = path.join(sandbox, "alias")
				fs.symlinkSync(sandbox, alias)
				cacheDir = path.join(alias, "cache")
				registry = new CustomToolRegistry({ cacheDir })
			}
			const resolvedCacheDir = fs.realpathSync(cacheDir)
			const stat = fs.lstatSync(resolvedCacheDir)
			stat.uid += 1
			const originalLstat = fs.lstatSync
			const spy = vi.spyOn(fs, "lstatSync").mockImplementation((location, options) => {
				return location === resolvedCacheDir ? stat : originalLstat(location, options)
			})
			try {
				const result = await registry.loadFromDirectory(toolDir)
				expect(result.loaded).toEqual([])
				expect(result.failed).toEqual([
					{ file: "safe.ts", error: `Unsafe custom tool cache path: ${resolvedCacheDir}` },
				])
			} finally {
				spy.mockRestore()
			}
		})

		it.each(["success", "build failure", "validation failure", "publish failure"])(
			"publishes only complete private bundles and removes pending files: %s",
			async (outcome) => {
				const bundle = path.join(entryDir, "bundle.mjs")
				const originalChmod = fs.chmodSync
				const originalRename = fs.renameSync
				const chmod = vi.spyOn(fs, "chmodSync").mockImplementation((location, mode) => {
					if (String(location).endsWith(".mjs")) {
						expect(fs.existsSync(bundle)).toBe(false)
						expect(fs.readFileSync(location, "utf8")).toContain('name: "safe"')
						if (outcome === "validation failure") return originalChmod(location, 0o644)
					}
					return originalChmod(location, mode)
				})
				const rename = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
					if (destination !== bundle) {
						originalRename(source, destination)
						return
					}
					expect(fs.readFileSync(path.join(entryDir, ".env"), "utf8")).toBe("SYNTHETIC_TEST_VALUE=example")
					expect(fs.statSync(source).mode & 0o777).toBe(0o600)
					if (outcome === "publish failure") throw new Error("Synthetic publish failure")
					originalRename(source, destination)
				})
				if (outcome === "build failure") fs.writeFileSync(path.join(toolDir, "safe.ts"), "export default {")
				try {
					const result = await registry.loadFromDirectory(toolDir)
					expect(result.loaded).toEqual(outcome === "success" ? ["safe"] : [])
					expect(result.failed).toHaveLength(outcome === "success" ? 0 : 1)
					if (outcome === "build failure") expect(result.failed[0]?.error).toContain("esbuild")
					if (outcome === "validation failure")
						expect(result.failed[0]?.error).toContain("Unsafe custom tool cache path")
					if (outcome === "publish failure") expect(result.failed[0]?.error).toBe("Synthetic publish failure")
					// A source change creates a new hash, so inspect all entries.
					const entries = fs.readdirSync(cacheDir)
					for (const entry of entries) {
						expect(
							fs.readdirSync(path.join(cacheDir, entry)).filter((name) => name.endsWith(".tmp.mjs")),
						).toEqual([])
					}
					expect(fs.existsSync(bundle)).toBe(outcome === "success")
					expect(rename.mock.calls.filter(([, destination]) => destination === bundle)).toHaveLength(
						outcome === "success" || outcome === "publish failure" ? 1 : 0,
					)
				} finally {
					chmod.mockRestore()
					rename.mockRestore()
				}
			},
		)

		it("does not reuse entries from the old publication format", async () => {
			const source = path.join(toolDir, "safe.ts")
			const key = `${source}:${fs.statSync(source).mtimeMs}`
			const oldEntry = path.join(cacheDir, createHash("sha256").update(key).digest("hex").slice(0, 16))
			fs.mkdirSync(cacheDir, { mode: 0o700 })
			fs.mkdirSync(oldEntry, { mode: 0o755 })
			fs.writeFileSync(path.join(oldEntry, "bundle.mjs"), 'throw new Error("Old incomplete entry")')
			expect(await registry.loadFromDirectory(toolDir)).toEqual({ loaded: ["safe"], failed: [] })
			expect(fs.readFileSync(path.join(entryDir, ".env"), "utf8")).toBe("SYNTHETIC_TEST_VALUE=example")
			expect(fs.statSync(oldEntry).mode & 0o777).toBe(0o755)
		})

		it("can reuse a complete entry after an interruption at the commit marker", async () => {
			const original = fs.renameSync
			vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
				original(source, destination)
				if (path.basename(String(destination)) === "bundle.mjs")
					throw new Error("Synthetic interruption after commit")
			})
			const result = await registry.loadFromDirectory(toolDir)
			expect(result.failed[0]?.error).toBe("Synthetic interruption after commit")
			vi.restoreAllMocks()
			expect(await new CustomToolRegistry({ cacheDir }).loadFromDirectory(toolDir)).toEqual({
				loaded: ["safe"],
				failed: [],
			})
			expect(fs.readFileSync(path.join(entryDir, ".env"), "utf8")).toBe("SYNTHETIC_TEST_VALUE=example")
		})

		it.each(["bundle", "entry", "root"])("rebuilds a deleted %s on the next load", async (kind) => {
			expect((await registry.loadFromDirectory(toolDir)).loaded).toEqual(["safe"])
			const target =
				kind === "bundle" ? path.join(entryDir, "bundle.mjs") : kind === "entry" ? entryDir : cacheDir
			fs.rmSync(target, { recursive: true, force: true })
			expect(await registry.loadFromDirectory(toolDir)).toEqual({ loaded: ["safe"], failed: [] })
			expect(fs.existsSync(path.join(entryDir, "bundle.mjs"))).toBe(true)
			expect(fs.readFileSync(path.join(entryDir, ".env"), "utf8")).toBe("SYNTHETIC_TEST_VALUE=example")
		})

		it.each(["direct", "stale", "directories"])(
			"does not rebuild an unchanged source error through %s",
			async (entry) => {
				const source = path.join(toolDir, "safe.ts")
				fs.writeFileSync(source, "export default {")
				const modified = fs.statSync(source).mtimeMs
				const directoryModified = fs.statSync(toolDir).mtimeMs
				const build = vi.spyOn(esbuildRunner, "runEsbuild")
				const load = () =>
					entry === "direct"
						? registry.loadFromDirectory(toolDir)
						: entry === "stale"
							? registry.loadFromDirectoryIfStale(toolDir)
							: registry.loadFromDirectoriesIfStale([toolDir])
				const first = await load()
				expect(first.loaded).toEqual([])
				expect(first.failed[0]?.error).toContain("esbuild failed")
				expect(await load()).toEqual(first)
				expect(build).toHaveBeenCalledTimes(1)
				fs.writeFileSync(
					source,
					'export default { name: "safe", description: "fixed", execute: async () => "ok" }',
				)
				fs.utimesSync(source, new Date(), new Date(modified + 2000))
				expect(fs.statSync(toolDir).mtimeMs).toBe(directoryModified)
				expect(await load()).toEqual({ loaded: ["safe"], failed: [] })
				expect(build).toHaveBeenCalledTimes(2)
			},
		)

		it("clearCache permits another build of an unchanged failed source", async () => {
			fs.writeFileSync(path.join(toolDir, "safe.ts"), "export default {")
			const build = vi.spyOn(esbuildRunner, "runEsbuild")
			expect((await registry.loadFromDirectoryIfStale(toolDir)).failed).toHaveLength(1)
			expect((await registry.loadFromDirectoryIfStale(toolDir)).failed).toHaveLength(1)
			expect(build).toHaveBeenCalledTimes(1)
			registry.clearCache()
			expect((await registry.loadFromDirectoryIfStale(toolDir)).failed).toHaveLength(1)
			expect(build).toHaveBeenCalledTimes(2)
		})

		it("retries dependency resolution without a source change", async () => {
			const source = path.join(toolDir, "safe.ts")
			fs.writeFileSync(
				source,
				'import value from "./dependency.js"; export default { name: "safe", description: value, execute: async () => "ok" }',
			)
			const modified = fs.statSync(source).mtimeMs
			const build = vi.spyOn(esbuildRunner, "runEsbuild")
			expect((await registry.loadFromDirectoryIfStale(toolDir)).failed[0]?.error).toContain("Could not resolve")
			fs.writeFileSync(path.join(toolDir, "dependency.js"), 'export default "dependency is available"')
			expect(fs.statSync(source).mtimeMs).toBe(modified)
			expect(await registry.loadFromDirectoryIfStale(toolDir)).toEqual({ loaded: ["safe"], failed: [] })
			expect(build).toHaveBeenCalledTimes(2)
		})

		it("retries an unclassified compiler failure without a source change", async () => {
			const build = vi
				.spyOn(esbuildRunner, "runEsbuild")
				.mockRejectedValueOnce(new Error("Synthetic compiler I/O failure"))
			expect((await registry.loadFromDirectoryIfStale(toolDir)).failed[0]?.error).toBe(
				"Synthetic compiler I/O failure",
			)
			expect(await registry.loadFromDirectoryIfStale(toolDir)).toEqual({ loaded: ["safe"], failed: [] })
			expect(build).toHaveBeenCalledTimes(2)
		})

		it("retries a failed stale load without a directory change", async () => {
			fs.mkdirSync(cacheDir, { mode: 0o755 })
			const modified = fs.statSync(toolDir).mtimeMs
			expect((await registry.loadFromDirectoriesIfStale([toolDir])).failed[0]?.error).toContain(
				"Unsafe custom tool cache",
			)
			fs.chmodSync(cacheDir, 0o700)
			expect(fs.statSync(toolDir).mtimeMs).toBe(modified)
			expect(await registry.loadFromDirectoriesIfStale([toolDir])).toEqual({ loaded: ["safe"], failed: [] })
		})

		it.each(["copy", "chmod", "rename"])("does not commit a bundle after an env %s failure", async (operation) => {
			const originalCopy = fs.copyFileSync
			const originalChmod = fs.chmodSync
			const originalRename = fs.renameSync
			vi.spyOn(fs, "copyFileSync").mockImplementation((source, destination, flags) => {
				if (operation === "copy") {
					fs.writeFileSync(destination, "truncated")
					throw new Error("Synthetic env copy failure")
				}
				originalCopy(source, destination, flags)
			})
			vi.spyOn(fs, "chmodSync").mockImplementation((location, mode) => {
				if (operation === "chmod" && !String(location).endsWith(".mjs"))
					throw new Error("Synthetic env chmod failure")
				originalChmod(location, mode)
			})
			vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
				if (operation === "rename" && path.basename(String(destination)) === ".env")
					throw new Error("Synthetic env rename failure")
				if (path.basename(String(destination)) === "bundle.mjs") {
					expect(fs.readFileSync(path.join(entryDir, ".env"), "utf8")).toBe("SYNTHETIC_TEST_VALUE=example")
				}
				originalRename(source, destination)
			})
			const result = await registry.loadFromDirectory(toolDir)
			expect(result.loaded).toEqual([])
			expect(result.failed[0]?.error).toBe(`Synthetic env ${operation} failure`)
			expect(fs.existsSync(path.join(entryDir, "bundle.mjs"))).toBe(false)
			expect(fs.readdirSync(entryDir)).toEqual([])
			vi.restoreAllMocks()
			expect(await new CustomToolRegistry({ cacheDir }).loadFromDirectory(toolDir)).toEqual({
				loaded: ["safe"],
				failed: [],
			})
		})

		it("checks the cache directory again before publication", async () => {
			const originalChmod = fs.chmodSync
			vi.spyOn(fs, "chmodSync").mockImplementation((location, mode) => {
				originalChmod(location, mode)
				if (String(location).endsWith(".mjs")) originalChmod(entryDir, 0o755)
			})
			const result = await registry.loadFromDirectory(toolDir)
			expect(result.loaded).toEqual([])
			expect(result.failed[0]?.error).toContain(`Unsafe custom tool cache path: ${entryDir}`)
			expect(fs.existsSync(path.join(entryDir, "bundle.mjs"))).toBe(false)
		})

		it("continues cleanup after an entry fails", () => {
			fs.mkdirSync(cacheDir, { mode: 0o700 })
			for (const name of ["a", "b"]) fs.mkdirSync(path.join(cacheDir, name))
			const originalRm = fs.rmSync
			vi.spyOn(fs, "rmSync").mockImplementation((location, options) => {
				if (path.basename(String(location)) === "a") throw new Error("Synthetic cleanup failure")
				originalRm(location, options)
			})
			registry.clearCache()
			expect(fs.existsSync(path.join(cacheDir, "a"))).toBe(true)
			expect(fs.existsSync(path.join(cacheDir, "b"))).toBe(false)
		})

		it("rejects a newly created ancestor with loose permissions", async () => {
			const original = fs.mkdirSync
			vi.spyOn(fs, "mkdirSync").mockImplementation((location, options) => {
				const result = original(location, options)
				if (path.basename(String(location)) === "nested") fs.chmodSync(location, 0o755)
				return result
			})
			const nested = path.join(cacheDir, "nested", "cache")
			const result = await new CustomToolRegistry({ cacheDir: nested }).loadFromDirectory(toolDir)
			expect(result.loaded).toEqual([])
			expect(result.failed[0]?.error).toContain("Unsafe custom tool cache path")
			expect(fs.existsSync(nested)).toBe(false)
		})

		it("reports a directory listing failure and retries it", async () => {
			const original = fs.readdirSync
			vi.spyOn(fs, "readdirSync").mockImplementation((location, options) => {
				if (String(location) === toolDir) throw new Error("Synthetic directory listing failure")
				return original(location, options)
			})
			expect(await registry.loadFromDirectoryIfStale(toolDir)).toEqual({
				loaded: [],
				failed: [{ file: toolDir, error: "Synthetic directory listing failure" }],
			})
			vi.restoreAllMocks()
			expect(await registry.loadFromDirectoryIfStale(toolDir)).toEqual({ loaded: ["safe"], failed: [] })
		})

		it("creates nested configured cache directories privately", async () => {
			const nested = path.join(cacheDir, "nested", "cache")
			const nestedRegistry = new CustomToolRegistry({ cacheDir: nested })
			expect((await nestedRegistry.loadFromDirectory(toolDir)).loaded).toEqual(["safe"])
			for (const directory of [cacheDir, path.join(cacheDir, "nested"), nested]) {
				expect(fs.statSync(directory).mode & 0o077).toBe(0)
			}
		})

		it("rechecks permissions on every reload", async () => {
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
			await registry.loadFromDirectoriesIfStale([TEST_FIXTURES_OVERRIDE_DIR])
			registry.clear()

			const result = await registry.loadFromDirectoriesIfStale([TEST_FIXTURES_OVERRIDE_DIR])

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
