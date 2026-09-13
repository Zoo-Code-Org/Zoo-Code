import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { assertMatchingFiles } from "./verify-wasm-files.mjs"

describe("assertMatchingFiles", () => {
	let root

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-wasm-files-"))
	})

	afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

	it("rejects a restored WASM with corrupted content", () => {
		const expected = path.join(root, "expected")
		const actual = path.join(root, "actual")
		fs.mkdirSync(expected)
		fs.mkdirSync(actual)
		fs.writeFileSync(path.join(expected, "tree-sitter-a.wasm"), "expected")
		fs.writeFileSync(path.join(actual, "tree-sitter-a.wasm"), "corrupted")

		expect(() => assertMatchingFiles(expected, actual, ["tree-sitter-a.wasm"], "WASM mismatch")).toThrow(
			"WASM mismatch: tree-sitter-a.wasm",
		)
	})
})
