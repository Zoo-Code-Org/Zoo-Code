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

	it("publishes the exact WASM set and removes stale outputs", async () => {
		const source = path.join(root, "source")
		const destination = path.join(root, "dist")
		fs.mkdirSync(source)
		fs.mkdirSync(destination)
		fs.writeFileSync(path.join(source, "tree-sitter-a.wasm"), "a")
		fs.writeFileSync(path.join(source, "ignored.txt"), "ignored")
		fs.writeFileSync(path.join(destination, "tree-sitter-stale.wasm"), "stale")
		fs.writeFileSync(path.join(destination, "tree-sitter-a.wasm.999.tmp"), "partial")

		await publishTreeSitterWasms(source, destination)

		expect(fs.readdirSync(destination)).toEqual(["tree-sitter-a.wasm"])
		expect(fs.readFileSync(path.join(destination, "tree-sitter-a.wasm"), "utf8")).toBe("a")
	})

	it("restores published outputs when publication fails", async () => {
		const source = path.join(root, "source")
		const destination = path.join(root, "dist")
		fs.mkdirSync(source)
		fs.mkdirSync(destination)
		fs.writeFileSync(path.join(source, "tree-sitter-a.wasm"), "a")
		fs.writeFileSync(path.join(source, "tree-sitter-b.wasm"), "b")
		fs.writeFileSync(path.join(destination, "tree-sitter-existing.wasm"), "existing")
		let copies = 0
		const filesystem = {
			...fs.promises,
			copyFile(...args) {
				if (++copies === 2) throw new Error("copy failed")
				return fs.promises.copyFile(...args)
			},
		}

		await expect(publishTreeSitterWasms(source, destination, { filesystem })).rejects.toThrow("copy failed")
		expect(fs.readdirSync(destination)).toEqual(["tree-sitter-existing.wasm"])
		expect(fs.readFileSync(path.join(destination, "tree-sitter-existing.wasm"), "utf8")).toBe("existing")
	})

	it("restores published outputs when an atomic rename fails", async () => {
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
			...fs.promises,
			rename(...args) {
				if (args[0].includes(`${path.sep}staged${path.sep}`) && ++renames === 2)
					throw new Error("rename failed")
				return fs.promises.rename(...args)
			},
		}

		await expect(publishTreeSitterWasms(source, destination, { filesystem })).rejects.toThrow("rename failed")
		expect(fs.readdirSync(destination)).toEqual(["tree-sitter-a.wasm", "tree-sitter-b.wasm"])
		expect(fs.readFileSync(path.join(destination, "tree-sitter-a.wasm"), "utf8")).toBe("previous-a")
		expect(fs.readFileSync(path.join(destination, "tree-sitter-b.wasm"), "utf8")).toBe("previous-b")
	})

	it("restores published outputs when signalled during commit", async () => {
		const source = path.join(root, "source")
		const destination = path.join(root, "dist")
		fs.mkdirSync(source)
		fs.mkdirSync(destination)
		fs.writeFileSync(path.join(source, "tree-sitter-a.wasm"), "new-a")
		fs.writeFileSync(path.join(destination, "tree-sitter-a.wasm"), "previous-a")
		const signalState = { requested: undefined }

		await expect(
			publishTreeSitterWasms(source, destination, {
				signalState,
				onStep(name) {
					if (name === "published") signalState.requested = "SIGTERM"
					if (name === "restored") signalState.requested ??= "SIGINT"
				},
			}),
		).rejects.toThrow("WASM publication cancelled")
		expect(signalState.requested).toBe("SIGTERM")
		expect(fs.readFileSync(path.join(destination, "tree-sitter-a.wasm"), "utf8")).toBe("previous-a")
		expect(fs.existsSync(`${destination}.tree-sitter-wasms-transaction`)).toBe(false)
	})

	it("retains the backup when restoration fails", async () => {
		const source = path.join(root, "source")
		const destination = path.join(root, "dist")
		const transaction = `${destination}.tree-sitter-wasms-transaction`
		fs.mkdirSync(source)
		fs.mkdirSync(destination)
		fs.writeFileSync(path.join(source, "tree-sitter-a.wasm"), "new-a")
		fs.writeFileSync(path.join(destination, "tree-sitter-a.wasm"), "previous-a")
		const signalState = { requested: undefined }
		const filesystem = {
			...fs.promises,
			rename(sourcePath, destinationPath) {
				if (sourcePath.includes(`${path.sep}backup${path.sep}`)) throw new Error("restore failed")
				return fs.promises.rename(sourcePath, destinationPath)
			},
		}

		await expect(
			publishTreeSitterWasms(source, destination, {
				filesystem,
				signalState,
				onStep(name) {
					if (name === "published") signalState.requested = "SIGTERM"
				},
			}),
		).rejects.toThrow(`WASM rollback incomplete; recovery retained at ${transaction}`)
		expect(fs.readFileSync(path.join(transaction, "backup", "tree-sitter-a.wasm"), "utf8")).toBe("previous-a")
		await expect(publishTreeSitterWasms(source, destination)).rejects.toMatchObject({ code: "EEXIST" })
	})
})
