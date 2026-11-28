// npx vitest run src/core/tools/__tests__/parallelSubtasksExperimentGate.spec.ts

import type { ModeConfig } from "@roo-code/types"

import { BACKGROUND_CHILD_DISABLED_TOOLS } from "../../background-subtasks/policy"
import { buildToolRequirements } from "../../prompts/tools/effective-tool-policy"

import { isToolAllowedForMode, validateToolUse } from "../validateToolUse"

const restrictiveMode: ModeConfig = {
	slug: "restrictive",
	name: "Restrictive",
	roleDefinition: "No groups at all",
	groups: [],
}

describe("parallel_subtasks experiment gate", () => {
	describe("flag off", () => {
		it.each<[string, Record<string, boolean> | undefined]>([
			["omitted", undefined],
			["empty", {}],
			["explicitly off", { parallelSubtasks: false }],
		])("rejects the tool when experiments are %s", (_label, experiments) => {
			expect(isToolAllowedForMode("parallel_subtasks", "code", [], undefined, undefined, experiments)).toBe(false)
		})

		it("rejects the tool in every built-in mode", () => {
			for (const mode of ["architect", "code", "ask", "debug", "orchestrator"]) {
				expect(isToolAllowedForMode("parallel_subtasks", mode, [])).toBe(false)
			}
		})

		it("makes the execution-time validator throw the standard denial", () => {
			expect(() => validateToolUse("parallel_subtasks", "code", [])).toThrow(
				'Tool "parallel_subtasks" is not allowed in code mode.',
			)
		})
	})

	describe("flag on", () => {
		const on = { parallelSubtasks: true }

		it.each(["code", "debug", "architect"])("allows %s mode", (mode) => {
			expect(isToolAllowedForMode("parallel_subtasks", mode, [], undefined, undefined, on)).toBe(true)
		})

		it("allows a custom mode with no groups (always-available exposure)", () => {
			expect(
				isToolAllowedForMode(
					"parallel_subtasks",
					restrictiveMode.slug,
					[restrictiveMode],
					undefined,
					undefined,
					on,
				),
			).toBe(true)
		})

		it("does not throw in the execution-time validator", () => {
			expect(() => validateToolUse("parallel_subtasks", "code", [], undefined, undefined, on)).not.toThrow()
		})
	})

	describe("disabledTools precedence", () => {
		const on = { parallelSubtasks: true }

		it("rejects the tool when requirements name it, even with the flag on", () => {
			expect(
				isToolAllowedForMode("parallel_subtasks", "code", [], { parallel_subtasks: false }, undefined, on),
			).toBe(false)
		})

		it("does not let a true requirement grant the tool while the flag is off", () => {
			expect(
				isToolAllowedForMode("parallel_subtasks", "code", [], { parallel_subtasks: true }, undefined, {}),
			).toBe(false)
		})

		it("rejects the tool through the real background-child block list", () => {
			const requirements = buildToolRequirements([...BACKGROUND_CHILD_DISABLED_TOOLS])
			expect(isToolAllowedForMode("parallel_subtasks", "code", [], requirements, undefined, on)).toBe(false)
		})

		it("leaves every other always-available tool ungated", () => {
			expect(
				isToolAllowedForMode("new_task", restrictiveMode.slug, [restrictiveMode], undefined, undefined, {}),
			).toBe(true)
			expect(
				isToolAllowedForMode(
					"attempt_completion",
					restrictiveMode.slug,
					[restrictiveMode],
					undefined,
					undefined,
					{},
				),
			).toBe(true)
		})
	})
})
