import { ANTHROPIC_API_PROTOCOL, OPENAI_API_PROTOCOL, providerIdentifiers, providerNames } from "../index.js"
import {
	getApiProtocol,
	getProviderIsProxy,
	getProviderLabel,
	getProviderModels,
	getProviderServiceUrl,
	isProviderHidden,
	OPEN_AI_CODEX_SERVICE_TIER_KEY,
	parseOpenAiExtraBody,
	PROVIDER_SETTINGS_KEYS,
	providerSettingsSchema,
	providerSettingsSchemaDiscriminated,
	selectableProviders,
} from "../provider-settings.js"
import { OpenAiCodexServiceTier, OpenAiServiceTier } from "../model.js"
import { anthropicModels } from "../providers/index.js"
import { providerDefinitionList } from "../providers/index.js"

describe("provider settings discriminated union", () => {
	it("composes exactly one provider-specific definition for every provider", () => {
		const registeredProviders = providerDefinitionList.map(({ apiProvider }) => apiProvider)

		expect([...registeredProviders].sort()).toEqual([...providerNames].sort())
		expect(new Set(registeredProviders).size).toBe(providerNames.length)
	})

	it.each(providerDefinitionList.map((definition) => definition.apiProvider))(
		"exposes a default model accessor for %s",
		(apiProvider) => {
			const definition = providerDefinitionList.find((candidate) => candidate.apiProvider === apiProvider)

			expect(typeof definition?.getDefaultModelId).toBe("function")
			expect(typeof definition?.getDefaultModelId({})).toBe("string")
		},
	)

	it.each(providerNames)("accepts the %s provider branch", (apiProvider) => {
		expect(providerSettingsSchemaDiscriminated.safeParse({ apiProvider }).success).toBe(true)
	})
})

