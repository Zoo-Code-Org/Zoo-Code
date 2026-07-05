import type { ModeConfig } from "@roo-code/types"

import { getModesSection } from "../modes"

vi.mock("../../../../utils/globalContext", () => ({
	ensureSettingsDirectoryExists: vi.fn().mockResolvedValue("/mock/settings/path"),
}))

const outlineMode: ModeConfig = {
	slug: "outline",
	name: "Outline",
	roleDefinition: "You are a structural planner.",
	whenToUse: "Use this to plan structure.",
	groups: ["read"],
	inputs: "The handoff brief must include: (1) which component, (2) the goal.",
}

const draftMode: ModeConfig = {
	slug: "draft",
	name: "Draft",
	roleDefinition: "You are a prose writer.",
	whenToUse: "Use this to write prose.",
	groups: ["read", "edit"],
	inputs: "The handoff brief must include: (1) the beat, (2) the directorial brief.",
}

const collaborateMode: ModeConfig = {
	slug: "collaborate",
	name: "Collaborate",
	roleDefinition: "You are a collaborator.",
	whenToUse: "Use this to collaborate.",
	groups: ["read", "edit"],
}

const noInputsMode: ModeConfig = {
	slug: "revise",
	name: "Revise",
	roleDefinition: "You are an editor.",
	whenToUse: "Use this to revise.",
	groups: ["read", "edit"],
}

vi.mock("../../../../shared/modes", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../../shared/modes")>()
	return {
		...actual,
		getAllModesWithPrompts: vi.fn(),
	}
})

import { getAllModesWithPrompts } from "../../../../shared/modes"

describe("getModesSection", () => {
	const mockContext = {} as any

	it("lists all modes without handoff specs when the active mode is not collaborate", async () => {
		vi.mocked(getAllModesWithPrompts).mockResolvedValue([outlineMode, draftMode, collaborateMode])

		const result = await getModesSection(mockContext, "outline")

		expect(result).toContain('"Outline" mode (outline)')
		expect(result).toContain('"Draft" mode (draft)')
		expect(result).not.toContain("Sub-agent handoff briefs")
	})

	it("omits handoff specs when mode is unspecified", async () => {
		vi.mocked(getAllModesWithPrompts).mockResolvedValue([outlineMode, draftMode, collaborateMode])

		const result = await getModesSection(mockContext)

		expect(result).not.toContain("Sub-agent handoff briefs")
	})

	it("appends sub-agent handoff specs when the active mode is collaborate", async () => {
		vi.mocked(getAllModesWithPrompts).mockResolvedValue([outlineMode, draftMode, collaborateMode])

		const result = await getModesSection(mockContext, "collaborate")

		expect(result).toContain("Sub-agent handoff briefs")
		expect(result).toContain('"Outline" (outline)')
		expect(result).toContain("which component")
		expect(result).toContain('"Draft" (draft)')
		expect(result).toContain("the beat")
	})

	it("excludes collaborate itself and modes without an inputs spec from the handoff section", async () => {
		vi.mocked(getAllModesWithPrompts).mockResolvedValue([outlineMode, collaborateMode, noInputsMode])

		const result = await getModesSection(mockContext, "collaborate")

		expect(result).toContain('"Outline" (outline)')
		expect(result).not.toContain('"Collaborate" (collaborate)')
		expect(result).not.toContain('"Revise" (revise)')
	})

	it("omits the handoff section entirely when no mode has an inputs spec", async () => {
		vi.mocked(getAllModesWithPrompts).mockResolvedValue([collaborateMode, noInputsMode])

		const result = await getModesSection(mockContext, "collaborate")

		expect(result).not.toContain("Sub-agent handoff briefs")
	})
})
