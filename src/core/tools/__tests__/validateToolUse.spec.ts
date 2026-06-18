// npx vitest run src/core/tools/__tests__/validateToolUse.spec.ts

import type { ModeConfig } from "@roo-code/types"

import { modes } from "../../../shared/modes"
import { TOOL_GROUPS } from "../../../shared/tools"

import { validateToolUse, isToolAllowedForMode } from "../validateToolUse"

// interview has read/edit/command/mcp — use as the "full-access" mode for tests that
// need a broad set of tools allowed (replaces the old "code" mode from upstream).
const fullAccessMode = modes.find((m) => m.slug === "interview")?.slug || "interview"
const outlineMode = modes.find((m) => m.slug === "outline")?.slug || "outline"
const interviewMode = modes.find((m) => m.slug === "interview")?.slug || "interview"
// draft has read/edit only
const draftMode = modes.find((m) => m.slug === "draft")?.slug || "draft"

describe("mode-validator", () => {
	describe("isToolAllowedForMode", () => {
		describe("interview mode (full-access)", () => {
			it("allows all interview mode tools", () => {
				// Interview mode has read/edit/command/mcp groups
				const allowedGroups = ["read", "edit", "command", "mcp"] as const
				allowedGroups.forEach((groupName) => {
					TOOL_GROUPS[groupName].tools.forEach((tool: string) => {
						expect(isToolAllowedForMode(tool, fullAccessMode, [])).toBe(true)
					})
				})
			})

			it("disallows unknown tools", () => {
				expect(isToolAllowedForMode("unknown_tool" as any, fullAccessMode, [])).toBe(false)
			})
		})

		describe("outline mode", () => {
			it("allows configured tools", () => {
				// Outline mode has read/edit/command/mcp groups
				const outlineTools = [...TOOL_GROUPS.read.tools, ...TOOL_GROUPS.mcp.tools]
				outlineTools.forEach((tool) => {
					expect(isToolAllowedForMode(tool, outlineMode, [])).toBe(true)
				})
			})
		})

		describe("interview mode", () => {
			it("allows configured tools", () => {
				// Interview mode has read/edit/command/mcp groups
				const interviewTools = [...TOOL_GROUPS.read.tools, ...TOOL_GROUPS.mcp.tools]
				interviewTools.forEach((tool) => {
					expect(isToolAllowedForMode(tool, interviewMode, [])).toBe(true)
				})
			})
		})

		describe("custom modes", () => {
			it("allows tools from custom mode configuration", () => {
				const customModes: ModeConfig[] = [
					{
						slug: "custom-mode",
						name: "Custom Mode",
						roleDefinition: "Custom role",
						groups: ["read", "edit"] as const,
					},
				]
				// Should allow tools from read and edit groups
				expect(isToolAllowedForMode("read_file", "custom-mode", customModes)).toBe(true)
				expect(isToolAllowedForMode("write_to_file", "custom-mode", customModes)).toBe(true)
				// Should not allow tools from other groups
				expect(isToolAllowedForMode("execute_command", "custom-mode", customModes)).toBe(false)
			})

			it("allows custom mode to override built-in mode", () => {
				const customModes: ModeConfig[] = [
					{
						slug: draftMode,
						name: "Custom Code Mode",
						roleDefinition: "Custom role",
						groups: ["read"] as const,
					},
				]
				// Should allow tools from read group
				expect(isToolAllowedForMode("read_file", draftMode, customModes)).toBe(true)
				// Should not allow tools from other groups
				expect(isToolAllowedForMode("write_to_file", draftMode, customModes)).toBe(false)
			})

			it("respects tool requirements in custom modes", () => {
				const customModes: ModeConfig[] = [
					{
						slug: "custom-mode",
						name: "Custom Mode",
						roleDefinition: "Custom role",
						groups: ["edit"] as const,
					},
				]
				const requirements = { apply_diff: false }

				// Should respect disabled requirement even if tool group is allowed
				expect(isToolAllowedForMode("apply_diff", "custom-mode", customModes, requirements)).toBe(false)

				// Should allow other edit tools
				expect(isToolAllowedForMode("write_to_file", "custom-mode", customModes, requirements)).toBe(true)
			})
		})

		describe("dynamic MCP tools", () => {
			it("allows dynamic MCP tools when mcp group is in mode groups", () => {
				// Interview mode has mcp group, so dynamic MCP tools should be allowed
				expect(isToolAllowedForMode("mcp_context7_resolve-library-id", fullAccessMode, [])).toBe(true)
				expect(isToolAllowedForMode("mcp_serverName_toolName", fullAccessMode, [])).toBe(true)
			})

			it("disallows dynamic MCP tools when mcp group is not in mode groups", () => {
				const customModes: ModeConfig[] = [
					{
						slug: "no-mcp-mode",
						name: "No MCP Mode",
						roleDefinition: "Custom role",
						groups: ["read", "edit"] as const,
					},
				]
				// Custom mode without mcp group should not allow dynamic MCP tools
				expect(isToolAllowedForMode("mcp_context7_resolve-library-id", "no-mcp-mode", customModes)).toBe(false)
				expect(isToolAllowedForMode("mcp_serverName_toolName", "no-mcp-mode", customModes)).toBe(false)
			})

			it("allows dynamic MCP tools in custom mode with mcp group", () => {
				const customModes: ModeConfig[] = [
					{
						slug: "custom-mcp-mode",
						name: "Custom MCP Mode",
						roleDefinition: "Custom role",
						groups: ["read", "mcp"] as const,
					},
				]
				expect(isToolAllowedForMode("mcp_context7_resolve-library-id", "custom-mcp-mode", customModes)).toBe(
					true,
				)
			})
		})

		describe("tool requirements", () => {
			it("respects tool requirements when provided", () => {
				const requirements = { apply_diff: false }
				expect(isToolAllowedForMode("apply_diff", draftMode, [], requirements)).toBe(false)

				const enabledRequirements = { apply_diff: true }
				expect(isToolAllowedForMode("apply_diff", draftMode, [], enabledRequirements)).toBe(true)
			})

			it("allows tools when their requirements are not specified", () => {
				const requirements = { some_other_tool: true }
				expect(isToolAllowedForMode("apply_diff", draftMode, [], requirements)).toBe(true)
			})

			it("handles undefined and empty requirements", () => {
				expect(isToolAllowedForMode("apply_diff", draftMode, [], undefined)).toBe(true)
				expect(isToolAllowedForMode("apply_diff", draftMode, [], {})).toBe(true)
			})

			it("prioritizes requirements over mode configuration", () => {
				const requirements = { apply_diff: false }
				// Even in code mode which allows all tools, disabled requirement should take precedence
				expect(isToolAllowedForMode("apply_diff", draftMode, [], requirements)).toBe(false)
			})

			it("prioritizes requirements over ALWAYS_AVAILABLE_TOOLS", () => {
				// Tools in ALWAYS_AVAILABLE_TOOLS (switch_mode, new_task, etc.) should still
				// be blockable via toolRequirements / disabledTools
				const requirements = { switch_mode: false, new_task: false, attempt_completion: false }
				expect(isToolAllowedForMode("switch_mode", draftMode, [], requirements)).toBe(false)
				expect(isToolAllowedForMode("new_task", draftMode, [], requirements)).toBe(false)
				expect(isToolAllowedForMode("attempt_completion", draftMode, [], requirements)).toBe(false)
			})
		})
	})

	describe("validateToolUse", () => {
		it("throws error for unknown/invalid tools", () => {
			// Unknown tools should throw with a specific "Unknown tool" error
			expect(() => validateToolUse("unknown_tool" as any, "outline", [])).toThrow(
				'Unknown tool "unknown_tool". This tool does not exist.',
			)
		})

		it("throws error for disallowed tools in draft mode", () => {
			// execute_command is a valid tool but not allowed in draft mode (read/edit only)
			expect(() => validateToolUse("execute_command", "draft", [])).toThrow(
				'Tool "execute_command" is not allowed in draft mode.',
			)
		})

		it("blocks mode-disallowed tools even if a provider declared them", () => {
			// Gemini may receive all tool declarations for history compatibility, so
			// execution-time validation must remain the final mode restriction guard.
			// knowledge-lookup mode only has read group, so write_to_file should be blocked.
			expect(() => validateToolUse("write_to_file", "knowledge-lookup", [])).toThrow(
				'Tool "write_to_file" is not allowed in knowledge-lookup mode.',
			)
		})

		it("does not throw for allowed tools in outline mode", () => {
			expect(() => validateToolUse("read_file", "outline", [])).not.toThrow()
		})

		it("throws error when tool requirement is not met", () => {
			const requirements = { apply_diff: false }
			expect(() => validateToolUse("apply_diff", draftMode, [], requirements)).toThrow(
				'Tool "apply_diff" is not allowed in draft mode.',
			)
		})

		it("does not throw when tool requirement is met", () => {
			const requirements = { apply_diff: true }
			expect(() => validateToolUse("apply_diff", draftMode, [], requirements)).not.toThrow()
		})

		it("handles undefined requirements gracefully", () => {
			expect(() => validateToolUse("apply_diff", draftMode, [], undefined)).not.toThrow()
		})

		it("blocks tool when disabledTools is converted to toolRequirements", () => {
			const disabledTools = ["execute_command", "search_files"]
			const toolRequirements = disabledTools.reduce(
				(acc: Record<string, boolean>, tool: string) => {
					acc[tool] = false
					return acc
				},
				{} as Record<string, boolean>,
			)

			expect(() => validateToolUse("execute_command", draftMode, [], toolRequirements)).toThrow(
				'Tool "execute_command" is not allowed in draft mode.',
			)
			expect(() => validateToolUse("search_files", draftMode, [], toolRequirements)).toThrow(
				'Tool "search_files" is not allowed in draft mode.',
			)
		})

		it("allows non-disabled tools when disabledTools is converted to toolRequirements", () => {
			const disabledTools = ["execute_command"]
			const toolRequirements = disabledTools.reduce(
				(acc: Record<string, boolean>, tool: string) => {
					acc[tool] = false
					return acc
				},
				{} as Record<string, boolean>,
			)

			expect(() => validateToolUse("read_file", draftMode, [], toolRequirements)).not.toThrow()
			expect(() => validateToolUse("write_to_file", draftMode, [], toolRequirements)).not.toThrow()
		})

		it("handles empty disabledTools array converted to toolRequirements", () => {
			const disabledTools: string[] = []
			const toolRequirements = disabledTools.reduce(
				(acc: Record<string, boolean>, tool: string) => {
					acc[tool] = false
					return acc
				},
				{} as Record<string, boolean>,
			)

			expect(() => validateToolUse("execute_command", fullAccessMode, [], toolRequirements)).not.toThrow()
		})
	})
})
