import { ANTHROPIC_API_PROTOCOL, getApiProtocol, OPENAI_API_PROTOCOL, providerIdentifiers } from "../index.js"

describe("getApiProtocol", () => {
	it("preserves API protocol wire values", () => {
		expect(ANTHROPIC_API_PROTOCOL).toBe("anthropic")
		expect(OPENAI_API_PROTOCOL).toBe("openai")
	})

	describe("Anthropic-style providers", () => {
		it.each([providerIdentifiers.anthropic, providerIdentifiers.bedrock, providerIdentifiers.minimax])(
			"should return 'anthropic' for %s provider",
			(provider) => {
				expect(getApiProtocol(provider)).toBe(ANTHROPIC_API_PROTOCOL)
				expect(getApiProtocol(provider, "gpt-4")).toBe(ANTHROPIC_API_PROTOCOL)
			},
		)
	})

	describe("Vertex provider with Claude models", () => {
		it("should return 'anthropic' for vertex provider with claude models", () => {
			expect(getApiProtocol(providerIdentifiers.vertex, "claude-3-opus")).toBe(ANTHROPIC_API_PROTOCOL)
			expect(getApiProtocol(providerIdentifiers.vertex, "Claude-3-Sonnet")).toBe(ANTHROPIC_API_PROTOCOL)
			expect(getApiProtocol(providerIdentifiers.vertex, "CLAUDE-instant")).toBe(ANTHROPIC_API_PROTOCOL)
			expect(getApiProtocol(providerIdentifiers.vertex, "anthropic/claude-3-haiku")).toBe(ANTHROPIC_API_PROTOCOL)
		})

		it("should return 'openai' for vertex provider with non-claude models", () => {
			expect(getApiProtocol(providerIdentifiers.vertex, "gpt-4")).toBe(OPENAI_API_PROTOCOL)
			expect(getApiProtocol(providerIdentifiers.vertex, "gemini-pro")).toBe(OPENAI_API_PROTOCOL)
			expect(getApiProtocol(providerIdentifiers.vertex, "llama-2")).toBe(OPENAI_API_PROTOCOL)
		})

		it("should return 'openai' for vertex provider without model", () => {
			expect(getApiProtocol(providerIdentifiers.vertex)).toBe(OPENAI_API_PROTOCOL)
		})
	})

	describe("Gateway providers", () => {
		it("uses the canonical Zoo Gateway identifier for Anthropic model protocol selection", () => {
			expect(getApiProtocol(providerIdentifiers.zooGateway, "anthropic/claude-3-opus")).toBe(
				ANTHROPIC_API_PROTOCOL,
			)
		})

		it("should return 'anthropic' for vercel-ai-gateway provider with anthropic models", () => {
			expect(getApiProtocol(providerIdentifiers.vercelAiGateway, "anthropic/claude-3-opus")).toBe(
				ANTHROPIC_API_PROTOCOL,
			)
			expect(getApiProtocol(providerIdentifiers.vercelAiGateway, "anthropic/claude-3.5-sonnet")).toBe(
				ANTHROPIC_API_PROTOCOL,
			)
			expect(getApiProtocol(providerIdentifiers.vercelAiGateway, "ANTHROPIC/claude-sonnet-4")).toBe(
				ANTHROPIC_API_PROTOCOL,
			)
			expect(getApiProtocol(providerIdentifiers.vercelAiGateway, "anthropic/claude-opus-4.1")).toBe(
				ANTHROPIC_API_PROTOCOL,
			)
		})

		it("should return 'openai' for vercel-ai-gateway provider with non-anthropic models", () => {
			expect(getApiProtocol(providerIdentifiers.vercelAiGateway, "openai/gpt-4")).toBe(OPENAI_API_PROTOCOL)
			expect(getApiProtocol(providerIdentifiers.vercelAiGateway, "google/gemini-pro")).toBe(OPENAI_API_PROTOCOL)
			expect(getApiProtocol(providerIdentifiers.vercelAiGateway, "meta/llama-3")).toBe(OPENAI_API_PROTOCOL)
			expect(getApiProtocol(providerIdentifiers.vercelAiGateway, "mistral/mixtral")).toBe(OPENAI_API_PROTOCOL)
		})

		it("should return 'openai' for vercel-ai-gateway provider without model", () => {
			expect(getApiProtocol(providerIdentifiers.vercelAiGateway)).toBe(OPENAI_API_PROTOCOL)
		})
	})

	describe("Opencode Go provider", () => {
		it("should return 'anthropic' for opencode-go Anthropic-format models (Qwen/MiniMax)", () => {
			expect(getApiProtocol(providerIdentifiers.opencodeGo, "qwen3.7-max")).toBe(ANTHROPIC_API_PROTOCOL)
			expect(getApiProtocol(providerIdentifiers.opencodeGo, "qwen3.7-plus")).toBe(ANTHROPIC_API_PROTOCOL)
			expect(getApiProtocol(providerIdentifiers.opencodeGo, "qwen3.6-plus")).toBe(ANTHROPIC_API_PROTOCOL)
			expect(getApiProtocol(providerIdentifiers.opencodeGo, "minimax-m3")).toBe(ANTHROPIC_API_PROTOCOL)
			expect(getApiProtocol(providerIdentifiers.opencodeGo, "minimax-m2.7")).toBe(ANTHROPIC_API_PROTOCOL)
			expect(getApiProtocol(providerIdentifiers.opencodeGo, "minimax-m2.5")).toBe(ANTHROPIC_API_PROTOCOL)
		})

		it("should return 'openai' for opencode-go OpenAI-format models (GLM/DeepSeek/etc.)", () => {
			expect(getApiProtocol(providerIdentifiers.opencodeGo, "glm-5.2")).toBe(OPENAI_API_PROTOCOL)
			expect(getApiProtocol(providerIdentifiers.opencodeGo, "deepseek-v4-pro")).toBe(OPENAI_API_PROTOCOL)
			expect(getApiProtocol(providerIdentifiers.opencodeGo, "kimi-k2.5")).toBe(OPENAI_API_PROTOCOL)
			expect(getApiProtocol(providerIdentifiers.opencodeGo, "mimo-v2.5")).toBe(OPENAI_API_PROTOCOL)
		})

		it("should return 'openai' for opencode-go without a model", () => {
			expect(getApiProtocol(providerIdentifiers.opencodeGo)).toBe(OPENAI_API_PROTOCOL)
		})

		it("should return 'openai' for opencode-go with an unknown model id", () => {
			expect(getApiProtocol(providerIdentifiers.opencodeGo, "some-future-model")).toBe(OPENAI_API_PROTOCOL)
		})
	})

	describe("Other providers", () => {
		it("should return 'openai' for non-anthropic providers regardless of model", () => {
			expect(getApiProtocol(providerIdentifiers.openrouter, "claude-3-opus")).toBe(OPENAI_API_PROTOCOL)
			expect(getApiProtocol(providerIdentifiers.openai, "claude-3-sonnet")).toBe(OPENAI_API_PROTOCOL)
			expect(getApiProtocol(providerIdentifiers.litellm, "claude-instant")).toBe(OPENAI_API_PROTOCOL)
			expect(getApiProtocol(providerIdentifiers.ollama, "claude-model")).toBe(OPENAI_API_PROTOCOL)
		})
	})

	describe("Edge cases", () => {
		it("should return 'openai' when provider is undefined", () => {
			expect(getApiProtocol(undefined)).toBe(OPENAI_API_PROTOCOL)
			expect(getApiProtocol(undefined, "claude-3-opus")).toBe(OPENAI_API_PROTOCOL)
		})

		it("should handle empty strings", () => {
			expect(getApiProtocol(providerIdentifiers.vertex, "")).toBe(OPENAI_API_PROTOCOL)
		})

		it("should be case-insensitive for claude detection", () => {
			expect(getApiProtocol(providerIdentifiers.vertex, "CLAUDE-3-OPUS")).toBe(ANTHROPIC_API_PROTOCOL)
			expect(getApiProtocol(providerIdentifiers.vertex, "claude-3-opus")).toBe(ANTHROPIC_API_PROTOCOL)
			expect(getApiProtocol(providerIdentifiers.vertex, "ClAuDe-InStAnT")).toBe(ANTHROPIC_API_PROTOCOL)
		})
	})
})
