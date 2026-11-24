import fs from "fs"
import os from "os"
import path from "path"
import { execa } from "execa"

import { getEsbuildScriptPath, NODE_BUILTIN_MODULES, runEsbuild, EsbuildSourceError } from "../esbuild-runner.js"

vi.mock("execa", () => ({ execa: vi.fn() }))

describe("getEsbuildScriptPath", () => {
	it("should find esbuild-wasm script in node_modules in development", () => {
		const scriptPath = getEsbuildScriptPath()

		expect(typeof scriptPath).toBe("string")
		expect(scriptPath.length).toBeGreaterThan(0)
		expect(fs.existsSync(scriptPath)).toBe(true)
		expect(scriptPath).toMatch(/esbuild$/)
	})

	it("should prefer production path when extensionPath is provided and script exists", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "esbuild-runner-test-"))
		const binDir = path.join(tempDir, "dist", "bin")
		fs.mkdirSync(binDir, { recursive: true })

		const fakeScriptPath = path.join(binDir, "esbuild")
		fs.writeFileSync(fakeScriptPath, "#!/usr/bin/env node\nconsole.log('fake esbuild')")

		try {
			const result = getEsbuildScriptPath(tempDir)
			expect(result).toBe(fakeScriptPath)
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true })
		}
	})

	it("should fall back to node_modules when production script does not exist", () => {
		const result = getEsbuildScriptPath("/nonexistent/extension/path")

		expect(typeof result).toBe("string")
		expect(result.length).toBeGreaterThan(0)
		expect(fs.existsSync(result)).toBe(true)
	})
})

describe("NODE_BUILTIN_MODULES", () => {
	it("should include common Node.js built-in modules", () => {
		expect(NODE_BUILTIN_MODULES).toContain("fs")
		expect(NODE_BUILTIN_MODULES).toContain("path")
		expect(NODE_BUILTIN_MODULES).toContain("crypto")
		expect(NODE_BUILTIN_MODULES).toContain("http")
		expect(NODE_BUILTIN_MODULES).toContain("https")
		expect(NODE_BUILTIN_MODULES).toContain("os")
		expect(NODE_BUILTIN_MODULES).toContain("child_process")
		expect(NODE_BUILTIN_MODULES).toContain("stream")
		expect(NODE_BUILTIN_MODULES).toContain("util")
		expect(NODE_BUILTIN_MODULES).toContain("events")
	})

	it("should be an array of strings", () => {
		expect(Array.isArray(NODE_BUILTIN_MODULES)).toBe(true)
		expect(NODE_BUILTIN_MODULES.every((moduleName) => typeof moduleName === "string")).toBe(true)
	})
})

describe("runEsbuild error classification", () => {
	const entryPoint = path.resolve("tools", "broken.ts")
	const location = `\n    ${entryPoint}:1:16:`
	afterEach(() => vi.clearAllMocks())

	it.each([
		{ name: "unexpected token", stderr: `[ERROR] Unexpected end of file${location}`, exitCode: 1, permanent: true },
		{ name: "expected token", stderr: `[ERROR] Expected identifier${location}`, exitCode: 1, permanent: true },
		{
			name: "unterminated string",
			stderr: `[ERROR] Unterminated string literal${location}`,
			exitCode: 1,
			permanent: true,
		},
		{ name: "syntax error", stderr: `[ERROR] Syntax error${location}`, exitCode: 1, permanent: true },
		{
			name: "relative source",
			stderr: `[ERROR] Unexpected token\n    ${path.relative(process.cwd(), entryPoint)}:1:0:`,
			exitCode: 1,
			permanent: true,
		},
		{
			name: "dependency syntax",
			stderr: `[ERROR] Unexpected token\n    ${path.resolve("dependency.ts")}:1:0:`,
			exitCode: 1,
			permanent: false,
		},
		{
			name: "output write",
			stderr: "[ERROR] Failed to write to output file: permission denied",
			exitCode: 1,
			permanent: false,
		},
		{
			name: "dependency resolution",
			stderr: `[ERROR] Could not resolve missing-package${location}`,
			exitCode: 1,
			permanent: false,
		},
		{
			name: "output with source note",
			stderr: `[ERROR] Failed to write output${location}`,
			exitCode: 1,
			permanent: false,
		},
		{ name: "non-compiler exit", stderr: `[ERROR] Unexpected token${location}`, exitCode: 2, permanent: false },
		{
			name: "dependency with entry note",
			stderr: `[ERROR] Unexpected token\n    ${path.resolve("dependency.ts")}:1:0:\nNote: imported here${location}`,
			exitCode: 1,
			permanent: false,
		},
		{ name: "process failure", stderr: "Could not start compiler", exitCode: undefined, permanent: false },
	])("classifies $name", async ({ stderr, exitCode, permanent }) => {
		vi.mocked(execa).mockRejectedValueOnce(Object.assign(new Error(stderr), { stderr, exitCode }))
		const build = runEsbuild({ entryPoint, outfile: path.resolve("cache", "bundle.tmp.mjs") })
		if (permanent) await expect(build).rejects.toBeInstanceOf(EsbuildSourceError)
		else {
			await expect(build).rejects.toBeInstanceOf(Error)
			await expect(build).rejects.not.toBeInstanceOf(EsbuildSourceError)
		}
		expect(execa).toHaveBeenCalledTimes(1)
		expect(vi.mocked(execa).mock.calls[0]?.[1]).toContain("--color=false")
	})
})
