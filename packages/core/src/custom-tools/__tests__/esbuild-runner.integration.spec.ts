import fs from "fs"
import os from "os"
import path from "path"

import { COMMONJS_REQUIRE_BANNER, runEsbuild } from "../esbuild-runner.js"

describe.sequential("runEsbuild integration", () => {
	let tempDir: string

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "esbuild-runner-test-"))
	})

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it("should compile a TypeScript file to ESM", async () => {
		const inputFile = path.join(tempDir, "input.ts")
		const outputFile = path.join(tempDir, "output.mjs")

		fs.writeFileSync(
			inputFile,
			`
				export const greeting = "Hello, World!"
				export function add(a: number, b: number): number {
					return a + b
				}
			`,
		)

		await runEsbuild({
			entryPoint: inputFile,
			outfile: outputFile,
			format: "esm",
			platform: "node",
			target: "node18",
			bundle: true,
		})

		expect(fs.existsSync(outputFile)).toBe(true)

		const outputContent = fs.readFileSync(outputFile, "utf-8")
		expect(outputContent).toContain("Hello, World!")
		expect(outputContent).toContain("add")
	}, 30_000)

	it("should generate inline source maps when specified", async () => {
		const inputFile = path.join(tempDir, "input.ts")
		const outputFile = path.join(tempDir, "output.mjs")

		fs.writeFileSync(inputFile, `export const value = 42`)

		await runEsbuild({ entryPoint: inputFile, outfile: outputFile, format: "esm", sourcemap: "inline" })

		const outputContent = fs.readFileSync(outputFile, "utf-8")
		expect(outputContent).toContain("sourceMappingURL=data:")
	}, 30_000)

	it("should throw an error for invalid TypeScript", async () => {
		const inputFile = path.join(tempDir, "invalid.ts")
		const outputFile = path.join(tempDir, "output.mjs")

		fs.writeFileSync(inputFile, `export const value = {{{ invalid syntax`)

		await expect(runEsbuild({ entryPoint: inputFile, outfile: outputFile, format: "esm" })).rejects.toThrow()
	}, 30_000)

	it("should throw an error for non-existent file", async () => {
		const nonExistentFile = path.join(tempDir, "does-not-exist.ts")
		const outputFile = path.join(tempDir, "output.mjs")

		await expect(runEsbuild({ entryPoint: nonExistentFile, outfile: outputFile, format: "esm" })).rejects.toThrow()
	}, 30_000)

	it("should bundle dependencies when bundle option is true", async () => {
		const libFile = path.join(tempDir, "lib.ts")
		const mainFile = path.join(tempDir, "main.ts")
		const outputFile = path.join(tempDir, "output.mjs")

		fs.writeFileSync(libFile, `export const PI = 3.14159`)
		fs.writeFileSync(
			mainFile,
			`
				import { PI } from "./lib.js"
				export const circumference = (r: number) => 2 * PI * r
			`,
		)

		await runEsbuild({ entryPoint: mainFile, outfile: outputFile, format: "esm", bundle: true })

		const outputContent = fs.readFileSync(outputFile, "utf-8")
		expect(outputContent).toContain("3.14159")
	}, 30_000)

	it("should respect platform option", async () => {
		const inputFile = path.join(tempDir, "input.ts")
		const outputFile = path.join(tempDir, "output.mjs")

		fs.writeFileSync(inputFile, `export const value = process.env.NODE_ENV`)

		await runEsbuild({ entryPoint: inputFile, outfile: outputFile, format: "esm", platform: "node" })

		expect(fs.existsSync(outputFile)).toBe(true)
	}, 30_000)

	it("should keep external modules as imports instead of bundling", async () => {
		const inputFile = path.join(tempDir, "input.ts")
		const outputFile = path.join(tempDir, "output.mjs")

		fs.writeFileSync(
			inputFile,
			`
				import fs from "fs"
				export function fileExists(p: string): boolean {
					return fs.existsSync(p)
				}
			`,
		)

		await runEsbuild({
			entryPoint: inputFile,
			outfile: outputFile,
			format: "esm",
			bundle: true,
			external: ["fs"],
		})

		const outputContent = fs.readFileSync(outputFile, "utf-8")
		expect(outputContent).toMatch(/import.*from\s*["']fs["']/)
	}, 30_000)

	it("should add banner code when specified", async () => {
		const inputFile = path.join(tempDir, "input.ts")
		const outputFile = path.join(tempDir, "output.mjs")

		fs.writeFileSync(inputFile, `export const greeting = "Hello"`)

		const customBanner = "// This is a custom banner comment"
		await runEsbuild({
			entryPoint: inputFile,
			outfile: outputFile,
			format: "esm",
			banner: customBanner,
		})

		const outputContent = fs.readFileSync(outputFile, "utf-8")
		expect(outputContent.startsWith(customBanner)).toBe(true)
	}, 30_000)

	it("should add CommonJS require shim banner for ESM bundles", async () => {
		const inputFile = path.join(tempDir, "input.ts")
		const outputFile = path.join(tempDir, "output.mjs")

		fs.writeFileSync(inputFile, `export const value = 42`)

		await runEsbuild({
			entryPoint: inputFile,
			outfile: outputFile,
			format: "esm",
			banner: COMMONJS_REQUIRE_BANNER,
		})

		const outputContent = fs.readFileSync(outputFile, "utf-8")
		expect(outputContent).toContain("createRequire")
		expect(outputContent).toContain("import.meta.url")
	}, 30_000)
})
