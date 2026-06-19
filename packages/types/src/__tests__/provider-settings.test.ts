import { getApiProtocol } from "../provider-settings.js"

describe("getApiProtocol", () => {
	describe("Anthropic-style providers", () => {
		it("should return 'anthropic' for anthropic provider", () => {
			expect(getApiProtocol("anthropic")).toBe("anthropic")
			expect(getApiProtocol("anthropic", "gpt-4")).toBe("anthropic")
		})

		it("should return 'anthropic' for bedrock provider", () => {
			expect(getApiProtocol("bedrock")).toBe("anthropic")
			expect(getApiProtocol("bedrock", "gpt-4")).toBe("anthropic")
			expect(getApiProtocol("bedrock", "claude-3-opus")).toBe("anthropic")
		})
	})

	describe("Vertex provider with Claude models", () => {
		it("should return 'anthropic' for vertex provider with claude models", () => {
			expect(getApiProtocol("vertex", "claude-3-opus")).toBe("anthropic")
			expect(getApiProtocol("vertex", "Claude-3-Sonnet")).toBe("anthropic")
			expect(getApiProtocol("vertex", "CLAUDE-instant")).toBe("anthropic")
			expect(getApiProtocol("vertex", "anthropic/claude-3-haiku")).toBe("anthropic")
		})

		it("should return 'openai' for vertex provider with non-claude models", () => {
			expect(getApiProtocol("vertex", "gpt-4")).toBe("openai")
			expect(getApiProtocol("vertex", "gemini-pro")).toBe("openai")
			expect(getApiProtocol("vertex", "llama-2")).toBe("openai")
		})

		it("should return 'openai' for vertex provider without model", () => {
			expect(getApiProtocol("vertex")).toBe("openai")
		})
	})

	describe("Vercel AI Gateway provider", () => {
		it("should return 'anthropic' for vercel-ai-gateway provider with anthropic models", () => {
			expect(getApiProtocol("vercel-ai-gateway", "anthropic/claude-3-opus")).toBe("anthropic")
			expect(getApiProtocol("vercel-ai-gateway", "anthropic/claude-3.5-sonnet")).toBe("anthropic")
			expect(getApiProtocol("vercel-ai-gateway", "ANTHROPIC/claude-sonnet-4")).toBe("anthropic")
			expect(getApiProtocol("vercel-ai-gateway", "anthropic/claude-opus-4.1")).toBe("anthropic")
		})

		it("should return 'openai' for vercel-ai-gateway provider with non-anthropic models", () => {
			expect(getApiProtocol("vercel-ai-gateway", "openai/gpt-4")).toBe("openai")
			expect(getApiProtocol("vercel-ai-gateway", "google/gemini-pro")).toBe("openai")
			expect(getApiProtocol("vercel-ai-gateway", "meta/llama-3")).toBe("openai")
			expect(getApiProtocol("vercel-ai-gateway", "mistral/mixtral")).toBe("openai")
		})

		it("should return 'openai' for vercel-ai-gateway provider without model", () => {
			expect(getApiProtocol("vercel-ai-gateway")).toBe("openai")
		})
	})

	describe("Opencode Go provider", () => {
		it("should return 'anthropic' for opencode-go Anthropic-format models (Qwen/MiniMax)", () => {
			expect(getApiProtocol("opencode-go", "qwen3.7-max")).toBe("anthropic")
			expect(getApiProtocol("opencode-go", "qwen3.7-plus")).toBe("anthropic")
			expect(getApiProtocol("opencode-go", "qwen3.6-plus")).toBe("anthropic")
			expect(getApiProtocol("opencode-go", "minimax-m3")).toBe("anthropic")
			expect(getApiProtocol("opencode-go", "minimax-m2.7")).toBe("anthropic")
			expect(getApiProtocol("opencode-go", "minimax-m2.5")).toBe("anthropic")
		})

		it("should return 'openai' for opencode-go OpenAI-format models (GLM/DeepSeek/etc.)", () => {
			expect(getApiProtocol("opencode-go", "glm-5.2")).toBe("openai")
			expect(getApiProtocol("opencode-go", "deepseek-v4-pro")).toBe("openai")
			expect(getApiProtocol("opencode-go", "kimi-k2.5")).toBe("openai")
			expect(getApiProtocol("opencode-go", "mimo-v2.5")).toBe("openai")
		})

		it("should return 'openai' for opencode-go without a model", () => {
			expect(getApiProtocol("opencode-go")).toBe("openai")
		})

		it("should return 'openai' for opencode-go with an unknown model id", () => {
			expect(getApiProtocol("opencode-go", "some-future-model")).toBe("openai")
		})
	})

	describe("Other providers", () => {
		it("should return 'openai' for non-anthropic providers regardless of model", () => {
			expect(getApiProtocol("openrouter", "claude-3-opus")).toBe("openai")
			expect(getApiProtocol("openai", "claude-3-sonnet")).toBe("openai")
			expect(getApiProtocol("litellm", "claude-instant")).toBe("openai")
			expect(getApiProtocol("ollama", "claude-model")).toBe("openai")
		})
	})

	describe("Edge cases", () => {
		it("should return 'openai' when provider is undefined", () => {
			expect(getApiProtocol(undefined)).toBe("openai")
			expect(getApiProtocol(undefined, "claude-3-opus")).toBe("openai")
		})

		it("should handle empty strings", () => {
			expect(getApiProtocol("vertex", "")).toBe("openai")
		})

		it("should be case-insensitive for claude detection", () => {
			expect(getApiProtocol("vertex", "CLAUDE-3-OPUS")).toBe("anthropic")
			expect(getApiProtocol("vertex", "claude-3-opus")).toBe("anthropic")
			expect(getApiProtocol("vertex", "ClAuDe-InStAnT")).toBe("anthropic")
		})
	})
})
