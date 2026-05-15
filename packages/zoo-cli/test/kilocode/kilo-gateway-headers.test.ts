import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

describe("removed Kilo gateway dependency", () => {
	test("does not declare kilo gateway in the CLI package manifest", async () => {
		const manifest = await readFile(new URL("../../package.json", import.meta.url), "utf8")
		expect(manifest).not.toContain("@kilocode/kilo-gateway")
	})
})
