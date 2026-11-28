// npx vitest run core/background-subtasks/__tests__/policy.spec.ts

import { customToolRegistry } from "@roo-code/core"
import type { ToolName } from "@roo-code/types"

import { modes } from "../../../shared/modes"
import { ALWAYS_AVAILABLE_TOOLS } from "../../../shared/tools"

import { buildAutoDenyReason } from "../../auto-approval/autoDenyReason"
import { buildToolRequirements } from "../../prompts/tools/effective-tool-policy"
import { isToolAllowedForMode, validateToolUse } from "../../tools/validateToolUse"

import { BACKGROUND_CHILD_DISABLED_TOOLS, BACKGROUND_CHILD_EXPERIMENTS, mergeBackgroundToolPolicy } from "../policy"

describe("mergeBackgroundToolPolicy", () => {
	it("returns empty results when both inputs are absent", () => {
		expect(mergeBackgroundToolPolicy(undefined, undefined)).toEqual({ disabledTools: [], experiments: undefined })
	})

	it("returns state values only when the policy is absent", () => {
		const state = { disabledTools: ["read_file"], experiments: { customTools: true } }
		const merged = mergeBackgroundToolPolicy(undefined, state)
		expect(merged.disabledTools).toEqual(["read_file"])
		expect(merged.experiments).toEqual({ customTools: true })
	})

	it("returns policy values only when the state is absent", () => {
		const merged = mergeBackgroundToolPolicy({ disabledTools: ["write_to_file"] }, undefined)
		expect(merged.disabledTools).toEqual(["write_to_file"])
		expect(merged.experiments).toBeUndefined()
	})

	it("unions disabledTools state-first with duplicates removed", () => {
		const state = { disabledTools: ["read_file", "execute_command"] }
		const policy = { disabledTools: ["write_to_file", "execute_command", "read_file"] }
		const merged = mergeBackgroundToolPolicy(policy, state)
		expect(merged.disabledTools).toEqual(["read_file", "execute_command", "write_to_file"])
	})

	it("merges experiments with the background policy winning on conflict", () => {
		const state = { experiments: { customTools: true, imageGeneration: true } }
		const policy = { experiments: { customTools: false } }
		const merged = mergeBackgroundToolPolicy(policy, state)
		expect(merged.experiments).toEqual({ customTools: false, imageGeneration: true })
	})

	it("passes through state experiments untouched when the policy has none", () => {
		const state = { experiments: { customTools: true } }
		const merged = mergeBackgroundToolPolicy(undefined, state)
		expect(merged.experiments).toEqual({ customTools: true })
	})

	it("never mutates its inputs and never aliases their containers", () => {
		const state = {
			disabledTools: ["read_file"],
			experiments: { customTools: true },
		}
		const policy = {
			disabledTools: ["write_to_file"],
			experiments: { customTools: false },
		}
		const stateDisabledTools = state.disabledTools
		const stateExperiments = state.experiments
		const merged = mergeBackgroundToolPolicy(policy, state)
		// The union must be a fresh array and a fresh experiments object, so a
		// later snapshot capture can never write through into provider state.
		expect(merged.disabledTools).not.toBe(stateDisabledTools)
		expect(merged.disabledTools).not.toBe(policy.disabledTools)
		expect(merged.experiments).not.toBe(stateExperiments)
		expect(merged.experiments).not.toBe(policy.experiments)
		expect(state).toEqual({ disabledTools: ["read_file"], experiments: { customTools: true } })
		expect(policy).toEqual({ disabledTools: ["write_to_file"], experiments: { customTools: false } })
	})
})

describe("BACKGROUND_CHILD_DISABLED_TOOLS", () => {
	it("blocks exactly the read-only child block list", () => {
		expect([...BACKGROUND_CHILD_DISABLED_TOOLS]).toEqual([
			"write_to_file",
			"apply_diff",
			"edit",
			"search_and_replace",
			"search_replace",
			"edit_file",
			"apply_patch",
			"generate_image",
			"execute_command",
			"read_command_output",
			"run_slash_command",
			"skill",
			"switch_mode",
			"new_task",
			"parallel_subtasks",
			"ask_followup_question",
			"use_mcp_tool",
			"access_mcp_resource",
		])
	})

	it("keeps the custom-tools experiment off for a background child", () => {
		expect(BACKGROUND_CHILD_EXPERIMENTS).toEqual({ customTools: false })
	})
})

