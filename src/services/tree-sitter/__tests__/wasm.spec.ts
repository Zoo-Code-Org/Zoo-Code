import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { Parser } from "web-tree-sitter"

import { loadTestGrammar } from "./wasm"

const requiredGrammars = [
	"c",
	"cpp",
	"c_sharp",
	"css",
	"dart",
	"elisp",
	"elixir",
	"embedded_template",
	"go",
	"html",
	"java",
	"javascript",
	"json",
	"kotlin",
	"lua",
	"ocaml",
	"php",
	"python",
	"ruby",
	"rust",
	"scala",
	"solidity",
	"swift",
	"systemrdl",
	"tlaplus",
	"toml",
	"tsx",
	"typescript",
	"vue",
	"zig",
]

describe("dependency-owned Tree-sitter grammars", () => {
	const temporaryDirectories: string[] = []

	beforeAll(() => Parser.init())
	afterEach(() => temporaryDirectories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true })))

	it.each(requiredGrammars)("loads tree-sitter-%s.wasm", async (grammar) => {
		await expect(loadTestGrammar(`tree-sitter-${grammar}.wasm`)).resolves.toBeDefined()
	})

	it("reports a missing dependency artifact with its filename and resolved path", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tree-sitter-wasm-missing-"))
		temporaryDirectories.push(directory)

		await expect(loadTestGrammar("tree-sitter-missing.wasm", directory)).rejects.toThrow(
			`Failed to load Tree-sitter grammar tree-sitter-missing.wasm from ${path.join(directory, "tree-sitter-missing.wasm")}`,
		)
	})

	it("reports a malformed dependency artifact with its filename and resolved path", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tree-sitter-wasm-malformed-"))
		temporaryDirectories.push(directory)
		fs.writeFileSync(path.join(directory, "tree-sitter-malformed.wasm"), "not wasm")

		await expect(loadTestGrammar("tree-sitter-malformed.wasm", directory)).rejects.toThrow(
			`Failed to load Tree-sitter grammar tree-sitter-malformed.wasm from ${path.join(directory, "tree-sitter-malformed.wasm")}`,
		)
	})
})
