// npx vitest run src/core/prompts/tools/__tests__/filter-thinking-effort.spec.ts
//
// DTE series 3/5 — set_thinking_effort task-start gating: experiment flag
// AND model capability, stable tool list within a task.

import { describe, it, expect } from "vitest"
import type OpenAI from "openai"
import type { ModelInfo } from "@roo-code/types"

import { filterNativeToolsForMode, isSetThinkingEffortEnabled, isToolAllowedInMode } from "../filter-tools-for-mode"

import { getNativeTools } from "../native-tools/index"

function makeTool(name: string): OpenAI.Chat.ChatCompletionTool {
	return {
		type: "function",
		function: {
			name,
			description: name + " tool",
			parameters: { type: "object", properties: {} },
		},
	} as OpenAI.Chat.ChatCompletionTool
}

/** Minimal ModelInfo (contextWindow + supportsPromptCache are the only required fields). */
function modelInfo(supportsReasoningEffort: ModelInfo["supportsReasoningEffort"]): ModelInfo {
	return { contextWindow: 1, supportsPromptCache: false, supportsReasoningEffort }
}

const TOOLS = [makeTool("execute_command"), makeTool("set_thinking_effort")]

function toolNames(tools: OpenAI.Chat.ChatCompletionTool[]): string[] {
	// The union also includes custom tools (no .function); only function tools carry names.
	return tools.flatMap((t) => (t.type === "function" ? [t.function.name] : []))
}

describe("isSetThinkingEffortEnabled", () => {
	it("is false when the experiment is off, even with capability", () => {
		expect(isSetThinkingEffortEnabled({ dynamicThinkingEffort: false }, modelInfo(["low", "high"]))).toBe(false)
		expect(isSetThinkingEffortEnabled(undefined, modelInfo(["low", "high"]))).toBe(false)
	})

	it("is false when the model lacks per-request effort support", () => {
		expect(isSetThinkingEffortEnabled({ dynamicThinkingEffort: true }, undefined)).toBe(false)
		expect(isSetThinkingEffortEnabled({ dynamicThinkingEffort: true }, modelInfo(false))).toBe(false)
		expect(isSetThinkingEffortEnabled({ dynamicThinkingEffort: true }, modelInfo([]))).toBe(false)
	})

	it("is true for a capability array or boolean support", () => {
		expect(isSetThinkingEffortEnabled({ dynamicThinkingEffort: true }, modelInfo(["low", "high"]))).toBe(true)
		expect(isSetThinkingEffortEnabled({ dynamicThinkingEffort: true }, modelInfo(true))).toBe(true)
	})
})

describe("filterNativeToolsForMode set_thinking_effort gate", () => {
	it("removes the tool when the experiment is off", () => {
		const result = filterNativeToolsForMode(TOOLS, "code", undefined, { dynamicThinkingEffort: false }, undefined, {
			modelInfo: modelInfo(["low", "high"]),
		})
		expect(toolNames(result)).not.toContain("set_thinking_effort")
		expect(toolNames(result)).toContain("execute_command")
	})

	it("keeps the tool when experiment on and model supports effort", () => {
		const result = filterNativeToolsForMode(TOOLS, "code", undefined, { dynamicThinkingEffort: true }, undefined, {
			modelInfo: modelInfo(["low", "high"]),
		})
		expect(toolNames(result)).toContain("set_thinking_effort")
	})

	it("removes the tool when the model does not support effort", () => {
		const result = filterNativeToolsForMode(TOOLS, "code", undefined, { dynamicThinkingEffort: true }, undefined, {
			modelInfo: modelInfo(false),
		})
		expect(toolNames(result)).not.toContain("set_thinking_effort")
	})

	it("keeps the tool list stable across repeated calls (prompt-cache safety)", () => {
		const experiments = { dynamicThinkingEffort: true }
		const settings = { modelInfo: modelInfo(["low", "high"]) }
		const a = filterNativeToolsForMode(TOOLS, "code", undefined, experiments, undefined, settings)
		const b = filterNativeToolsForMode(TOOLS, "code", undefined, experiments, undefined, settings)
		expect(toolNames(a)).toEqual(toolNames(b))
	})
})

describe("getNativeTools — set_thinking_effort schema", () => {
	it("exposes the tool with strict effort + reason parameters", () => {
		const schema = getNativeTools().find((t) => t.type === "function" && t.function.name === "set_thinking_effort")
		if (!schema || schema.type !== "function") {
			expect(schema).toBeDefined()
			return
		}
		expect(schema.function.strict).toBe(true)
		const parameters = schema.function.parameters as {
			required?: string[]
			properties?: Record<string, { type?: string }>
		}
		expect(parameters.required).toEqual(["effort", "reason"])
		expect(parameters.properties?.effort?.type).toBe("string")
		expect(parameters.properties?.reason?.type).toBe("string")
		expect(schema.function.description).toContain("no user approval")
	})
})

describe("isToolAllowedInMode — set_thinking_effort gate (prompt-side)", () => {
	it("allows the tool only when the experiment is on and the model supports effort", () => {
		const settings = { modelInfo: modelInfo(["low", "high"]) }
		expect(
			isToolAllowedInMode(
				"set_thinking_effort",
				"code",
				undefined,
				{ dynamicThinkingEffort: true },
				undefined,
				settings,
			),
		).toBe(true)
		expect(
			isToolAllowedInMode(
				"set_thinking_effort",
				"code",
				undefined,
				{ dynamicThinkingEffort: false },
				undefined,
				settings,
			),
		).toBe(false)
		expect(
			isToolAllowedInMode("set_thinking_effort", "code", undefined, { dynamicThinkingEffort: true }, undefined, {
				modelInfo: modelInfo(false),
			}),
		).toBe(false)
		// Other always-available tools remain unconditional.
		expect(isToolAllowedInMode("execute_command", "code", undefined, undefined, undefined, undefined)).toBe(true)
	})
})
