import { ActionExecutor } from "../ActionExecutor"
import type { ImprovementAction } from "../types"

describe("ActionExecutor", () => {
	const logger = { appendLine: vi.fn() }

	beforeEach(() => {
		logger.appendLine.mockReset()
	})

	it("writes prompt, error, and tool guidance into memory", async () => {
		const memoryStore = {
			store: vi.fn().mockResolvedValue({ id: "mem-1" }),
		} as any
		const skillUsageStore = { getOrCreate: vi.fn() } as any
		const executor = new ActionExecutor(memoryStore, skillUsageStore, logger)

		const actions: ImprovementAction[] = [
			{
				id: "action-1",
				actionType: "PROMPT_ENRICHMENT",
				target: "system-prompt",
				payload: { summary: "Prefer semantic search before regex search" },
				timestamp: 1,
			},
			{
				id: "action-2",
				actionType: "ERROR_AVOIDANCE",
				target: "task-execution",
				payload: { summary: "Handle ENOENT before retry", errorKeys: ["ENOENT"] },
				timestamp: 2,
			},
			{
				id: "action-3",
				actionType: "TOOL_PREFERENCE",
				target: "task-execution",
				payload: { summary: "Use codebase_search before search_files", toolNames: ["codebase_search"] },
				timestamp: 3,
			},
		]

		const succeeded = await executor.executeBatch(actions)

		expect(succeeded).toEqual(new Set(["action-1", "action-2", "action-3"]))
		expect(memoryStore.store).toHaveBeenNthCalledWith(1, {
			content: "Prefer semantic search before regex search",
			source: "learning",
			tags: ["learned", "prompt"],
		})
		expect(memoryStore.store).toHaveBeenNthCalledWith(2, {
			content: "Handle ENOENT before retry",
			source: "learning",
			tags: ["error-avoidance", "error:ENOENT"],
		})
		expect(memoryStore.store).toHaveBeenNthCalledWith(3, {
			content: "Use codebase_search before search_files",
			source: "learning",
			tags: ["tool-preference", "tool:codebase_search"],
		})
	})

	it("records skill suggestions in the telemetry sidecar", async () => {
		const memoryStore = { store: vi.fn() } as any
		const skillUsageStore = { getOrCreate: vi.fn() } as any
		const executor = new ActionExecutor(memoryStore, skillUsageStore, logger)

		const action: ImprovementAction = {
			id: "action-skill",
			actionType: "SKILL_SUGGESTION",
			target: "skills-manager",
			payload: {
				summary: "Create a self-improving review skill",
				skillName: "Self Improving Review Skill",
			},
			timestamp: 1,
		}

		await expect(executor.execute(action)).resolves.toBe(true)
		expect(skillUsageStore.getOrCreate).toHaveBeenCalledWith(
			expect.stringMatching(/^suggested:/),
			"Self Improving Review Skill",
			"agent",
		)
		expect(logger.appendLine).toHaveBeenCalledWith(
			"[ActionExecutor] Skill suggestion recorded: Create a self-improving review skill",
		)
	})

	it("creates agent-managed skills from mutation actions", async () => {
		const memoryStore = { store: vi.fn() } as any
		const skillUsageStore = { getOrCreate: vi.fn() } as any
		const skillsManager = {
			createSkillFromContent: vi
				.fn()
				.mockResolvedValue("/tmp/.roo/skills/workflow-read-file-search-files/SKILL.md"),
		} as any
		const executor = new ActionExecutor(memoryStore, skillUsageStore, logger, skillsManager)

		const action: ImprovementAction = {
			id: "action-skill-create",
			actionType: "SKILL_CREATE",
			target: "skills-manager",
			payload: {
				skillName: "workflow-read-file-search-files",
				description: "Use when tasks repeatedly succeed with read_file and search_files.",
				content:
					"---\nname: workflow-read-file-search-files\ndescription: Use when tasks repeatedly succeed with read_file and search_files.\n---\n\n# Workflow\n",
				source: "project",
				modeSlugs: ["code"],
			},
			timestamp: 1,
		}

		await expect(executor.execute(action)).resolves.toBe(true)
		expect(skillsManager.createSkillFromContent).toHaveBeenCalledWith(
			"workflow-read-file-search-files",
			"project",
			"Use when tasks repeatedly succeed with read_file and search_files.",
			expect.stringContaining("name: workflow-read-file-search-files"),
			["code"],
		)
		expect(skillUsageStore.getOrCreate).toHaveBeenCalledWith(
			"skill:project:workflow-read-file-search-files",
			"workflow-read-file-search-files",
			"agent",
		)
	})

	it("creates specialized skills from scratch via SKILL_CREATE_FROM_SCRATCH", async () => {
		const memoryStore = { store: vi.fn() } as any
		const skillUsageStore = { getOrCreate: vi.fn() } as any
		const skillsManager = {
			createSkillFromContent: vi.fn().mockResolvedValue("/tmp/.roo/skills/react-component-builder/SKILL.md"),
		} as any
		const executor = new ActionExecutor(memoryStore, skillUsageStore, logger, skillsManager)

		const action: ImprovementAction = {
			id: "action-specialized",
			actionType: "SKILL_CREATE_FROM_SCRATCH",
			target: "skills-manager",
			payload: {
				name: "react-component-builder",
				description: "Specialized skill for building React components",
				instructions: "# React Component Builder\n\n## Instructions\n\n1. Create component file\n2. Add TypeScript types\n3. Write tests",
				source: "project",
				modeSlugs: ["code"],
				tools: ["read_file", "write_to_file", "search_files"],
				assets: [
					{ relativePath: "scripts/validate.sh", content: "#!/bin/bash\necho validate" },
				],
			},
			timestamp: 1,
		}

		await expect(executor.execute(action)).resolves.toBe(true)
		expect(skillsManager.createSkillFromContent).toHaveBeenCalledWith(
			"react-component-builder",
			"project",
			"Specialized skill for building React components",
			expect.stringContaining("name: react-component-builder"),
			["code"],
		)
		expect(skillUsageStore.getOrCreate).toHaveBeenCalledWith(
			expect.stringMatching(/^skill:project:react-component-builder/),
			"react-component-builder",
			"agent",
		)
	})

	it("rejects SKILL_CREATE_FROM_SCRATCH with missing required fields", async () => {
		const memoryStore = { store: vi.fn() } as any
		const skillUsageStore = { getOrCreate: vi.fn() } as any
		const skillsManager = {
			createSkillFromContent: vi.fn(),
		} as any
		const executor = new ActionExecutor(memoryStore, skillUsageStore, logger, skillsManager)

		const action: ImprovementAction = {
			id: "action-incomplete",
			actionType: "SKILL_CREATE_FROM_SCRATCH",
			target: "skills-manager",
			payload: {
				name: "incomplete-skill",
				// missing description and instructions
			},
			timestamp: 1,
		}

		await expect(executor.execute(action)).resolves.toBe(false)
		expect(skillsManager.createSkillFromContent).not.toHaveBeenCalled()
	})

	it("updates existing agent-managed skills from mutation actions", async () => {
		const memoryStore = { store: vi.fn() } as any
		const skillUsageStore = {
			getOrCreate: vi.fn(),
			bumpPatch: vi.fn().mockResolvedValue(undefined),
		} as any
		const skillsManager = {
			updateSkillContent: vi.fn().mockResolvedValue(undefined),
		} as any
		const executor = new ActionExecutor(memoryStore, skillUsageStore, logger, skillsManager)

		const action: ImprovementAction = {
			id: "action-skill-update",
			actionType: "SKILL_UPDATE",
			target: "skills-manager",
			payload: {
				skillId: "skill:project:workflow-read-file-search-files",
				skillName: "workflow-read-file-search-files",
				content:
					"---\nname: workflow-read-file-search-files\ndescription: Updated workflow\n---\n\n# Workflow\nUpdated\n",
				source: "project",
				mode: "code",
			},
			timestamp: 1,
		}

		await expect(executor.execute(action)).resolves.toBe(true)
		expect(skillsManager.updateSkillContent).toHaveBeenCalledWith(
			"workflow-read-file-search-files",
			"project",
			expect.stringContaining("Updated workflow"),
			"code",
		)
		expect(skillUsageStore.bumpPatch).toHaveBeenCalledWith("skill:project:workflow-read-file-search-files")
	})

	it("keeps invalid actions pending by reporting failure", async () => {
		const executor = new ActionExecutor({ store: vi.fn() } as any, { getOrCreate: vi.fn() } as any, logger)

		await expect(
			executor.execute({
				id: "invalid",
				actionType: "PROMPT_ENRICHMENT",
				target: "system-prompt",
				payload: {},
				timestamp: 1,
			}),
		).resolves.toBe(false)
	})
})
