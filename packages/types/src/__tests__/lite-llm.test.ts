import {
	isLiteLLMPreserveReasoningModel,
	isLiteLLMThoughtSignatureModel,
	LITELLM_PRESERVE_REASONING_MODEL_IDS,
} from "../providers/lite-llm.js"

describe("LiteLLM preserveReasoning model detection", () => {
	it("matches every explicitly listed model id", () => {
		for (const modelId of LITELLM_PRESERVE_REASONING_MODEL_IDS) {
			expect(isLiteLLMPreserveReasoningModel(modelId)).toBe(true)
		}
	})

	it("does not contain duplicate model ids", () => {
		expect(new Set(LITELLM_PRESERVE_REASONING_MODEL_IDS).size).toBe(LITELLM_PRESERVE_REASONING_MODEL_IDS.length)
	})

	it("matches provider-prefixed routed model names by their final segment", () => {
		expect(isLiteLLMPreserveReasoningModel("kimi-k3")).toBe(true)
		expect(isLiteLLMPreserveReasoningModel("deepseek/deepseek-reasoner")).toBe(true)
		expect(isLiteLLMPreserveReasoningModel("bedrock/moonshot.kimi-k2-thinking")).toBe(true)
		expect(isLiteLLMPreserveReasoningModel("fireworks_ai/accounts/fireworks/models/kimi-k2p7-code")).toBe(true)
	})

	it("matches case-insensitively", () => {
		expect(isLiteLLMPreserveReasoningModel("MiniMax-M2.7-Highspeed")).toBe(true)
		expect(isLiteLLMPreserveReasoningModel("GLM-5.3")).toBe(true)
		expect(isLiteLLMPreserveReasoningModel("GLM-5.3-FLASH")).toBe(true)
		expect(isLiteLLMPreserveReasoningModel("QWEN3.8-MAX")).toBe(true)
	})

	it("does not match model ids that merely contain a known family as a substring", () => {
		expect(isLiteLLMPreserveReasoningModel("deepseek-v4-mini")).toBe(false)
		expect(isLiteLLMPreserveReasoningModel("mimo-v2.6")).toBe(false)
		expect(isLiteLLMPreserveReasoningModel("kimi-k2.6")).toBe(false)
		expect(isLiteLLMPreserveReasoningModel("kimi-k2.7-code")).toBe(false)
		expect(isLiteLLMPreserveReasoningModel("minimax-m4")).toBe(false)
		expect(isLiteLLMPreserveReasoningModel("minimax-m1")).toBe(false)
		expect(isLiteLLMPreserveReasoningModel("glm-4.7-flash")).toBe(false)
		expect(isLiteLLMPreserveReasoningModel("glm-4.7-flashx")).toBe(false)
		expect(isLiteLLMPreserveReasoningModel("glm-5-flash")).toBe(false)
		expect(isLiteLLMPreserveReasoningModel("glm-4.8")).toBe(false)
		expect(isLiteLLMPreserveReasoningModel("qwen3.5-plus")).toBe(false)
		expect(isLiteLLMPreserveReasoningModel("qwen3.7-mini")).toBe(false)
		expect(isLiteLLMPreserveReasoningModel("qwen3.6-max")).toBe(false)
	})

	it("does not match unrelated model names", () => {
		expect(isLiteLLMPreserveReasoningModel("gpt-4")).toBe(false)
		expect(isLiteLLMPreserveReasoningModel("claude-3-opus")).toBe(false)
		expect(isLiteLLMPreserveReasoningModel("")).toBe(false)
		expect(isLiteLLMPreserveReasoningModel(undefined)).toBe(false)
	})
})

describe("LiteLLM thought signature model detection", () => {
	it.each([
		"gemini-3-pro",
		"gemini-3-flash",
		"gemini-3.1-pro-preview",
		"gemini-2.5-pro",
		"gemini-4-pro",
		"Gemini 3 Pro",
		"gemini 2.5 flash",
		"google/gemini-3-pro",
		"vertex_ai/gemini-2.5-pro",
		"vertex_ai/gemini 2.5 pro",
		"gemini/gemini-4-flash",
	])("matches %s", (modelName) => {
		expect(isLiteLLMThoughtSignatureModel(modelName)).toBe(true)
	})

	it.each(["gpt-4", "claude-3-opus", "gemini-1.5-pro", "gemini-2.0-flash", "team-model", "", undefined])(
		"does not match %s",
		(modelName) => {
			expect(isLiteLLMThoughtSignatureModel(modelName)).toBe(false)
		},
	)
})