describe("provider definition metadata", () => {
	it.each(providerDefinitionList.map((definition) => definition.apiProvider))(
		"declares a non-empty label for %s",
		(apiProvider) => {
			expect(typeof getProviderLabel(apiProvider)).toBe("string")
			expect(getProviderLabel(apiProvider).length).toBeGreaterThan(0)
		},
	)

	it.each(providerDefinitionList.map((definition) => definition.apiProvider))(
		"declares a string service URL for %s",
		(apiProvider) => {
			expect(typeof getProviderServiceUrl(apiProvider)).toBe("string")
		},
	)

	it("declares an absolute service URL whenever one is provided", () => {
		for (const definition of providerDefinitionList) {
			if (definition.serviceUrl) {
				expect(definition.serviceUrl).toMatch(/^https:\/\//)
			}
		}
	})

	it("returns the declared label rather than the raw identifier", () => {
		expect(getProviderLabel(providerIdentifiers.anthropic)).toBe("Anthropic")
		expect(getProviderLabel(providerIdentifiers.openaiCodex)).toBe("OpenAI - ChatGPT Plus/Pro")
	})

	it("falls back to the identifier for an unregistered provider", () => {
		expect(getProviderLabel("unregistered-provider" as (typeof providerNames)[number])).toBe(
			"unregistered-provider",
		)
	})

	it("returns the declared service URL rather than a UI-side registry", () => {
		expect(getProviderServiceUrl(providerIdentifiers.anthropic)).toBe("https://console.anthropic.com")
		expect(getProviderServiceUrl(providerIdentifiers.bedrock)).toBe("https://aws.amazon.com/bedrock")
		expect(getProviderServiceUrl(providerIdentifiers.vscodeLm)).toBe(
			"https://code.visualstudio.com/api/extension-guides/language-model",
		)
	})

	it("returns an empty service URL for a provider without a console", () => {
		expect(getProviderServiceUrl(providerIdentifiers.openai)).toBe("")
		expect(getProviderServiceUrl(providerIdentifiers.openrouter)).toBe("")
	})

	it("returns an empty service URL for an unregistered provider", () => {
		expect(getProviderServiceUrl("unregistered-provider" as (typeof providerNames)[number])).toBe("")
	})

	it("returns the provider's static catalog", () => {
		expect(getProviderModels(providerIdentifiers.anthropic)).toBe(anthropicModels)
		expect(getProviderModels(providerIdentifiers.anthropic)).toHaveProperty("claude-sonnet-4-5")
	})

	it.each([
		providerIdentifiers.openrouter,
		providerIdentifiers.ollama,
		providerIdentifiers.lmstudio,
		providerIdentifiers.openai,
		providerIdentifiers.fakeAi,
		providerIdentifiers.geminiCli,
	])("returns an empty catalog for the runtime-discovered provider %s", (provider) => {
		expect(getProviderModels(provider)).toEqual({})
	})

	it.each([
		providerIdentifiers.openai,
		providerIdentifiers.litellm,
		providerIdentifiers.ollama,
		providerIdentifiers.lmstudio,
	])("marks the user-configured proxy provider %s as a proxy", (provider) => {
		expect(getProviderIsProxy(provider)).toBe(true)
	})

	it.each([
		providerIdentifiers.anthropic,
		providerIdentifiers.openrouter,
		providerIdentifiers.gemini,
		providerIdentifiers.bedrock,
	])("does not mark the vendor-hosted provider %s as a proxy", (provider) => {
		expect(getProviderIsProxy(provider)).toBe(false)
	})

	it("treats an unregistered provider as neither a proxy nor hidden", () => {
		const unregistered = "unregistered-provider" as (typeof providerNames)[number]

		expect(getProviderIsProxy(unregistered)).toBe(false)
		expect(isProviderHidden(unregistered)).toBe(false)
	})

	it.each([providerIdentifiers.geminiCli, providerIdentifiers.fakeAi])(
		"hides the non-selectable provider %s from the settings UI",
		(provider) => {
			expect(isProviderHidden(provider)).toBe(true)
		},
	)

	it.each([
		providerIdentifiers.anthropic,
		providerIdentifiers.openrouter,
		providerIdentifiers.openai,
		providerIdentifiers.ollama,
	])("keeps the selectable provider %s visible in the settings UI", (provider) => {
		expect(isProviderHidden(provider)).toBe(false)
	})
})

describe("selectableProviders", () => {
	it("offers exactly the non-hidden provider definitions", () => {
		const expected = providerDefinitionList
			.filter((definition) => !definition.hidden)
			.map((definition) => definition.apiProvider)
			.sort()

		expect(selectableProviders.map(({ value }) => value).sort()).toEqual(expected)
	})

	it.each([providerIdentifiers.geminiCli, providerIdentifiers.fakeAi])("omits the hidden provider %s", (provider) => {
		expect(selectableProviders.map(({ value }) => value)).not.toContain(provider)
	})

	it("sorts providers by label", () => {
		const labels = selectableProviders.map(({ label }) => label)

		expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)))
	})

	it("derives every label and proxy flag from the provider definition", () => {
		for (const { value, label, isProxy } of selectableProviders) {
			expect(label).toBe(getProviderLabel(value))
			expect(isProxy).toBe(getProviderIsProxy(value))
		}
	})

	it("marks only the user-configured proxy providers as proxy", () => {
		const proxyValues = selectableProviders.filter(({ isProxy }) => isProxy).map(({ value }) => value)

		expect(new Set(proxyValues)).toEqual(
			new Set([
				providerIdentifiers.openai,
				providerIdentifiers.lmstudio,
				providerIdentifiers.ollama,
				providerIdentifiers.litellm,
			]),
		)
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

	it.each([
		"__proto__",
		"constructor",
		"prototype",
		"max_completion_tokens",
		"max_tokens",
		"messages",
		"model",
		"parallel_tool_calls",
		"reasoning",
		"reasoning_effort",
		"response_format",
		"stream",
		"stream_options",
		"temperature",
		"tool_choice",
		"tools",
	])("rejects the reserved extra-body key %s", (reservedKey) => {
		expect(
			providerSettingsSchemaDiscriminated.safeParse({
				apiProvider: providerIdentifiers.openai,
				openAiExtraBody: JSON.stringify({ [reservedKey]: "override" }),
			}).success,
		).toBe(false)
	})

	it("reports and filters reserved keys while preserving allowed nested fields", () => {
		const result = parseOpenAiExtraBody(
			JSON.stringify({
				metadata: { completion_window: "balanced" },
				model: "overridden-model",
				response_format: { type: "json_object" },
				stream: false,
			}),
		)

		expect(result).toEqual({
			success: false,
			reason: "reservedKeys",
			reservedKeys: ["model", "response_format", "stream"],
			data: { metadata: { completion_window: "balanced" } },
		})
	})

	it("accepts stop and n as provider-specific request fields", () => {
		const settings = {
			apiProvider: providerIdentifiers.openai,
			openAiExtraBody: JSON.stringify({ stop: ["DONE"], n: 2 }),
		}

		expect(providerSettingsSchemaDiscriminated.parse(settings)).toEqual(settings)
		expect(parseOpenAiExtraBody(settings.openAiExtraBody)).toEqual({
			success: true,
			data: { stop: ["DONE"], n: 2 },
		})
	})
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
