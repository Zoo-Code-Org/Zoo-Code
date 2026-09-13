import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { publishTreeSitterWasms } from "./copy-tree-sitter-wasms.mjs"

describe("publishTreeSitterWasms", () => {
	let root

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "tree-sitter-wasms-"))
	})

	afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

	it("publishes the exact WASM set and removes stale outputs", () => {
		const source = path.join(root, "source")
		const destination = path.join(root, "dist")
		fs.mkdirSync(source)
		fs.mkdirSync(destination)
		fs.writeFileSync(path.join(source, "tree-sitter-a.wasm"), "a")
		fs.writeFileSync(path.join(source, "ignored.txt"), "ignored")
		fs.writeFileSync(path.join(destination, "tree-sitter-stale.wasm"), "stale")
		fs.writeFileSync(path.join(destination, "tree-sitter-a.wasm.999.tmp"), "partial")

		publishTreeSitterWasms(source, destination)

		expect(fs.readdirSync(destination)).toEqual(["tree-sitter-a.wasm"])
		expect(fs.readFileSync(path.join(destination, "tree-sitter-a.wasm"), "utf8")).toBe("a")
	})

	it("restores published outputs when publication fails", () => {
		const source = path.join(root, "source")
		const destination = path.join(root, "dist")
		fs.mkdirSync(source)
		fs.mkdirSync(destination)
		fs.writeFileSync(path.join(source, "tree-sitter-a.wasm"), "a")
		fs.writeFileSync(path.join(source, "tree-sitter-b.wasm"), "b")
		fs.writeFileSync(path.join(destination, "tree-sitter-existing.wasm"), "existing")
		let copies = 0
		const filesystem = {
			...fs,
			copyFileSync(...args) {
				if (++copies === 2) throw new Error("copy failed")
				return fs.copyFileSync(...args)
			},
		}

		expect(() => publishTreeSitterWasms(source, destination, filesystem)).toThrow("copy failed")
		expect(fs.readdirSync(destination)).toEqual(["tree-sitter-existing.wasm"])
		expect(fs.readFileSync(path.join(destination, "tree-sitter-existing.wasm"), "utf8")).toBe("existing")
	})

	it("restores published outputs when an atomic rename fails", () => {
		const source = path.join(root, "source")
		const destination = path.join(root, "dist")
		fs.mkdirSync(source)
		fs.mkdirSync(destination)
		fs.writeFileSync(path.join(source, "tree-sitter-a.wasm"), "a")
		fs.writeFileSync(path.join(source, "tree-sitter-b.wasm"), "b")
		fs.writeFileSync(path.join(destination, "tree-sitter-a.wasm"), "previous-a")
		fs.writeFileSync(path.join(destination, "tree-sitter-b.wasm"), "previous-b")
		let renames = 0
		const filesystem = {
			...fs,
			renameSync(...args) {
				if (++renames === 2) throw new Error("rename failed")
				return fs.renameSync(...args)
			},
		}

		expect(() => publishTreeSitterWasms(source, destination, filesystem)).toThrow("rename failed")
		expect(fs.readdirSync(destination)).toEqual(["tree-sitter-a.wasm", "tree-sitter-b.wasm"])
		expect(fs.readFileSync(path.join(destination, "tree-sitter-a.wasm"), "utf8")).toBe("previous-a")
		expect(fs.readFileSync(path.join(destination, "tree-sitter-b.wasm"), "utf8")).toBe("previous-b")
	})
})
