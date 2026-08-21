import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"

import { API } from "../api"
import { ClineProvider } from "../../core/webview/ClineProvider"

vi.mock("vscode")
vi.mock("../../core/webview/ClineProvider")

describe("API#getSkillsState", () => {
	let api: API
	let mockOutputChannel: vscode.OutputChannel
	let mockProvider: ClineProvider
	let mockGetSkillsManager: ReturnType<typeof vi.fn>

	beforeEach(() => {
		// mockOutputChannel and mockProvider are intentionally partial
		// doubles: they implement only the members API touches (appendLine;
		// context, getSkillsManager, on). The as-unknown-as casts are the
		// last resort because the partial shapes are not subtypes of the full
		// vscode.OutputChannel / ClineProvider types.
		mockOutputChannel = {
			appendLine: vi.fn(),
		} as unknown as vscode.OutputChannel

		mockGetSkillsManager = vi.fn()

		mockProvider = {
			context: {} as vscode.ExtensionContext,
			getSkillsManager: mockGetSkillsManager,
			on: vi.fn(),
		} as unknown as ClineProvider

		api = new API(mockOutputChannel, mockProvider, undefined, true)
	})

	it("returns the skills and diagnostics from the skills manager", () => {
		const skills = [
			{
				name: "good-skill",
				description: "A healthy skill.",
				path: "/skills/good-skill/SKILL.md",
				source: "project" as const,
			},
		]
		const skillDiagnostics = [
			{ path: "/skills/bad-skill/SKILL.md", source: "project" as const, message: "YAML syntax error", line: 3 },
		]
		mockGetSkillsManager.mockReturnValue({
			getSkillsMetadata: vi.fn().mockReturnValue(skills),
			getSkillDiagnostics: vi.fn().mockReturnValue(skillDiagnostics),
		})

		expect(api.getSkillsState()).toEqual({ skills, skillDiagnostics })
	})

	it("returns empty arrays when the skills manager is unavailable", () => {
		mockGetSkillsManager.mockReturnValue(undefined)

		expect(api.getSkillsState()).toEqual({ skills: [], skillDiagnostics: [] })
	})
})
