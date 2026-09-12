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

	it("removes published and temporary outputs when publication fails", () => {
		const source = path.join(root, "source")
		const destination = path.join(root, "dist")
		fs.mkdirSync(source)
		fs.writeFileSync(path.join(source, "tree-sitter-a.wasm"), "a")
		fs.writeFileSync(path.join(source, "tree-sitter-b.wasm"), "b")
		let copies = 0
		const filesystem = {
			...fs,
			copyFileSync(...args) {
				if (++copies === 2) throw new Error("copy failed")
				return fs.copyFileSync(...args)
			},
		}

		expect(() => publishTreeSitterWasms(source, destination, filesystem)).toThrow("copy failed")
		expect(fs.readdirSync(destination)).toEqual([])
	})

	it("removes published and temporary outputs when an atomic rename fails", () => {
		const source = path.join(root, "source")
		const destination = path.join(root, "dist")
		fs.mkdirSync(source)
		fs.writeFileSync(path.join(source, "tree-sitter-a.wasm"), "a")
		const filesystem = {
			...fs,
			renameSync() {
				throw new Error("rename failed")
			},
		}

		expect(() => publishTreeSitterWasms(source, destination, filesystem)).toThrow("rename failed")
		expect(fs.readdirSync(destination)).toEqual([])
	})
})
