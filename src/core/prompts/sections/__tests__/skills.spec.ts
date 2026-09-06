import { getSkillsSection } from "../skills"
import type { EffectiveToolPolicy } from "../../tools/effective-tool-policy"

/** Build a policy advertising `tools` as logically available. */
function policyFor(tools: string[]): EffectiveToolPolicy {
	return {
		tools: new Set(tools),
		hasMcpGroup: false,
		hasMcpTools: false,
		hasMcpResources: false,
	}
}

describe("getSkillsSection", () => {
	it("should emit <available_skills> XML with name, description, and location", async () => {
		const mockSkillsManager = {
			getSkillsForMode: vi.fn().mockReturnValue([
				{
					name: "pdf-processing",
					description: "Extracts text & tables from PDFs",
					path: "/abs/path/pdf-processing/SKILL.md",
					source: "global" as const,
				},
			]),
		}

		const result = await getSkillsSection(mockSkillsManager, "code", policyFor(["skill"]))

		expect(result).toContain("<available_skills>")
		expect(result).toContain("</available_skills>")
		expect(result).toContain("<skill>")
		expect(result).toContain("<name>pdf-processing</name>")
		// Ensure XML escaping for '&'
		expect(result).toContain("<description>Extracts text &amp; tables from PDFs</description>")
		// For filesystem-based agents, location should be the absolute path to SKILL.md
		expect(result).toContain("<location>/abs/path/pdf-processing/SKILL.md</location>")
	})

	it("should return empty string when skillsManager or currentMode is missing", async () => {
		await expect(getSkillsSection(undefined, "code", policyFor(["skill"]))).resolves.toBe("")
		await expect(getSkillsSection({ getSkillsForMode: vi.fn() }, undefined, policyFor(["skill"]))).resolves.toBe("")
	})

	it("should return empty string when the policy is missing", async () => {
		const mockSkillsManager = { getSkillsForMode: vi.fn() }

		// The `policy?.` optional chain is the only guard against an undefined
		// policy; removing it would make this call throw.
		await expect(getSkillsSection(mockSkillsManager, "code", undefined)).resolves.toBe("")
		expect(mockSkillsManager.getSkillsForMode).not.toHaveBeenCalled()
	})

	it("should return empty string when the skill tool is disabled", async () => {
		const mockSkillsManager = {
			getSkillsForMode: vi.fn().mockReturnValue([
				{
					name: "pdf-processing",
					description: "Extracts text & tables from PDFs",
					path: "/abs/path/pdf-processing/SKILL.md",
					source: "global" as const,
				},
			]),
		}

		await expect(getSkillsSection(mockSkillsManager, "code", policyFor([]))).resolves.toBe("")
	})
})
