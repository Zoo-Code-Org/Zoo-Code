import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

describe("removed Kilo gateway model loader", () => {
	test("does not import kilo gateway from CLI source", async () => {
		const providerSource = await readFile(new URL("../../src/provider/provider.ts", import.meta.url), "utf8")
		expect(providerSource).not.toContain("@kilocode/kilo-gateway")
	})
})
