import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { publishTreeSitterWasms } from "./copy-tree-sitter-wasms.mjs"

describe("publishTreeSitterWasms", () => {
	let root
	let source
	let destination

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "tree-sitter-wasms-"))
		source = path.join(root, "source")
		destination = path.join(root, "dist")
		fs.mkdirSync(source)
		fs.mkdirSync(destination)
		fs.writeFileSync(path.join(source, "tree-sitter-a.wasm"), "a")
	})

	afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

	it("publishes the exact staged set and removes stale state", async () => {
		fs.writeFileSync(path.join(source, "ignored.txt"), "ignored")
		fs.writeFileSync(path.join(destination, "tree-sitter-stale.wasm"), "stale")
		fs.mkdirSync(`${destination}.tree-sitter-wasms-staging`)
		fs.writeFileSync(path.join(`${destination}.tree-sitter-wasms-staging`, "stale.tmp"), "stale")

		await publishTreeSitterWasms(source, destination)

		expect(fs.readdirSync(destination)).toEqual(["tree-sitter-a.wasm"])
		expect(fs.readFileSync(path.join(destination, "tree-sitter-a.wasm"), "utf8")).toBe("a")
		expect(fs.existsSync(`${destination}.tree-sitter-wasms-staging`)).toBe(false)
	})

	it("fails without publishing when staging fails", async () => {
		const filesystem = {
			...fs.promises,
			copyFile: async () => {
				throw new Error("copy failed")
			},
		}
		await expect(publishTreeSitterWasms(source, destination, { filesystem })).rejects.toThrow("copy failed")
		expect(fs.readdirSync(destination)).toEqual([])
	})

	it("removes partial outputs and fails when publication is interrupted", async () => {
		fs.writeFileSync(path.join(source, "tree-sitter-b.wasm"), "b")
		const signalState = { requested: undefined }
		await expect(
			publishTreeSitterWasms(source, destination, {
				signalState,
				onStep(name) {
					if (name === "published") signalState.requested = "SIGTERM"
				},
			}),
		).rejects.toThrow("WASM publication cancelled")
		expect(fs.readdirSync(destination)).toEqual([])
	})

	it("reports publication and cleanup errors together", async () => {
		let destinationReads = 0
		const filesystem = {
			...fs.promises,
			readdir(directory) {
				if (directory === destination && ++destinationReads === 2) throw new Error("cleanup enumeration failed")
				return fs.promises.readdir(directory)
			},
		}

		await expect(
			publishTreeSitterWasms(source, destination, {
				filesystem,
				onStep(name) {
					if (name === "published") throw new Error("publication failed")
				},
			}),
		).rejects.toMatchObject({
			message: expect.stringContaining("WASM publication and cleanup failed"),
			errors: [
				expect.objectContaining({ message: "publication failed" }),
				expect.objectContaining({ message: "cleanup enumeration failed" }),
			],
		})
	})
})
