// npx vitest run src/core/webview/__tests__/skillsMessageHandler.spec.ts

import type { SkillMetadata, WebviewMessage } from "@roo-code/types"
import type { ClineProvider } from "../ClineProvider"

// Mock vscode first
vi.mock("vscode", () => {
	const showErrorMessage = vi.fn()

	return {
		window: {
			showErrorMessage,
		},
	}
})

// Mock open-file
vi.mock("../../../integrations/misc/open-file", () => ({
	openFile: vi.fn(),
}))

// Mock i18n
vi.mock("../../../i18n", () => ({
	t: (key: string, params?: Record<string, any>) => {
		const translations: Record<string, string> = {
			"skills:errors.missing_create_fields": "Missing required fields: skillName, source, or skillDescription",
			"skills:errors.manager_unavailable": "Skills manager not available",
			"skills:errors.missing_delete_fields": "Missing required fields: skillName or source",
			"skills:errors.missing_move_fields": "Missing required fields: skillName or source",
			"skills:errors.missing_update_modes_fields": "Missing required fields: skillName or source",
			"skills:errors.skill_not_found": `Skill "${params?.name}" not found`,
		}
		return translations[key] || key
	},
}))

import * as vscode from "vscode"
import { openFile } from "../../../integrations/misc/open-file"
import {
	handleRequestSkills,
	handleCreateSkill,
	handleDeleteSkill,
	handleMoveSkill,
	handleOpenSkillFile,
	handleUpdateSkillModes,
} from "../skillsMessageHandler"

