import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { prepareTreeSitterWasms } from "./copy-tree-sitter-wasms.mjs"

describe("prepareTreeSitterWasms", () => {
	let root
	let source
	let destination

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "tree-sitter-wasms-"))
		source = path.join(root, "source")
		destination = path.join(root, "generated", "tree-sitter-wasms")
		fs.mkdirSync(source)
		fs.writeFileSync(path.join(source, "tree-sitter-a.wasm"), "a")
	})

	afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

	it("replaces pre-existing generated output without filesystem rename", async () => {
		fs.writeFileSync(path.join(source, "ignored.txt"), "ignored")
		fs.mkdirSync(destination, { recursive: true })
		fs.writeFileSync(path.join(destination, "tree-sitter-stale.wasm"), "stale")
		const filesystem = {
			...fs.promises,
			rename: async () => {
				throw new Error("rename must not be used")
			},
		}

		await prepareTreeSitterWasms(source, destination, { filesystem })

		expect(fs.readdirSync(destination)).toEqual(["tree-sitter-a.wasm"])
		expect(fs.readFileSync(path.join(destination, "tree-sitter-a.wasm"), "utf8")).toBe("a")
	})

	it("removes partial task output after a copy failure and rebuilds cleanly", async () => {
		fs.writeFileSync(path.join(source, "tree-sitter-b.wasm"), "b")
		let copies = 0
		const filesystem = {
			...fs.promises,
			copyFile: async (...args) => {
				if (++copies === 2) throw new Error("copy failed")
				return fs.promises.copyFile(...args)
			},
		}

		await expect(prepareTreeSitterWasms(source, destination, { filesystem })).rejects.toThrow("copy failed")
		expect(fs.existsSync(destination)).toBe(false)

		await prepareTreeSitterWasms(source, destination)
		expect(fs.readdirSync(destination)).toEqual(["tree-sitter-a.wasm", "tree-sitter-b.wasm"])
	})
})
