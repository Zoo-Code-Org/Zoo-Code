import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

describe("CLI package", () => {
	it("publishes only the zoo executable", () => {
		const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../package.json")
		const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { bin?: Record<string, string> }

		expect(packageJson.bin).toEqual({ zoo: "dist/index.js" })
		expect(packageJson.bin).not.toHaveProperty("roo")
	})
})