describe("background block list precedence over always-available tools (F2)", () => {
	const codeMode = modes.find((m) => m.slug === "code")?.slug || "code"
	const requirements = buildToolRequirements([...BACKGROUND_CHILD_DISABLED_TOOLS])

	it.each(["new_task", "switch_mode", "ask_followup_question"])(
		"blocks the always-available tool %s that a mode grant alone cannot",
		(tool) => {
			// Control: without the requirements map the always-available
			// short-circuit grants the tool in any mode.
			expect(ALWAYS_AVAILABLE_TOOLS).toContain(tool)
			expect(isToolAllowedForMode(tool, codeMode, [])).toBe(true)
			// The requirements map built from the block list is evaluated first,
			// so the tool is rejected even though it is always available.
			expect(isToolAllowedForMode(tool, codeMode, [], requirements)).toBe(false)
		},
	)

	it.each(["write_to_file", "execute_command", "use_mcp_tool", "access_mcp_resource"])(
		"blocks the mode-granted tool %s through the same requirements map",
		(tool) => {
			// Control: code mode grants these through its edit/command/mcp groups.
			expect(isToolAllowedForMode(tool, codeMode, [])).toBe(true)
			expect(isToolAllowedForMode(tool, codeMode, [], requirements)).toBe(false)
		},
	)

	it("blocks parallel_subtasks so a child can never fan out further", () => {
		// parallel_subtasks is a registered, always-available ToolName (Phase 3,
		// packages/types/src/tool.ts), so the always-available short-circuit
		// would grant it in any mode; the requirements map built from the block
		// list is evaluated first and rejects it.
		expect(isToolAllowedForMode("parallel_subtasks", codeMode, [], requirements)).toBe(false)
		expect(requirements["parallel_subtasks"]).toBe(false)
	})
})

describe("custom tools against a background child policy snapshot (F-16)", () => {
	const codeMode = modes.find((m) => m.slug === "code")?.slug || "code"

	it("rejects a registered custom tool even when ambient state enables customTools", () => {
		customToolRegistry.register({
			name: "shadow_child_tool",
			description: "test double",
			execute: async () => "ok",
		})
		try {
			// Ambient provider state has the custom-tools experiment on; the
			// child policy snapshot must still close that path. The block list
			// carries no `custom_tool` key (custom tools validate under their own
			// registered name, so it would never key-match); the protection is
			// BACKGROUND_CHILD_EXPERIMENTS.customTools = false.
			const state = { experiments: { customTools: true } }
			const policy = {
				disabledTools: BACKGROUND_CHILD_DISABLED_TOOLS,
				experiments: BACKGROUND_CHILD_EXPERIMENTS,
			}
			const merged = mergeBackgroundToolPolicy(policy, state)
			expect(merged.experiments).toEqual({ customTools: false })
			expect(merged.disabledTools).not.toContain("custom_tool")

			// The custom tool's registered name is not a static ToolName, so the
			// cast stands in for the parser's dynamic name.
			const requirements = buildToolRequirements(merged.disabledTools)
			expect(() =>
				validateToolUse(
					"shadow_child_tool" as ToolName,
					codeMode,
					[],
					requirements,
					undefined,
					merged.experiments,
				),
			).toThrow(/Unknown tool/)
		} finally {
			customToolRegistry.clear()
		}
	})

	it("control: the same registered custom tool is callable without the child policy", () => {
		customToolRegistry.register({
			name: "shadow_child_tool",
			description: "test double",
			execute: async () => "ok",
		})
		try {
			expect(() =>
				validateToolUse("shadow_child_tool" as ToolName, codeMode, [], undefined, undefined, {
					customTools: true,
				}),
			).not.toThrow()
		} finally {
			customToolRegistry.clear()
		}
	})
})

describe("buildAutoDenyReason background_policy", () => {
	it("returns a non-empty denial that never suggests asking the user", () => {
		const reason = buildAutoDenyReason({ kind: "background_policy" })
		expect(reason.length).toBeGreaterThan(0)
		// The denial must steer the model to read-only tools and
		// attempt_completion, not back to a user prompt.
		expect(reason).not.toContain("ask the user")
		expect(reason).toContain("attempt_completion")
		expect(reason).toContain("read-only")
	})
})
