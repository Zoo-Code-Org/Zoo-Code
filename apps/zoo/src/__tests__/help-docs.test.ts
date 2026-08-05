import fs from "node:fs"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const packageRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)))
const repositoryRoot = path.resolve(packageRoot, "../..")

describe("CLI documentation", () => {
	it("keeps documented commands discoverable in live help", () => {
		const help = execFileSync(process.execPath, [path.join(packageRoot, "dist/index.js"), "--help"], {
			encoding: "utf8",
		})
		const docs = fs.readFileSync(path.join(repositoryRoot, "docs/zoo-cli.md"), "utf8")

		for (const command of ["run", "resume", "sessions"]) {
			expect(help).toContain(command)
			expect(docs).toContain(`zoo ${command}`)
		}
		expect(docs).toContain("stream-json")
		expect(docs).toContain("--approval safe")
	})
})
