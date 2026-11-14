import fs from "fs"
import path from "path"

const localesDir = path.join(__dirname, "..", "locales")

const languages = fs
	.readdirSync(localesDir, { withFileTypes: true })
	.filter((dirent) => dirent.isDirectory() && !dirent.name.startsWith("."))
	.map((dirent) => dirent.name)

function loadSkillErrors(language: string): Record<string, string> {
	return JSON.parse(fs.readFileSync(path.join(localesDir, language, "skills.json"), "utf8")).errors
}

describe("skills:errors.outside_skills_root locales", () => {
	it("covers every shipped locale", () => {
		expect(languages.length).toBeGreaterThan(0)
		for (const language of languages) {
			expect(
				loadSkillErrors(language).outside_skills_root,
				`outside_skills_root missing in ${language}`,
			).toBeTruthy()
		}
	})

	it("keeps the source and path placeholders in every locale", () => {
		for (const language of languages) {
			const message = loadSkillErrors(language).outside_skills_root
			expect(message, `{{source}} placeholder missing in ${language}`).toContain("{{source}}")
			expect(message, `{{path}} placeholder missing in ${language}`).toContain("{{path}}")
		}
	})
})
