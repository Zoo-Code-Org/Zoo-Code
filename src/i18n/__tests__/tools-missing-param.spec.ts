import fs from "fs"
import path from "path"

const localesDir = path.join(__dirname, "..", "locales")

const languages = fs
	.readdirSync(localesDir, { withFileTypes: true })
	.filter((dirent) => dirent.isDirectory() && !dirent.name.startsWith("."))
	.map((dirent) => dirent.name)

function loadTools(language: string): Record<string, string> {
	return JSON.parse(fs.readFileSync(path.join(localesDir, language, "tools.json"), "utf8"))
}

describe("tools:missingToolParameter locales", () => {
	it("covers every shipped locale", () => {
		expect(languages.length).toBeGreaterThan(0)
		for (const language of languages) {
			const tools = loadTools(language)
			expect(tools.missingToolParameter, `missingToolParameter missing in ${language}`).toBeTruthy()
			expect(
				tools.missingToolParameterWithPath,
				`missingToolParameterWithPath missing in ${language}`,
			).toBeTruthy()
		}
	})

	it("keeps all interpolation placeholders in every locale", () => {
		for (const language of languages) {
			const tools = loadTools(language)
			expect(tools.missingToolParameter, `placeholders missing in ${language}`).toContain("{{toolName}}")
			expect(tools.missingToolParameter, `placeholders missing in ${language}`).toContain("{{paramName}}")
			expect(tools.missingToolParameterWithPath, `placeholders missing in ${language}`).toContain("{{toolName}}")
			expect(tools.missingToolParameterWithPath, `placeholders missing in ${language}`).toContain("{{relPath}}")
			expect(tools.missingToolParameterWithPath, `placeholders missing in ${language}`).toContain("{{paramName}}")
		}
	})

	it("brands the English messages as Zoo, not Roo", () => {
		const tools = loadTools("en")
		expect(tools.missingToolParameter).toContain("Zoo")
		expect(tools.missingToolParameter).not.toContain("Roo")
		expect(tools.missingToolParameterWithPath).toContain("Zoo")
		expect(tools.missingToolParameterWithPath).not.toContain("Roo")
	})
})
