import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { createDistSandbox } from "./dist-sandbox.mjs"

describe("createDistSandbox", () => {
	const roots = []
	afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })))

	it.each(["preparation", "dry run", "cache restoration", "signal"])(
		"restores developer dist after %s failure",
		() => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "dist-sandbox-"))
			roots.push(root)
			const dist = path.join(root, "dist")
			fs.mkdirSync(dist)
			fs.writeFileSync(path.join(dist, "developer.txt"), "keep")
			const sandbox = createDistSandbox(dist)
			fs.writeFileSync(path.join(dist, "generated.txt"), "discard")
			sandbox.restore()
			expect(fs.readdirSync(dist)).toEqual(["developer.txt"])
			expect(fs.readFileSync(path.join(dist, "developer.txt"), "utf8")).toBe("keep")
		},
	)

	it("recovers a stale interrupted sandbox before the next run", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "dist-sandbox-"))
		roots.push(root)
		const dist = path.join(root, "dist")
		fs.mkdirSync(dist)
		fs.writeFileSync(path.join(dist, "generated.txt"), "discard")
		fs.mkdirSync(`${dist}.coverage-contract-backup`)
		fs.writeFileSync(path.join(`${dist}.coverage-contract-backup`, "developer.txt"), "keep")
		const sandbox = createDistSandbox(dist)
		sandbox.restore()
		expect(fs.readdirSync(dist)).toEqual(["developer.txt"])
	})
})