describe("skillsMessageHandler", () => {
	const mockLog = vi.fn()
	const mockPostMessageToWebview = vi.fn()
	const mockGetSkillsMetadata = vi.fn()
	const mockGetSkillDiagnostics = vi.fn()
	const mockCreateSkill = vi.fn()
	const mockDeleteSkill = vi.fn()
	const mockMoveSkill = vi.fn()
	const mockUpdateSkillModes = vi.fn()
	const mockGetSkill = vi.fn()
	const mockFindSkillByNameAndSource = vi.fn()

	const createMockProvider = (hasSkillsManager: boolean = true): ClineProvider => {
		const skillsManager = hasSkillsManager
			? {
					getSkillsMetadata: mockGetSkillsMetadata,
					getSkillDiagnostics: mockGetSkillDiagnostics,
					createSkill: mockCreateSkill,
					deleteSkill: mockDeleteSkill,
					moveSkill: mockMoveSkill,
					updateSkillModes: mockUpdateSkillModes,
					getSkill: mockGetSkill,
					findSkillByNameAndSource: mockFindSkillByNameAndSource,
				}
			: undefined

		return {
			log: mockLog,
			postMessageToWebview: mockPostMessageToWebview,
			getSkillsManager: () => skillsManager,
		} as unknown as ClineProvider
	}

	const mockSkills: SkillMetadata[] = [
		{
			name: "test-skill",
			description: "Test skill description",
			path: "/path/to/test-skill/SKILL.md",
			source: "global",
		},
		{
			name: "project-skill",
			description: "Project skill description",
			path: "/project/.roo/skills/project-skill/SKILL.md",
			source: "project",
			mode: "code",
		},
	]

	beforeEach(() => {
		vi.clearAllMocks()
		mockGetSkillDiagnostics.mockReturnValue([])
	})

	describe("handleRequestSkills", () => {
		it("returns skills when skills manager is available", async () => {
			const provider = createMockProvider(true)
			mockGetSkillsMetadata.mockReturnValue(mockSkills)

			const result = await handleRequestSkills(provider)

			expect(result).toEqual(mockSkills)
			expect(mockPostMessageToWebview).toHaveBeenCalledWith({
				type: "skills",
				skills: mockSkills,
				skillDiagnostics: [],
			})
		})

		it("sends structured malformed-skill diagnostics without hiding valid skills", async () => {
			const provider = createMockProvider(true)
			const diagnostics = [
				{
					path: "/workspace/.roo/skills/broken/SKILL.md",
					source: "project" as const,
					message: "bad indentation of a mapping entry",
					line: 3,
					column: 20,
				},
			]
			mockGetSkillsMetadata.mockReturnValue(mockSkills)
			mockGetSkillDiagnostics.mockReturnValue(diagnostics)

			await handleRequestSkills(provider)

			expect(mockPostMessageToWebview).toHaveBeenCalledWith({
				type: "skills",
				skills: mockSkills,
				skillDiagnostics: diagnostics,
			})
		})

		it("returns empty skills when skills manager is not available", async () => {
			const provider = createMockProvider(false)

			const result = await handleRequestSkills(provider)

			expect(result).toEqual([])
			expect(mockPostMessageToWebview).toHaveBeenCalledWith({
				type: "skills",
				skills: [],
				skillDiagnostics: [],
			})
		})

		it("handles errors and returns empty skills", async () => {
			const provider = createMockProvider(true)
			mockGetSkillsMetadata.mockImplementation(function () {
				throw new Error("Test error")
			})

			const result = await handleRequestSkills(provider)

			expect(result).toEqual([])
			expect(mockLog).toHaveBeenCalled()
			expect(mockPostMessageToWebview).toHaveBeenCalledWith({
				type: "skills",
				skills: [],
				skillDiagnostics: [],
			})
		})
	})

	describe("handleCreateSkill", () => {
		it("creates a skill successfully", async () => {
			const provider = createMockProvider(true)
			mockCreateSkill.mockResolvedValue("/path/to/new-skill/SKILL.md")
			mockGetSkillsMetadata.mockReturnValue(mockSkills)

			const result = await handleCreateSkill(provider, {
				type: "createSkill",
				skillName: "new-skill",
				source: "global",
				skillDescription: "New skill description",
			} as WebviewMessage)

			expect(result).toEqual(mockSkills)
			expect(mockCreateSkill).toHaveBeenCalledWith("new-skill", "global", "New skill description", undefined)
			expect(openFile).toHaveBeenCalledWith("/path/to/new-skill/SKILL.md")
			expect(mockPostMessageToWebview).toHaveBeenCalledWith({
				type: "skills",
				skills: mockSkills,
				skillDiagnostics: [],
			})
		})

		it("creates a skill with mode restriction", async () => {
			const provider = createMockProvider(true)
			mockCreateSkill.mockResolvedValue("/path/to/new-skill/SKILL.md")
			mockGetSkillsMetadata.mockReturnValue(mockSkills)

			const result = await handleCreateSkill(provider, {
				type: "createSkill",
				skillName: "new-skill",
				source: "project",
				skillDescription: "New skill description",
				skillMode: "code",
			} as WebviewMessage)

			expect(result).toEqual(mockSkills)
			expect(mockCreateSkill).toHaveBeenCalledWith("new-skill", "project", "New skill description", ["code"])
		})

		it("returns undefined when required fields are missing", async () => {
			const provider = createMockProvider(true)

			const result = await handleCreateSkill(provider, {
				type: "createSkill",
				skillName: "new-skill",
				// missing source and skillDescription
			} as WebviewMessage)

			expect(result).toBeUndefined()
			expect(mockLog).toHaveBeenCalledWith(
				"Error creating skill: Missing required fields: skillName, source, or skillDescription",
			)
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
				"Failed to create skill: Missing required fields: skillName, source, or skillDescription",
			)
		})

		it("returns undefined when skills manager is not available", async () => {
			const provider = createMockProvider(false)

			const result = await handleCreateSkill(provider, {
				type: "createSkill",
				skillName: "new-skill",
				source: "global",
				skillDescription: "New skill description",
			} as WebviewMessage)

			expect(result).toBeUndefined()
			expect(mockLog).toHaveBeenCalledWith("Error creating skill: Skills manager not available")
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
				"Failed to create skill: Skills manager not available",
			)
		})
	})

	describe("handleDeleteSkill", () => {
		it("deletes a skill successfully", async () => {
			const provider = createMockProvider(true)
			mockDeleteSkill.mockResolvedValue(undefined)
			mockGetSkillsMetadata.mockReturnValue([mockSkills[1]])

			const result = await handleDeleteSkill(provider, {
				type: "deleteSkill",
				skillName: "test-skill",
				source: "global",
			} as WebviewMessage)

			expect(result).toEqual([mockSkills[1]])
			expect(mockDeleteSkill).toHaveBeenCalledWith("test-skill", "global", undefined)
			expect(mockPostMessageToWebview).toHaveBeenCalledWith({
				type: "skills",
				skills: [mockSkills[1]],
				skillDiagnostics: [],
			})
		})

		it("deletes a skill with mode restriction", async () => {
			const provider = createMockProvider(true)
			mockDeleteSkill.mockResolvedValue(undefined)
			mockGetSkillsMetadata.mockReturnValue([mockSkills[0]])

			const result = await handleDeleteSkill(provider, {
				type: "deleteSkill",
				skillName: "project-skill",
				source: "project",
				skillMode: "code",
			} as WebviewMessage)

			expect(result).toEqual([mockSkills[0]])
			expect(mockDeleteSkill).toHaveBeenCalledWith("project-skill", "project", "code")
		})

		it("returns undefined when required fields are missing", async () => {
			const provider = createMockProvider(true)

			const result = await handleDeleteSkill(provider, {
				type: "deleteSkill",
				skillName: "test-skill",
				// missing source
			} as WebviewMessage)

			expect(result).toBeUndefined()
			expect(mockLog).toHaveBeenCalledWith("Error deleting skill: Missing required fields: skillName or source")
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
				"Failed to delete skill: Missing required fields: skillName or source",
			)
		})

		it("returns undefined when skills manager is not available", async () => {
			const provider = createMockProvider(false)

			const result = await handleDeleteSkill(provider, {
				type: "deleteSkill",
				skillName: "test-skill",
				source: "global",
			} as WebviewMessage)

			expect(result).toBeUndefined()
			expect(mockLog).toHaveBeenCalledWith("Error deleting skill: Skills manager not available")
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
				"Failed to delete skill: Skills manager not available",
			)
		})
	})

	describe("handleMoveSkill", () => {
		it("moves a skill successfully", async () => {
			const provider = createMockProvider(true)
			mockMoveSkill.mockResolvedValue(undefined)
			mockGetSkillsMetadata.mockReturnValue([mockSkills[0]])

			const result = await handleMoveSkill(provider, {
				type: "moveSkill",
				skillName: "test-skill",
				source: "global",
				skillMode: undefined,
				newSkillMode: "code",
			} as WebviewMessage)

			expect(result).toEqual([mockSkills[0]])
			expect(mockMoveSkill).toHaveBeenCalledWith("test-skill", "global", undefined, "code")
			expect(mockPostMessageToWebview).toHaveBeenCalledWith({
				type: "skills",
				skills: [mockSkills[0]],
				skillDiagnostics: [],
			})
		})

		it("moves a skill from one mode to another", async () => {
			const provider = createMockProvider(true)
			mockMoveSkill.mockResolvedValue(undefined)
			mockGetSkillsMetadata.mockReturnValue([mockSkills[1]])

			const result = await handleMoveSkill(provider, {
				type: "moveSkill",
				skillName: "project-skill",
				source: "project",
				skillMode: "code",
				newSkillMode: "architect",
			} as WebviewMessage)

			expect(result).toEqual([mockSkills[1]])
			expect(mockMoveSkill).toHaveBeenCalledWith("project-skill", "project", "code", "architect")
		})

		it("returns undefined when required fields are missing", async () => {
			const provider = createMockProvider(true)

			const result = await handleMoveSkill(provider, {
				type: "moveSkill",
				skillName: "test-skill",
				// missing source
			} as WebviewMessage)

			expect(result).toBeUndefined()
			expect(mockLog).toHaveBeenCalledWith("Error moving skill: Missing required fields: skillName or source")
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
				"Failed to move skill: Missing required fields: skillName or source",
			)
		})

		it("returns undefined when skills manager is not available", async () => {
			const provider = createMockProvider(false)

			const result = await handleMoveSkill(provider, {
				type: "moveSkill",
				skillName: "test-skill",
				source: "global",
				newSkillMode: "code",
			} as WebviewMessage)

			expect(result).toBeUndefined()
			expect(mockLog).toHaveBeenCalledWith("Error moving skill: Skills manager not available")
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
				"Failed to move skill: Skills manager not available",
			)
		})
	})

	describe("handleUpdateSkillModes", () => {
		it("updates a skill's mode slugs successfully", async () => {
			const provider = createMockProvider(true)
			mockUpdateSkillModes.mockResolvedValue(undefined)
			mockGetSkillsMetadata.mockReturnValue([mockSkills[0]])

			const result = await handleUpdateSkillModes(provider, {
				type: "updateSkillModes",
				skillName: "test-skill",
				source: "global",
				newSkillModeSlugs: ["code"],
			} as WebviewMessage)

			expect(result).toEqual([mockSkills[0]])
			expect(mockUpdateSkillModes).toHaveBeenCalledWith("test-skill", "global", ["code"])
			expect(mockPostMessageToWebview).toHaveBeenCalledWith({
				type: "skills",
				skills: [mockSkills[0]],
				skillDiagnostics: [],
			})
		})

		it("clears a skill's mode restriction with empty slugs", async () => {
			const provider = createMockProvider(true)
			mockUpdateSkillModes.mockResolvedValue(undefined)
			mockGetSkillsMetadata.mockReturnValue([mockSkills[1]])

			const result = await handleUpdateSkillModes(provider, {
				type: "updateSkillModes",
				skillName: "project-skill",
				source: "project",
				newSkillModeSlugs: [],
			} as WebviewMessage)

			expect(result).toEqual([mockSkills[1]])
			expect(mockUpdateSkillModes).toHaveBeenCalledWith("project-skill", "project", [])
		})

		it("passes undefined mode slugs and refreshes state when newSkillModeSlugs is omitted", async () => {
			const provider = createMockProvider(true)
			mockUpdateSkillModes.mockResolvedValue(undefined)
			mockGetSkillsMetadata.mockReturnValue([mockSkills[0]])
			// Forward a concrete (non-empty) diagnostic so the assertion proves the
			// handler relays the diagnostics list rather than always posting []
			// (which would pass even if the field were dropped or hard-coded).
			const diagnostics = [
				{
					path: "/global/.roo/skills/broken/SKILL.md",
					source: "global" as const,
					message: "can not read a block mapping entry",
					line: 3,
					column: 10,
				},
			]
			mockGetSkillDiagnostics.mockReturnValue(diagnostics)

			const message: WebviewMessage = {
				type: "updateSkillModes",
				skillName: "test-skill",
				source: "global",
				// newSkillModeSlugs omitted
			}
			const result = await handleUpdateSkillModes(provider, message)

			expect(result).toEqual([mockSkills[0]])
			expect(mockUpdateSkillModes).toHaveBeenCalledWith("test-skill", "global", undefined)
			expect(mockPostMessageToWebview).toHaveBeenCalledWith({
				type: "skills",
				skills: [mockSkills[0]],
				skillDiagnostics: diagnostics,
			})
		})

		it("returns undefined when required fields are missing", async () => {
			const provider = createMockProvider(true)

			const result = await handleUpdateSkillModes(provider, {
				type: "updateSkillModes",
				skillName: "test-skill",
				// missing source
			} as WebviewMessage)

			expect(result).toBeUndefined()
			expect(mockUpdateSkillModes).not.toHaveBeenCalled()
			expect(mockLog).toHaveBeenCalledWith(
				"Error updating skill modes: Missing required fields: skillName or source",
			)
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
				"Failed to update skill modes: Missing required fields: skillName or source",
			)
		})

		it("returns undefined when skills manager is not available", async () => {
			const provider = createMockProvider(false)

			const result = await handleUpdateSkillModes(provider, {
				type: "updateSkillModes",
				skillName: "test-skill",
				source: "global",
				newSkillModeSlugs: ["code"],
			} as WebviewMessage)

			expect(result).toBeUndefined()
			expect(mockLog).toHaveBeenCalledWith("Error updating skill modes: Skills manager not available")
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
				"Failed to update skill modes: Skills manager not available",
			)
		})

		it("returns undefined and reports the error when updateSkillModes rejects", async () => {
			const provider = createMockProvider(true)
			mockUpdateSkillModes.mockRejectedValue(new Error("boom"))

			const result = await handleUpdateSkillModes(provider, {
				type: "updateSkillModes",
				skillName: "test-skill",
				source: "global",
				newSkillModeSlugs: ["code"],
			} as WebviewMessage)

			expect(result).toBeUndefined()
			expect(mockLog).toHaveBeenCalledWith("Error updating skill modes: boom")
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Failed to update skill modes: boom")
		})
	})

	describe("handleOpenSkillFile", () => {
		it("opens a skill file successfully", async () => {
			const provider = createMockProvider(true)
			mockFindSkillByNameAndSource.mockReturnValue(mockSkills[0])

			await handleOpenSkillFile(provider, {
				type: "openSkillFile",
				skillName: "test-skill",
				source: "global",
			} as WebviewMessage)

			expect(mockFindSkillByNameAndSource).toHaveBeenCalledWith("test-skill", "global")
			expect(openFile).toHaveBeenCalledWith("/path/to/test-skill/SKILL.md")
		})

		it("opens a skill file with mode restriction", async () => {
			const provider = createMockProvider(true)
			mockFindSkillByNameAndSource.mockReturnValue(mockSkills[1])

			await handleOpenSkillFile(provider, {
				type: "openSkillFile",
				skillName: "project-skill",
				source: "project",
				skillMode: "code",
			} as WebviewMessage)

			expect(mockFindSkillByNameAndSource).toHaveBeenCalledWith("project-skill", "project")
			expect(openFile).toHaveBeenCalledWith("/project/.roo/skills/project-skill/SKILL.md")
		})

		it("shows error when required fields are missing", async () => {
			const provider = createMockProvider(true)

			await handleOpenSkillFile(provider, {
				type: "openSkillFile",
				skillName: "test-skill",
				// missing source
			} as WebviewMessage)

			expect(mockLog).toHaveBeenCalledWith(
				"Error opening skill file: Missing required fields: skillName or source",
			)
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
				"Failed to open skill file: Missing required fields: skillName or source",
			)
		})

		it("shows error when skills manager is not available", async () => {
			const provider = createMockProvider(false)

			await handleOpenSkillFile(provider, {
				type: "openSkillFile",
				skillName: "test-skill",
				source: "global",
			} as WebviewMessage)

			expect(mockLog).toHaveBeenCalledWith("Error opening skill file: Skills manager not available")
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
				"Failed to open skill file: Skills manager not available",
			)
		})

		it("shows error when skill is not found", async () => {
			const provider = createMockProvider(true)
			mockFindSkillByNameAndSource.mockReturnValue(undefined)

			await handleOpenSkillFile(provider, {
				type: "openSkillFile",
				skillName: "nonexistent-skill",
				source: "global",
			} as WebviewMessage)

			expect(mockLog).toHaveBeenCalledWith('Error opening skill file: Skill "nonexistent-skill" not found')
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
				'Failed to open skill file: Skill "nonexistent-skill" not found',
			)
		})
	})
})
