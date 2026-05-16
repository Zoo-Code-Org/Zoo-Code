import * as fs from "fs"
import * as path from "path"

describe("package jsonValidation", () => {
	it("ships a local Zoo config schema for zoo.jsonc", () => {
		const packageJsonPath = path.join(__dirname, "../package.json")
		const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
			contributes?: {
				jsonValidation?: Array<{ fileMatch?: string[]; url?: string }>
			}
		}
		const validation = packageJson.contributes?.jsonValidation?.find((item) =>
			item.fileMatch?.includes("zoo.jsonc"),
		)

		expect(validation?.url).toBe("./schemas/zoo-config.schema.json")
		expect(validation?.url?.startsWith("http")).toBe(false)
		expect(fs.existsSync(path.join(__dirname, "..", validation!.url!))).toBe(true)
	})

	it("includes schemas in the VSIX package", () => {
		const ignore = fs.readFileSync(path.join(__dirname, "../.vscodeignore"), "utf8")

		expect(ignore).toContain("!schemas/**")
	})
})
