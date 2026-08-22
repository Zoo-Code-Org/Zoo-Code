import { ANTHROPIC_API_PROTOCOL, OPENAI_API_PROTOCOL, providerIdentifiers, providerNames } from "../index.js"
import {
	getApiProtocol,
	OPEN_AI_CODEX_SERVICE_TIER_KEY,
	PROVIDER_SETTINGS_KEYS,
	providerSettingsSchema,
	providerSettingsSchemaDiscriminated,
} from "../provider-settings.js"
import { OpenAiCodexServiceTier, OpenAiServiceTier } from "../model.js"
import { providerDefinitionList } from "../provider-settings/index.js"

describe("provider settings discriminated union", () => {
	it("composes exactly one provider-specific definition for every provider", () => {
		const registeredProviders = providerDefinitionList.map(({ apiProvider }) => apiProvider)

		expect([...registeredProviders].sort()).toEqual([...providerNames].sort())
		expect(new Set(registeredProviders).size).toBe(providerNames.length)
	})

	it.each(providerNames)("accepts the %s provider branch", (apiProvider) => {
		expect(providerSettingsSchemaDiscriminated.safeParse({ apiProvider }).success).toBe(true)
	})
})

describe("OpenAI-compatible extra body settings", () => {
	it("accepts a JSON object with provider-specific nested fields", () => {
		const settings = {
			apiProvider: providerIdentifiers.openai,
			openAiExtraBody: JSON.stringify({ metadata: { completion_window: "balanced" }, store: false }),
		}

		expect(providerSettingsSchemaDiscriminated.parse(settings)).toEqual(settings)
		expect(PROVIDER_SETTINGS_KEYS).toContain("openAiExtraBody")
	})

	it.each(["not json", "[]", "null", '"value"'])("rejects non-object JSON: %s", (openAiExtraBody) => {
		expect(
			providerSettingsSchemaDiscriminated.safeParse({
				apiProvider: providerIdentifiers.openai,
				openAiExtraBody,
			}).success,
		).toBe(false)
	})

	it.each(["model", "messages", "stream", "tools", "max_tokens", "__proto__"])(
		"rejects the reserved request key %s",
		(reservedKey) => {
			expect(
				providerSettingsSchemaDiscriminated.safeParse({
					apiProvider: providerIdentifiers.openai,
					openAiExtraBody: JSON.stringify({ [reservedKey]: "override" }),
				}).success,
			).toBe(false)
		},
	)
})

describe("OpenAI Codex provider settings", () => {
	it("preserves the Fast preference in general and provider-specific schemas", () => {
		const settings = {
			apiProvider: providerIdentifiers.openaiCodex,
			apiModelId: "gpt-5.6-sol",
			[OPEN_AI_CODEX_SERVICE_TIER_KEY]: OpenAiCodexServiceTier.Priority,
		}

		expect(providerSettingsSchema.parse(settings)).toEqual(settings)
		expect(providerSettingsSchemaDiscriminated.parse(settings)).toEqual(settings)
		expect(PROVIDER_SETTINGS_KEYS).toContain(OPEN_AI_CODEX_SERVICE_TIER_KEY)
	})

	it.each([undefined, OpenAiCodexServiceTier.Default])(
		"accepts %s as the Standard preference",
		(openAiCodexServiceTier) => {
			const standardSettings = {
				apiProvider: providerIdentifiers.openaiCodex,
				apiModelId: "gpt-5.6-sol",
				...(openAiCodexServiceTier ? { [OPEN_AI_CODEX_SERVICE_TIER_KEY]: openAiCodexServiceTier } : {}),
			}

			expect(providerSettingsSchemaDiscriminated.parse(standardSettings)).toEqual(standardSettings)
		},
	)

	it("rejects unsupported service tiers", () => {
		expect(
			providerSettingsSchemaDiscriminated.safeParse({
				apiProvider: providerIdentifiers.openaiCodex,
				apiModelId: "gpt-5.6-sol",
				[OPEN_AI_CODEX_SERVICE_TIER_KEY]: OpenAiServiceTier.Flex,
			}).success,
		).toBe(false)
	})
})

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
			expect(getApiProtocol(providerIdentifiers.opencodeGo, "qwen3.8-max")).toBe(ANTHROPIC_API_PROTOCOL)
			expect(getApiProtocol(providerIdentifiers.opencodeGo, "qwen3.7-max")).toBe(ANTHROPIC_API_PROTOCOL)
			expect(getApiProtocol(providerIdentifiers.opencodeGo, "qwen3.7-plus")).toBe(ANTHROPIC_API_PROTOCOL)
			expect(getApiProtocol(providerIdentifiers.opencodeGo, "qwen3.6-plus")).toBe(ANTHROPIC_API_PROTOCOL)
			expect(getApiProtocol(providerIdentifiers.opencodeGo, "minimax-m3")).toBe(ANTHROPIC_API_PROTOCOL)
			expect(getApiProtocol(providerIdentifiers.opencodeGo, "minimax-m2.7")).toBe(ANTHROPIC_API_PROTOCOL)
			expect(getApiProtocol(providerIdentifiers.opencodeGo, "minimax-m2.5")).toBe(ANTHROPIC_API_PROTOCOL)
		})

		it("should return 'openai' for opencode-go OpenAI-format models (GLM/DeepSeek/etc.)", () => {
			expect(getApiProtocol(providerIdentifiers.opencodeGo, "glm-5.3")).toBe(OPENAI_API_PROTOCOL)
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
