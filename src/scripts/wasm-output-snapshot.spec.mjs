import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createWasmOutputSnapshot } from "./wasm-output-snapshot.mjs"

describe("createWasmOutputSnapshot", () => {
	let root
	let destination

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "wasm-output-snapshot-"))
		destination = path.join(root, "dist")
		fs.mkdirSync(destination)
		fs.writeFileSync(path.join(destination, "tree-sitter-a.wasm"), "previous")
	})

	afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

	it.each(["preparation", "dry run", "cache restoration", "signal"])(
		"restores prior outputs after %s failure",
		() => {
			const snapshot = createWasmOutputSnapshot(destination)
			fs.writeFileSync(path.join(destination, "tree-sitter-a.wasm"), "generated")
			fs.writeFileSync(path.join(destination, "tree-sitter-partial.wasm.123.tmp"), "partial")

			snapshot.restore()

			expect(fs.readdirSync(destination)).toEqual(["tree-sitter-a.wasm"])
			expect(fs.readFileSync(path.join(destination, "tree-sitter-a.wasm"), "utf8")).toBe("previous")
			expect(fs.existsSync(`${destination}.coverage-contract-backup`)).toBe(false)
		},
	)

	it("retains the backup when restoration is interrupted", () => {
		const transaction = `${destination}.coverage-contract-backup`
		const filesystem = {
			...fs,
			renameSync(source, target) {
				if (source.includes(`${path.sep}backup${path.sep}`)) throw new Error("restore interrupted")
				return fs.renameSync(source, target)
			},
		}
		const snapshot = createWasmOutputSnapshot(destination, filesystem)
		fs.writeFileSync(path.join(destination, "tree-sitter-a.wasm"), "generated")

		expect(() => snapshot.restore()).toThrow("restore interrupted")
		expect(fs.readFileSync(path.join(transaction, "backup", "tree-sitter-a.wasm"), "utf8")).toBe("previous")
	})

	it("restores files when snapshot creation fails during a later move", () => {
		fs.writeFileSync(path.join(destination, "tree-sitter-b.wasm"), "previous-b")
		let moves = 0
		const filesystem = {
			...fs,
			renameSync(source, target) {
				if (source.startsWith(destination) && ++moves === 2) throw new Error("snapshot failed")
				return fs.renameSync(source, target)
			},
		}

		expect(() => createWasmOutputSnapshot(destination, filesystem)).toThrow("snapshot failed")
		expect(fs.readdirSync(destination)).toEqual(["tree-sitter-a.wasm", "tree-sitter-b.wasm"])
		expect(fs.readFileSync(path.join(destination, "tree-sitter-a.wasm"), "utf8")).toBe("previous")
		expect(fs.readFileSync(path.join(destination, "tree-sitter-b.wasm"), "utf8")).toBe("previous-b")
		expect(fs.existsSync(`${destination}.coverage-contract-backup`)).toBe(false)
	})

	it("retries a partial restoration without deleting an already restored original", () => {
		fs.writeFileSync(path.join(destination, "tree-sitter-b.wasm"), "previous-b")
		let restoreMoves = 0
		let failRestore = true
		const filesystem = {
			...fs,
			renameSync(source, target) {
				if (source.includes(`${path.sep}backup${path.sep}`) && ++restoreMoves === 2 && failRestore) {
					failRestore = false
					throw new Error("restore interrupted")
				}
				return fs.renameSync(source, target)
			},
		}
		const snapshot = createWasmOutputSnapshot(destination, filesystem)
		fs.writeFileSync(path.join(destination, "tree-sitter-a.wasm"), "generated")

		expect(() => snapshot.restore()).toThrow("restore interrupted")
		expect(() => snapshot.restore()).not.toThrow()
		expect(fs.readdirSync(destination)).toEqual(["tree-sitter-a.wasm", "tree-sitter-b.wasm"])
		expect(fs.readFileSync(path.join(destination, "tree-sitter-a.wasm"), "utf8")).toBe("previous")
		expect(fs.readFileSync(path.join(destination, "tree-sitter-b.wasm"), "utf8")).toBe("previous-b")
		expect(fs.existsSync(`${destination}.coverage-contract-backup`)).toBe(false)
	})
})
