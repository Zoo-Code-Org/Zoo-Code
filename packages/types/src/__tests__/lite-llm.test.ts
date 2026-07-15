import { LITELLM_PRESERVE_REASONING_PATTERN } from "../providers/lite-llm.js"

describe("LITELLM_PRESERVE_REASONING_PATTERN", () => {
	it("matches known DeepSeek reasoning aliases", () => {
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("deepseek-v4-flash")).toBe(true)
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("deepseek-v4-pro")).toBe(true)
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("deepseek/deepseek-reasoner")).toBe(true)
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("deepseek-v4-mini")).toBe(false)
	})

	it("matches known MiMo reasoning aliases", () => {
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("mimo-v2.5")).toBe(true)
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("mimo-v2.5-pro")).toBe(true)
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("mimo-v2.6")).toBe(false)
	})

	it("matches known Kimi K2 reasoning aliases across routed providers", () => {
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("bedrock/moonshot.kimi-k2-thinking")).toBe(true)
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("fireworks_ai/accounts/fireworks/models/kimi-k2p7-code")).toBe(
			true,
		)
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("kimi-k2.7-code")).toBe(true)
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("kimi-k2.6")).toBe(false)
	})

	it("matches MiniMax M2/M3 aliases but not other MiniMax generations", () => {
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("minimax-m2")).toBe(true)
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("minimax.m3")).toBe(true)
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("minimax-m2.5")).toBe(true)
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("minimax-m2-highspeed")).toBe(true)
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("minimax-m2-stable")).toBe(true)
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("minimax-m4")).toBe(false)
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("minimax-m1")).toBe(false)
	})

	it("matches GLM-4.7 but excludes the flash variants", () => {
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("glm-4.7")).toBe(true)
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("glm-4.7-flash")).toBe(false)
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("glm-4.7-flashx")).toBe(false)
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("glm-4.8")).toBe(false)
	})

	it("matches GLM-5 variants but excludes the flash variant", () => {
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("glm-5")).toBe(true)
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("glm-5.1")).toBe(true)
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("glm-5.2")).toBe(true)
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("glm-5-turbo")).toBe(true)
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("glm-5.1-turbo")).toBe(true)
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("glm-5-flash")).toBe(false)
	})

	it("matches curated Qwen3 plus/max aliases used by opencode-go", () => {
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("qwen3.7-plus")).toBe(true)
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("qwen3.6-max")).toBe(true)
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("qwen3.5-plus")).toBe(false)
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("qwen3.7-mini")).toBe(false)
	})

	it("does not match unrelated model names", () => {
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("gpt-4")).toBe(false)
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("claude-3-opus")).toBe(false)
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("")).toBe(false)
	})

	it("matches when the fragment appears anywhere in a combined alias/routed-model string", () => {
		// Mirrors how litellm.ts calls it: `${modelName} ${litellmModelName}`
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("my-deepseek-alias deepseek/deepseek-reasoner")).toBe(true)
		expect(LITELLM_PRESERVE_REASONING_PATTERN.test("my-gpt4-alias openai/gpt-4")).toBe(false)
	})
})
