// npx vitest src/core/prompts/tools/__tests__/parallel-subtasks-registration.spec.ts

import type OpenAI from "openai"
import { describe, it, expect } from "vitest"

import type { AssertEqual, Equals } from "@roo-code/types"
import { toolNames, toolNamesSchema } from "@roo-code/types"

import { ALWAYS_AVAILABLE_TOOLS, toolParamNames, type NativeToolArgs } from "../../../../shared/tools"
import { isToolAllowedForMode } from "../../../tools/validateToolUse"
import { BACKGROUND_CHILD_DISABLED_TOOLS } from "../../../background-subtasks/policy"
import { buildToolRequirements } from "../effective-tool-policy"
import { getNativeTools } from "../native-tools"
import parallelSubtasks from "../native-tools/parallel_subtasks"

// Compile-time only: `check-types` fails if the native args shape drifts from
// the contract the tool schema and the parser both implement.
type _AssertParallelSubtasksArgs = AssertEqual<
	Equals<NativeToolArgs["parallel_subtasks"], { tasks: Array<{ label?: string; mode: string; message: string }> }>
>

type FunctionTool = OpenAI.Chat.ChatCompletionFunctionTool

describe("parallel_subtasks registration surface", () => {
	describe("tool name enum", () => {
		it("registers the tool name and admits it through the schema", () => {
			expect(toolNames).toContain("parallel_subtasks")
			expect(toolNamesSchema.parse("parallel_subtasks")).toBe("parallel_subtasks")
		})

		it("advertises the tool in every mode", () => {
			expect(ALWAYS_AVAILABLE_TOOLS).toContain("parallel_subtasks")
		})

		it("registers the parameters the parser reads", () => {
			expect(toolParamNames).toContain("tasks")
			expect(toolParamNames).toContain("label")
		})
	})

	describe("native tool schema", () => {
		const fn = parallelSubtasks.function
		const tasksSchema = fn.parameters.properties.tasks

		it("declares the tool as a strict function", () => {
			expect(parallelSubtasks.type).toBe("function")
			expect(fn.name).toBe("parallel_subtasks")
			expect(fn.strict).toBe(true)
		})

		it("closes both object levels and requires the task list", () => {
			expect(fn.parameters.additionalProperties).toBe(false)
			expect(fn.parameters.required).toEqual(["tasks"])
			expect(tasksSchema.type).toBe("array")
			expect(tasksSchema.items.additionalProperties).toBe(false)
			// Strict schemas must require every declared property; an unused
			// label arrives as null rather than being omitted.
			expect(tasksSchema.items.required).toEqual(["label", "mode", "message"])
		})

		it("types label as nullable and mode/message as strings", () => {
			expect(tasksSchema.items.properties.label.type).toEqual(["string", "null"])
			expect(tasksSchema.items.properties.mode.type).toBe("string")
			expect(tasksSchema.items.properties.message.type).toBe("string")
		})

		it("states the read-only parallel report contract", () => {
			const description = fn.description
			expect(description).toMatch(/read-only/i)
			expect(description).toMatch(/parallel/i)
			expect(description).toMatch(/attempt_completion/)
			expect(description).toMatch(/\.md/)
			expect(description).toMatch(/label must be unique/i)
			expect(description).toMatch(/at most 6/i)
		})

		it("describes tasks[].label as optional with a default instead of required", () => {
			const description = fn.description
			expect(description).not.toMatch(/tasks\[\]\.label: \(required\)/)
			expect(description).toMatch(/tasks\[\]\.label: \(optional\)/)
			expect(description).toMatch(/defaults to child-N/i)
			const labelDescription = tasksSchema.items.properties.label.description
			expect(labelDescription).toMatch(/optional/i)
			expect(labelDescription).toMatch(/defaults to child-N/i)
		})
	})

	describe("getNativeTools", () => {
		it("includes the tool definition", () => {
			const names = getNativeTools()
				.filter((tool): tool is FunctionTool => tool.type === "function")
				.map((tool) => tool.function.name)
			expect(names).toContain("parallel_subtasks")
		})
	})

	describe("background child depth limit", () => {
		const childRequirements = buildToolRequirements([...BACKGROUND_CHILD_DISABLED_TOOLS])

		it("allows the tool for an ordinary code task once the experiment flag is on", () => {
			expect(isToolAllowedForMode("parallel_subtasks", "code", [], {}, {}, { parallelSubtasks: true })).toBe(true)
		})

		it("keeps the tool unavailable for an ordinary task while the flag is off", () => {
			expect(isToolAllowedForMode("parallel_subtasks", "code", [], {}, {}, {})).toBe(false)
			expect(isToolAllowedForMode("parallel_subtasks", "code", [], {}, {}, { parallelSubtasks: false })).toBe(
				false,
			)
		})

		it("blocks the tool for a background child despite the always-available class", () => {
			expect(childRequirements.parallel_subtasks).toBe(false)
			expect(isToolAllowedForMode("parallel_subtasks", "code", [], childRequirements, {}, {})).toBe(false)
		})

		it("keeps read-only tools outside the child block list allowed", () => {
			expect(isToolAllowedForMode("read_file", "code", [], childRequirements, {}, {})).toBe(true)
		})
	})
})
