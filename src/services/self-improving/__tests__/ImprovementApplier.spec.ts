import { ImprovementApplier } from "../ImprovementApplier"
import type { LearnedPattern } from "../types"

function createToolPattern(): LearnedPattern {
	return {
		id: "pattern-tool",
		patternType: "tool",
		state: "active",
		summary: "Effective tool combination: read_file,search_files",
		confidenceScore: 0.82,
		frequency: 4,
		successRate: 0.9,
		firstSeenAt: 1,
		lastSeenAt: 2,
		sourceSignals: ["TASK_SUCCESS"],
		context: {
			toolNames: ["read_file", "search_files"],
			modes: ["code"],
		},
	}
}

describe("ImprovementApplier", () => {
	it("creates agent skill actions for repeated tool workflows", () => {
		const applier = new ImprovementApplier({
			getSkillNames: () => [],
			getSkillProvenance: () => "unknown",
			isAutoSkillsEnabled: () => true,
		})

		const actions = applier.generateActions([createToolPattern()])
		const skillAction = actions.find((action) => action.actionType === "SKILL_CREATE")

		expect(skillAction).toBeDefined()
		expect(skillAction?.payload.skillName).toBe("workflow-read-file-search-files")
		expect(skillAction?.payload.source).toBe("project")
		expect(skillAction?.payload.description).toContain("read_file")
		expect(skillAction?.payload.content).toContain("name: workflow-read-file-search-files")
		expect(skillAction?.payload.content).toContain("`read_file`")
	})

	it("updates existing agent-created workflow skills instead of recreating them", () => {
		const applier = new ImprovementApplier({
			getSkillNames: () => ["workflow-read-file-search-files"],
			getSkillProvenance: () => "agent",
			isAutoSkillsEnabled: () => true,
		})

		const actions = applier.generateActions([createToolPattern()])

		expect(actions.some((action) => action.actionType === "SKILL_UPDATE")).toBe(true)
		expect(actions.some((action) => action.actionType === "SKILL_CREATE")).toBe(false)
	})

	it("does not emit skill mutation actions when auto-skills are disabled", () => {
		const applier = new ImprovementApplier({
			getSkillNames: () => [],
			getSkillProvenance: () => "unknown",
			isAutoSkillsEnabled: () => false,
		})

		const actions = applier.generateActions([createToolPattern()])

		expect(actions.some((action) => action.actionType === "SKILL_CREATE")).toBe(false)
		expect(actions.some((action) => action.actionType === "SKILL_UPDATE")).toBe(false)
	})

	it("creates global skills when auto-skills scope is global", () => {
		const applier = new ImprovementApplier({
			getSkillNames: () => [],
			getSkillProvenance: () => "unknown",
			isAutoSkillsEnabled: () => true,
			getAutoSkillsScope: () => "global",
		})

		const actions = applier.generateActions([createToolPattern()])
		const skillAction = actions.find((action) => action.actionType === "SKILL_CREATE")

		expect(skillAction?.payload.source).toBe("global")
		expect(skillAction?.payload.skillId).toBe("skill:global:workflow-read-file-search-files")
	})

	it("creates a global skill when only a project-scoped skill with the same name exists", () => {
		const applier = new ImprovementApplier({
			getSkillNames: () => ["workflow-read-file-search-files"],
			getSkillProvenance: () => "agent",
			isAutoSkillsEnabled: () => true,
			getAutoSkillsScope: () => "global",
			...({
				hasSkill: (name: string, source: "global" | "project") =>
					name === "workflow-read-file-search-files" && source === "project",
				getSkillProvenanceForSource: (_name: string, source: "global" | "project") =>
					source === "project" ? "agent" : "unknown",
			} as any),
		} as any)

		const actions = applier.generateActions([createToolPattern()])

		expect(actions.some((action) => action.actionType === "SKILL_CREATE")).toBe(true)
		expect(actions.some((action) => action.actionType === "SKILL_UPDATE")).toBe(false)
	})

	it("defaults to source-aware skill existence checks when only getSkillNames is provided", () => {
		const applier = new ImprovementApplier({
			getSkillNames: () => ["workflow-read-file-search-files"],
			getSkillProvenance: () => "agent",
			isAutoSkillsEnabled: () => true,
			getAutoSkillsScope: () => "global",
		})

		const actions = applier.generateActions([createToolPattern()])

		expect(actions.some((action) => action.actionType === "SKILL_CREATE")).toBe(true)
		expect(actions.some((action) => action.actionType === "SKILL_UPDATE")).toBe(false)
	})

	describe("specialized skills (SKILL_CREATE_FROM_SCRATCH)", () => {
		function createReactPattern(): LearnedPattern {
			return {
				id: "pattern-react",
				patternType: "tool",
				state: "active",
				summary: "Building React components with TypeScript",
				confidenceScore: 0.85,
				frequency: 5,
				successRate: 0.95,
				firstSeenAt: 1,
				lastSeenAt: 10,
				sourceSignals: ["TASK_SUCCESS"],
				context: {
					toolNames: ["write_to_file", "read_file", "search_files"],
					modes: ["code"],
				},
			}
		}

		function createApiPattern(): LearnedPattern {
			return {
				id: "pattern-api",
				patternType: "tool",
				state: "active",
				summary: "Creating REST API endpoints with Express",
				confidenceScore: 0.78,
				frequency: 4,
				successRate: 0.88,
				firstSeenAt: 2,
				lastSeenAt: 8,
				sourceSignals: ["TASK_SUCCESS"],
				context: {
					toolNames: ["write_to_file", "read_file", "search_files"],
					modes: ["code"],
				},
			}
		}

		function createLowConfidencePattern(): LearnedPattern {
			return {
				id: "pattern-low",
				patternType: "tool",
				state: "active",
				summary: "Building React components with TypeScript",
				confidenceScore: 0.4,
				frequency: 2,
				successRate: 0.6,
				firstSeenAt: 1,
				lastSeenAt: 2,
				sourceSignals: ["TASK_SUCCESS"],
				context: {
					toolNames: ["write_to_file"],
					modes: ["code"],
				},
			}
		}

		it("generates SKILL_CREATE_FROM_SCRATCH for high-confidence domain patterns", () => {
			const applier = new ImprovementApplier({
				getSkillNames: () => [],
				getSkillProvenance: () => "unknown",
				isAutoSkillsEnabled: () => true,
				getExperiments: () => ({ selfImprovingSpecializedSkills: true } as any),
			})

			const actions = applier.generateActions([createReactPattern()])
			const specializedAction = actions.find(
				(action) => action.actionType === "SKILL_CREATE_FROM_SCRATCH",
			)

			expect(specializedAction).toBeDefined()
			expect(specializedAction?.payload.name).toContain("react-component")
			expect(specializedAction?.payload.description).toContain("react-component")
			expect(specializedAction?.payload.instructions).toContain("React Component")
			expect(specializedAction?.payload.tools).toEqual(["write_to_file", "read_file", "search_files"])
			expect(specializedAction?.payload.modeSlugs).toEqual(["code"])
		})

		it("generates SKILL_CREATE_FROM_SCRATCH for API domain patterns", () => {
			const applier = new ImprovementApplier({
				getSkillNames: () => [],
				getSkillProvenance: () => "unknown",
				isAutoSkillsEnabled: () => true,
				getExperiments: () => ({ selfImprovingSpecializedSkills: true } as any),
			})

			const actions = applier.generateActions([createApiPattern()])
			const specializedAction = actions.find(
				(action) => action.actionType === "SKILL_CREATE_FROM_SCRATCH",
			)

			expect(specializedAction).toBeDefined()
			expect(specializedAction?.payload.name).toContain("api-endpoint")
		})

		it("does not generate specialized skills for low-confidence patterns", () => {
			const applier = new ImprovementApplier({
				getSkillNames: () => [],
				getSkillProvenance: () => "unknown",
				isAutoSkillsEnabled: () => true,
				getExperiments: () => ({ selfImprovingSpecializedSkills: true } as any),
			})

			const actions = applier.generateActions([createLowConfidencePattern()])
			const specializedAction = actions.find(
				(action) => action.actionType === "SKILL_CREATE_FROM_SCRATCH",
			)

			expect(specializedAction).toBeUndefined()
		})

		it("does not generate specialized skills when experiment is disabled", () => {
			const applier = new ImprovementApplier({
				getSkillNames: () => [],
				getSkillProvenance: () => "unknown",
				isAutoSkillsEnabled: () => true,
				getExperiments: () => ({ selfImprovingSpecializedSkills: false } as any),
			})

			const actions = applier.generateActions([createReactPattern()])
			const specializedAction = actions.find(
				(action) => action.actionType === "SKILL_CREATE_FROM_SCRATCH",
			)

			expect(specializedAction).toBeUndefined()
		})

		it("does not generate specialized skills when auto-skills are disabled", () => {
			const applier = new ImprovementApplier({
				getSkillNames: () => [],
				getSkillProvenance: () => "unknown",
				isAutoSkillsEnabled: () => false,
				getExperiments: () => ({ selfImprovingSpecializedSkills: true } as any),
			})

			const actions = applier.generateActions([createReactPattern()])
			const specializedAction = actions.find(
				(action) => action.actionType === "SKILL_CREATE_FROM_SCRATCH",
			)

			expect(specializedAction).toBeUndefined()
		})

		it("skips specialized skill creation when skill already exists", () => {
			const applier = new ImprovementApplier({
				getSkillNames: () => [],
				getSkillProvenance: () => "unknown",
				isAutoSkillsEnabled: () => true,
				getExperiments: () => ({ selfImprovingSpecializedSkills: true } as any),
				hasSkill: (name: string) => name.includes("react-component"),
			})

			const actions = applier.generateActions([createReactPattern()])
			const specializedAction = actions.find(
				(action) => action.actionType === "SKILL_CREATE_FROM_SCRATCH",
			)

			expect(specializedAction).toBeUndefined()
		})
	})
})
