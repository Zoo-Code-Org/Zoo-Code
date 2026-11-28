// npx vitest run src/core/prompts/tools/__tests__/parallel-subtasks-experiment-gate.spec.ts

import type OpenAI from "openai"
import { DEFAULT_MODES, type ModeConfig } from "@roo-code/types"

import { getToolsForMode } from "../../../../shared/modes"

import { getNativeTools } from "../native-tools"
import { filterNativeToolsForMode } from "../filter-tools-for-mode"
import { resolveEffectiveToolPolicy } from "../effective-tool-policy"

const ON = { parallelSubtasks: true }

function advertisedNames(tools: OpenAI.Chat.ChatCompletionTool[]): string[] {
	return tools.map((tool) => ("function" in tool && tool.function ? tool.function.name : ""))
}

function filter(experiments?: Record<string, boolean>, disabledTools?: string[]) {
	return filterNativeToolsForMode(getNativeTools(), "code", undefined, experiments, undefined, { disabledTools })
}

describe("parallel_subtasks prompt-layer gate", () => {
	describe("filterNativeToolsForMode", () => {
		it.each<[string, Record<string, boolean> | undefined]>([
			["omitted", undefined],
			["empty", {}],
			["explicitly off", { parallelSubtasks: false }],
		])("drops the definition when experiments are %s", (_label, experiments) => {
			const names = advertisedNames(filter(experiments))
			expect(names).not.toContain("parallel_subtasks")
			// Control: the filter is still admitting other always-available tools.
			expect(names).toContain("new_task")
		})

		it("advertises the definition when the flag is on", () => {
			expect(advertisedNames(filter(ON))).toContain("parallel_subtasks")
		})

		it("still drops the definition when disabledTools names it despite the flag", () => {
			expect(advertisedNames(filter(ON, ["parallel_subtasks"]))).not.toContain("parallel_subtasks")
		})
	})

	describe("resolveEffectiveToolPolicy", () => {
		it("excludes the tool from the effective set while the flag is off", () => {
			expect(resolveEffectiveToolPolicy({ mode: "code" }).tools.has("parallel_subtasks")).toBe(false)
			expect(resolveEffectiveToolPolicy({ mode: "code", experiments: {} }).tools.has("parallel_subtasks")).toBe(
				false,
			)
		})

		it("includes the tool for built-in modes when the flag is on", () => {
			for (const mode of ["code", "debug", "architect", "ask"]) {
				expect(resolveEffectiveToolPolicy({ mode, experiments: ON }).tools.has("parallel_subtasks")).toBe(true)
			}
		})

		it("includes the tool for a custom mode with no groups when the flag is on", () => {
			const customMode: ModeConfig = {
				slug: "empty-groups",
				name: "Empty",
				roleDefinition: "",
				groups: [],
			}
			const policy = resolveEffectiveToolPolicy({
				mode: "empty-groups",
				customModes: [customMode],
				experiments: ON,
			})
			expect(policy.tools.has("parallel_subtasks")).toBe(true)
		})
	})

	describe("getToolsForMode raw roster", () => {
		it("lists the tool unconditionally; the resolver is what applies the flag", () => {
			// The roster helper takes no experiments argument, so its one production
			// consumer (resolveEffectiveToolPolicy) has to be the gate. Pinning both
			// halves keeps a future caller from mistaking the raw list for the
			// advertised set.
			const codeMode = DEFAULT_MODES.find((mode) => mode.slug === "code")
			if (!codeMode) {
				throw new Error("code mode missing from DEFAULT_MODES")
			}
			expect(getToolsForMode(codeMode.groups)).toContain("parallel_subtasks")
			expect(resolveEffectiveToolPolicy({ mode: "code" }).tools.has("parallel_subtasks")).toBe(false)
		})
	})
})
