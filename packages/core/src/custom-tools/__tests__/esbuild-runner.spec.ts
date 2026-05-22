import fs from "fs"
import os from "os"
import path from "path"

import { getEsbuildScriptPath, NODE_BUILTIN_MODULES } from "../esbuild-runner.js"

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
