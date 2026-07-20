import { isLiteLLMPreserveReasoningModel, LITELLM_PRESERVE_REASONING_MODEL_IDS } from "../providers/lite-llm.js"

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
		expect(isLiteLLMPreserveReasoningModel("deepseek/deepseek-reasoner")).toBe(true)
		expect(isLiteLLMPreserveReasoningModel("bedrock/moonshot.kimi-k2-thinking")).toBe(true)
		expect(isLiteLLMPreserveReasoningModel("fireworks_ai/accounts/fireworks/models/kimi-k2p7-code")).toBe(true)
	})

	it("matches case-insensitively", () => {
		expect(isLiteLLMPreserveReasoningModel("MiniMax-M2.7-Highspeed")).toBe(true)
		expect(isLiteLLMPreserveReasoningModel("GLM-5.2")).toBe(true)
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
