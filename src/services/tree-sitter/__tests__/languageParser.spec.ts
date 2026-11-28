// npx vitest services/tree-sitter/__tests__/languageParser.spec.ts

import * as path from "path"
import { mkdtemp, copyFile, rm } from "fs/promises"
import { tmpdir } from "os"
import { loadRequiredLanguageParsers } from "../languageParser"

// Path to the directory containing the WASM files.
const WASM_DIR = path.join(__dirname, "../../../node_modules/tree-sitter-wasms/out")

describe("loadRequiredLanguageParsers", () => {
	it("shares concurrent Python grammar loads", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "zoo-python-grammar-"))
		try {
			await copyFile(
				path.join(WASM_DIR, "tree-sitter-python.wasm"),
				path.join(directory, "tree-sitter-python.wasm"),
			)
			const parsers = await Promise.all([
				loadRequiredLanguageParsers(["first.py"], directory),
				loadRequiredLanguageParsers(["second.py"], directory),
			])
			expect(parsers[0].py.parser.language).toBe(parsers[1].py.parser.language)
			for (const result of parsers) {
				result.py.query.delete()
				result.py.parser.delete()
			}
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})

	it("does not reload or relog a failed grammar for each file", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "zoo-missing-grammar-"))
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			await expect(loadRequiredLanguageParsers(["first.py"], directory)).rejects.toThrow()
			await expect(loadRequiredLanguageParsers(["second.py"], directory)).rejects.toThrow()
			expect(errorLog).toHaveBeenCalledOnce()
		} finally {
			errorLog.mockRestore()
			await rm(directory, { recursive: true, force: true })
		}
	})

	it("should load Python parser for .py files", async () => {
		const files = ["test.py"]
		const parsers = await loadRequiredLanguageParsers(files, WASM_DIR)
		expect(parsers.py).toBeDefined()
	})

	it("should load JavaScript parser for .js and .jsx files", async () => {
		const files = ["test.js", "test.jsx"]
		const parsers = await loadRequiredLanguageParsers(files, WASM_DIR)
		expect(parsers.js).toBeDefined()
		expect(parsers.jsx).toBeDefined()
		expect(parsers.js.query).toBeDefined()
		expect(parsers.jsx.query).toBeDefined()
	})

	it("should load multiple language parsers as needed", async () => {
		const files = ["test.js", "test.py", "test.rs", "test.go"]
		const parsers = await loadRequiredLanguageParsers(files, WASM_DIR)
		expect(parsers.js).toBeDefined()
		expect(parsers.py).toBeDefined()
		expect(parsers.rs).toBeDefined()
		expect(parsers.go).toBeDefined()
	})

	it("should handle C/C++ files correctly", async () => {
		const files = ["test.c", "test.h", "test.cpp", "test.hpp"]
		const parsers = await loadRequiredLanguageParsers(files, WASM_DIR)
		expect(parsers.c).toBeDefined()
		expect(parsers.h).toBeDefined()
		expect(parsers.cpp).toBeDefined()
		expect(parsers.hpp).toBeDefined()
	})

	it("should handle Kotlin files correctly", async () => {
		const files = ["test.kt", "test.kts"]
		const parsers = await loadRequiredLanguageParsers(files, WASM_DIR)
		expect(parsers.kt).toBeDefined()
		expect(parsers.kts).toBeDefined()
		expect(parsers.kt.query).toBeDefined()
		expect(parsers.kts.query).toBeDefined()
	})

	it("should load Dart parser for .dart files", async () => {
		const parsers = await loadRequiredLanguageParsers(["test.dart"], WASM_DIR)
		expect(parsers.dart).toBeDefined()
		expect(parsers.dart.query).toBeDefined()
	})

	it("should throw error for unsupported file extensions", async () => {
		const files = ["test.unsupported"]
		await expect(loadRequiredLanguageParsers(files, WASM_DIR)).rejects.toThrow("Unsupported language: unsupported")
	})
})
