// pnpm --filter roo-cline test api/providers/__tests__/openrouter.spec.ts

vitest.mock("vscode", () => ({
	workspace: {
		getConfiguration: () => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
		}),
	},
}))

vitest.mock("../utils/timeout-config", () => ({
	getApiRequestTimeout: vitest.fn().mockReturnValue(300_000),
}))

const MOCK_TIMEOUT_MS = 300_000

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import {
	OPENROUTER_DEFAULT_PROVIDER_NAME,
	openRouterDefaultModelInfo,
	providerIdentifiers,
	type ModelRecord,
} from "@roo-code/types"
import type { ModelInfo } from "@roo-code/types"

import { applyOpenRouterMoonshotK3Profile } from "../fetchers/openrouter"

import { OpenRouterHandler } from "../openrouter"
import { Package } from "../../../shared/package"
import { makeApiHandlerOptions, makeCreateMessageMetadata } from "../../../test-utils/api"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { collectStreamAndParseToolCalls } from "../../../test-utils/native-tool-call-stream"
import { clearAllMocks } from "../../../test-utils/reset"
import { settlesWithin } from "../../../test-utils/promise"

vitest.mock("openai")
vitest.mock("delay", () => ({
	default: vitest.fn(function () {
		return Promise.resolve()
	}),
}))

const mockCaptureException = vitest.fn()

vitest.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureException: (...args: unknown[]) => mockCaptureException(...args),
		},
	},
}))

const { mockGetModelEndpoints } = vitest.hoisted(() => ({
	mockGetModelEndpoints: vitest.fn(),
}))

vitest.mock("../fetchers/modelEndpointCache", () => ({
	getModelEndpoints: mockGetModelEndpoints,
}))

vitest.mock("../fetchers/modelCache", () => ({
	getModels: vitest.fn().mockImplementation(function () {
		return Promise.resolve({
			"anthropic/claude-sonnet-4": {
				maxTokens: 8192,
				contextWindow: 200000,
				supportsImages: true,
				supportsPromptCache: true,
				inputPrice: 3,
				outputPrice: 15,
				cacheWritesPrice: 3.75,
				cacheReadsPrice: 0.3,
				description: "Claude 3.7 Sonnet",
				thinking: false,
			},
			"anthropic/claude-sonnet-4.5": {
				maxTokens: 8192,
				contextWindow: 200000,
				supportsImages: true,
				supportsPromptCache: true,
				inputPrice: 3,
				outputPrice: 15,
				cacheWritesPrice: 3.75,
				cacheReadsPrice: 0.3,
				description: "Claude 4.5 Sonnet",
				thinking: false,
			},
			"anthropic/claude-3.7-sonnet:thinking": {
				maxTokens: 128000,
				contextWindow: 200000,
				supportsImages: true,
				supportsPromptCache: true,
				inputPrice: 3,
				outputPrice: 15,
				cacheWritesPrice: 3.75,
				cacheReadsPrice: 0.3,
				description: "Claude 3.7 Sonnet with thinking",
			},
			"openai/gpt-4o": {
				maxTokens: 16384,
				contextWindow: 128000,
				supportsImages: true,
				supportsPromptCache: false,
				inputPrice: 2.5,
				outputPrice: 10,
				description: "GPT-4o",
			},
			"openai/o1": {
				maxTokens: 100000,
				contextWindow: 200000,
				supportsImages: true,
				supportsPromptCache: false,
				inputPrice: 15,
				outputPrice: 60,
				description: "OpenAI o1",
				excludedTools: ["existing_excluded"],
				includedTools: ["existing_included"],
			},
			// Stale cache record simulating what users cached before the Moonshot K3
			// profile existed: the fabricated 0.2 context-window max_tokens and a
			// boolean supportsReasoningEffort with no default effort.
			"moonshotai/kimi-k3": {
				maxTokens: 209716,
				contextWindow: 1000000,
				supportsImages: true,
				supportsPromptCache: true,
				inputPrice: 0.6,
				outputPrice: 3,
				description: "Kimi K3",
				supportsReasoningEffort: true,
			},
		})
	}),
	refreshModels: vitest.fn(async (options, handler) => {
		const { getModels } = await import("../fetchers/modelCache")
		return getModels(options, handler)
	}),
}))

const ABORT_SETTLE_MS = 150

describe("OpenRouterHandler", () => {
	const mockOptions = makeApiHandlerOptions({
		openRouterApiKey: "test-key",
		openRouterModelId: "anthropic/claude-sonnet-4",
	})

	beforeEach(() => {
		clearAllMocks()
		// Endpoint records default to "not fetched" (same as the real guard for
		// missing options); tests that exercise the specific-provider branch
		// override this per test.
		mockGetModelEndpoints.mockResolvedValue({})
	})

	it("initializes with correct options", () => {
		const handler = new OpenRouterHandler(mockOptions)
		expect(handler).toBeInstanceOf(OpenRouterHandler)

		expect(OpenAI).toHaveBeenCalledWith({
			baseURL: "https://openrouter.ai/api/v1",
			apiKey: mockOptions.openRouterApiKey,
			defaultHeaders: {
				"HTTP-Referer": "https://github.com/Zoo-Code-Org/Zoo-Code",
				"X-Title": "Zoo Code",
				"User-Agent": `ZooCode/${Package.version}`,
			},
			timeout: MOCK_TIMEOUT_MS,
		})
	})

	describe("fetchModel", () => {
		it("returns correct model info when options are provided", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const result = await handler.fetchModel()

			expect(result).toMatchObject({
				id: mockOptions.openRouterModelId,
				maxTokens: 8192,
				temperature: 0,
				reasoningEffort: undefined,
				topP: undefined,
			})
		})

		it("returns default model info when options are not provided", async () => {
			const handler = new OpenRouterHandler({})
			const result = await handler.fetchModel()
			expect(result.id).toBe("anthropic/claude-sonnet-4.5")
			expect(result.info.supportsPromptCache).toBe(true)
		})

		it("honors custom maxTokens for thinking models", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					openRouterApiKey: "test-key",
					openRouterModelId: "anthropic/claude-3.7-sonnet:thinking",
					modelMaxTokens: 32_768,
					modelMaxThinkingTokens: 16_384,
				}),
			)

			const result = await handler.fetchModel()
			// With the new clamping logic, 128000 tokens (64% of 200000 context window)
			// gets clamped to 20% of context window: 200000 * 0.2 = 40000
			expect(result.maxTokens).toBe(40000)
			expect(result.reasoningBudget).toBeUndefined()
			expect(result.temperature).toBe(0)
		})

		it("does not honor custom maxTokens for non-thinking models", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					modelMaxTokens: 32_768,
					modelMaxThinkingTokens: 16_384,
				}),
			)

			const result = await handler.fetchModel()
			expect(result.maxTokens).toBe(8192)
			expect(result.reasoningBudget).toBeUndefined()
			expect(result.temperature).toBe(0)
		})

		it("adds excludedTools and includedTools for OpenAI models", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					openRouterApiKey: "test-key",
					openRouterModelId: "openai/gpt-4o",
				}),
			)

			const result = await handler.fetchModel()
			expect(result.id).toBe("openai/gpt-4o")
			expect(result.info.excludedTools).toContain("apply_diff")
			expect(result.info.excludedTools).toContain("write_to_file")
			expect(result.info.includedTools).toContain("apply_patch")
		})

		it("merges excludedTools and includedTools with existing values for OpenAI models", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					openRouterApiKey: "test-key",
					openRouterModelId: "openai/o1",
				}),
			)

			const result = await handler.fetchModel()
			expect(result.id).toBe("openai/o1")
			// Should have the new exclusions
			expect(result.info.excludedTools).toContain("apply_diff")
			expect(result.info.excludedTools).toContain("write_to_file")
			// Should preserve existing exclusions
			expect(result.info.excludedTools).toContain("existing_excluded")
			// Should have the new inclusions
			expect(result.info.includedTools).toContain("apply_patch")
			// Should preserve existing inclusions
			expect(result.info.includedTools).toContain("existing_included")
		})

		it("does not add excludedTools or includedTools for non-OpenAI models", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					openRouterApiKey: "test-key",
					openRouterModelId: "anthropic/claude-sonnet-4",
				}),
			)

			const result = await handler.fetchModel()
			expect(result.id).toBe("anthropic/claude-sonnet-4")
			// Should NOT have the tool exclusions/inclusions
			expect(result.info.excludedTools).toBeUndefined()
			expect(result.info.includedTools).toBeUndefined()
		})

		it("applies the Moonshot K3 profile to stale cached model info", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					openRouterApiKey: "test-key",
					openRouterModelId: "moonshotai/kimi-k3",
				}),
			)

			const result = await handler.fetchModel()

			// The stale cache record carried a fabricated max_tokens (209716) and a
			// boolean supportsReasoningEffort with no default effort; the profile must
			// correct all of that before any request parameters are derived.
			expect(result.id).toBe("moonshotai/kimi-k3")
			expect(result.maxTokens).toBe(32768)
			expect(result.temperature).toBe(1)
			expect(result.reasoningEffort).toBe("high")
			expect(result.reasoning).toEqual({ effort: "high" })
			expect(result.info.maxTokens).toBe(32768)
			expect(result.info.supportsReasoningEffort).toEqual(["low", "high", "max"])
			expect(result.info.reasoningEffort).toBe("high")
			expect(result.info.supportsTemperature).toBe(true)
			expect(result.info.defaultTemperature).toBe(1)
		})

		it("applies the Moonshot K3 profile to a stale specific-provider endpoint record", async () => {
			// Endpoint records are cached separately from the parent model cache and
			// are selected before the profile is applied. A stale endpoint record
			// (fabricated max_tokens, boolean supportsReasoningEffort, no reasoning
			// default, no temperature default) must be corrected for the selected
			// endpoint.
			mockGetModelEndpoints.mockResolvedValue({
				moonshotai: {
					maxTokens: 209716,
					contextWindow: 1000000,
					supportsImages: true,
					supportsPromptCache: true,
					inputPrice: 0.6,
					outputPrice: 3,
					description: "Kimi K3 (Moonshot endpoint)",
					supportsReasoningEffort: true,
				},
			})

			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					openRouterApiKey: "test-key",
					openRouterModelId: "moonshotai/kimi-k3",
					openRouterSpecificProvider: "moonshotai",
				}),
			)

			const result = await handler.fetchModel()

			// The selected endpoint record (not the parent model cache entry) must be
			// profiled: a regression that applied the profile before endpoint
			// selection would send the stale endpoint values.
			expect(result.id).toBe("moonshotai/kimi-k3")
			expect(result.info.maxTokens).toBe(32768)
			expect(result.info.supportsReasoningEffort).toEqual(["low", "high", "max"])
			expect(result.info.reasoningEffort).toBe("high")
			expect(result.info.supportsTemperature).toBe(true)
			expect(result.info.defaultTemperature).toBe(1)
			expect(result.maxTokens).toBe(32768)
			expect(result.temperature).toBe(1)
			expect(result.reasoningEffort).toBe("high")
			expect(result.reasoning).toEqual({ effort: "high" })
		})

		it("keeps the newest lookup's records when an older lookup settles last", async () => {
			// Two lookups overlap (a second request, or a lookup whose request was
			// cancelled). The first started but settles last; publishing its records
			// would roll pricing and limits back to an older fetch.
			const { getModels } = await import("../fetchers/modelCache")
			const mockedGetModels = vitest.mocked(getModels)
			let releaseFirst!: () => void
			let releaseSecond!: () => void
			const firstGate = new Promise<void>((resolve) => {
				releaseFirst = resolve
			})
			const secondGate = new Promise<void>((resolve) => {
				releaseSecond = resolve
			})
			mockedGetModels
				.mockImplementationOnce(async () => {
					await firstGate
					return {
						"anthropic/claude-sonnet-4": { ...openRouterDefaultModelInfo, maxTokens: 111 },
					}
				})
				.mockImplementationOnce(async () => {
					await secondGate
					return {
						"anthropic/claude-sonnet-4": { ...openRouterDefaultModelInfo, maxTokens: 222 },
					}
				})

			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					openRouterApiKey: "test-key",
					openRouterModelId: "anthropic/claude-sonnet-4",
				}),
			)

			const first = handler.fetchModel()
			const second = handler.fetchModel()

			releaseSecond()
			await second
			releaseFirst()
			await first

			expect(handler.getModel().info.maxTokens).toBe(222)
		})

		it("keeps the previous endpoint records when a newer endpoint lookup returns none", async () => {
			mockGetModelEndpoints
				.mockResolvedValueOnce({
					"provider-x": { ...openRouterDefaultModelInfo, maxTokens: 333 },
				})
				// A failed endpoint fetch answers an empty map.
				.mockResolvedValueOnce({})

			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					openRouterApiKey: "test-key",
					openRouterModelId: "anthropic/claude-sonnet-4",
					openRouterSpecificProvider: "provider-x",
				}),
			)

			await handler.fetchModel()
			expect(handler.getModel().info.maxTokens).toBe(333)

			// The newer lookup saw no endpoints: the records from the successful one must survive,
			// otherwise the pricing and limits fall back to the base catalogue entry.
			await handler.fetchModel()
			expect(handler.getModel().info.maxTokens).toBe(333)
		})

		it("publishes endpoint records even when the model catalog came back empty", async () => {
			// A catalog miss must not discard endpoint data: the endpoint lookup carries the
			// pricing and limits for the selected provider, and getModel() prefers the endpoint
			// record over the (now missing) catalog entry.
			const { getModels } = await import("../fetchers/modelCache")
			vitest.mocked(getModels).mockResolvedValueOnce({})
			mockGetModelEndpoints.mockResolvedValueOnce({
				"provider-x": { ...openRouterDefaultModelInfo, maxTokens: 444 },
			})

			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					openRouterApiKey: "test-key",
					openRouterModelId: "anthropic/claude-sonnet-4",
					openRouterSpecificProvider: "provider-x",
				}),
			)

			await handler.fetchModel()

			expect(handler.getModel().info.maxTokens).toBe(444)
		})

		it("does not let an older endpoint answer replace a newer one when both catalogs are empty", async () => {
			// With no models to publish, the model sequence never advances, so endpoint ordering
			// needs its own sequence: without it the slower, older lookup would overwrite the
			// endpoint records the newer lookup already installed.
			const { getModels } = await import("../fetchers/modelCache")
			const mockedGetModels = vitest.mocked(getModels)
			mockedGetModels.mockResolvedValueOnce({}).mockResolvedValueOnce({})

			let releaseFirst!: () => void
			let releaseSecond!: () => void
			const firstGate = new Promise<void>((resolve) => {
				releaseFirst = resolve
			})
			const secondGate = new Promise<void>((resolve) => {
				releaseSecond = resolve
			})
			mockGetModelEndpoints
				.mockImplementationOnce(async () => {
					await firstGate
					return { "provider-x": { ...openRouterDefaultModelInfo, maxTokens: 111 } }
				})
				.mockImplementationOnce(async () => {
					await secondGate
					return { "provider-x": { ...openRouterDefaultModelInfo, maxTokens: 222 } }
				})

			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					openRouterApiKey: "test-key",
					openRouterModelId: "anthropic/claude-sonnet-4",
					openRouterSpecificProvider: "provider-x",
				}),
			)

			const first = handler.fetchModel()
			const second = handler.fetchModel()

			releaseSecond()
			await second
			releaseFirst()
			await first

			expect(handler.getModel().info.maxTokens).toBe(222)
		})

		it("keeps an older endpoint answer when a newer lookup publishes models without endpoints", async () => {
			// The endpoint sequence advances only when endpoints publish, so a newer lookup that
			// failed its endpoint fetch must not freeze the ordering: the older lookup's successful
			// endpoint records may still arrive afterwards and must be published.
			const { getModels } = await import("../fetchers/modelCache")
			const mockedGetModels = vitest.mocked(getModels)

			let releaseFirst!: () => void
			let releaseSecond!: () => void
			const firstGate = new Promise<void>((resolve) => {
				releaseFirst = resolve
			})
			const secondGate = new Promise<void>((resolve) => {
				releaseSecond = resolve
			})
			mockedGetModels
				.mockImplementationOnce(async () => {
					await firstGate
					return {}
				})
				.mockImplementationOnce(async () => {
					await secondGate
					return { "anthropic/claude-sonnet-4": { ...openRouterDefaultModelInfo, maxTokens: 555 } }
				})
			mockGetModelEndpoints
				.mockImplementationOnce(async () => {
					await firstGate
					return { "provider-x": { ...openRouterDefaultModelInfo, maxTokens: 111 } }
				})
				.mockResolvedValueOnce({})

			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					openRouterApiKey: "test-key",
					openRouterModelId: "anthropic/claude-sonnet-4",
					openRouterSpecificProvider: "provider-x",
				}),
			)

			const first = handler.fetchModel()
			const second = handler.fetchModel()

			releaseSecond()
			await second
			releaseFirst()
			await first

			expect(handler.getModel().info.maxTokens).toBe(111)
		})

		it("takes model capabilities from the newest catalog and endpoint limits from the endpoint", async () => {
			// The endpoint cache copies supportsReasoningEffort and supportedParameters off the catalog
			// that was current when the endpoints were fetched, and endpoint records survive a lookup
			// that returned none, so a retained record's capabilities can be older than the catalog.
			// The provider's own limits must not be dragged along with them.
			const { getModels } = await import("../fetchers/modelCache")
			const catalogRecord: ModelInfo = {
				...openRouterDefaultModelInfo,
				maxTokens: 9999,
				supportsReasoningEffort: ["low", "high"],
				supportedParameters: ["temperature", "reasoning"],
			}
			const endpointRecord: ModelInfo = {
				...openRouterDefaultModelInfo,
				maxTokens: 4096,
				contextWindow: 131072,
				description: "Provider X endpoint",
				supportsReasoningEffort: ["minimal"],
				supportedParameters: ["max_tokens"],
			}
			vitest.mocked(getModels).mockResolvedValueOnce({ "anthropic/claude-sonnet-4": catalogRecord })
			mockGetModelEndpoints.mockResolvedValueOnce({ "provider-x": endpointRecord })

			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					openRouterApiKey: "test-key",
					openRouterModelId: "anthropic/claude-sonnet-4",
					openRouterSpecificProvider: "provider-x",
				}),
			)

			await handler.fetchModel()

			const info = handler.getModel().info
			expect(info.supportsReasoningEffort).toEqual(["low", "high"])
			expect(info.supportedParameters).toEqual(["temperature", "reasoning"])
			// Provider-specific limits and metadata still come from the endpoint record.
			expect(info.maxTokens).toBe(4096)
			expect(info.contextWindow).toBe(131072)
			expect(info.description).toBe("Provider X endpoint")
			// The capability list is a copy: rendering or a later fetch must not write through to the
			// catalog record the shared model cache also holds.
			info.supportedParameters?.push("include_reasoning")
			expect(catalogRecord.supportedParameters).toEqual(["temperature", "reasoning"])
		})

		it("keeps the endpoint's capability copy when the catalog has no entry for the model", async () => {
			// A catalog miss must not leave the selected provider without capabilities: the endpoint
			// record is the only record there is, so it is used as is.
			const { getModels } = await import("../fetchers/modelCache")
			vitest.mocked(getModels).mockResolvedValueOnce({})
			const endpointRecord: ModelInfo = {
				...openRouterDefaultModelInfo,
				maxTokens: 4096,
				description: "Provider X endpoint",
				supportsReasoningEffort: ["minimal"],
				supportedParameters: ["max_tokens"],
			}
			mockGetModelEndpoints.mockResolvedValueOnce({ "provider-x": endpointRecord })

			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					openRouterApiKey: "test-key",
					openRouterModelId: "anthropic/claude-sonnet-4",
					openRouterSpecificProvider: "provider-x",
				}),
			)

			await handler.fetchModel()

			const info = handler.getModel().info
			expect(info.supportsReasoningEffort).toEqual(["minimal"])
			expect(info.supportedParameters).toEqual(["max_tokens"])
			expect(info.maxTokens).toBe(4096)
		})
	})

	describe("applyOpenRouterMoonshotK3Profile", () => {
		// Stale cache record shape: fabricated 0.2 context-window max_tokens and a
		// boolean supportsReasoningEffort with no default effort (pre-profile).
		const staleK3Record: ModelInfo = {
			maxTokens: 209_716,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			inputPrice: 0.6,
			outputPrice: 3,
			description: "Kimi K3 (stale cache)",
			supportsReasoningEffort: true,
		}

		it("applies the profile to the exact moonshotai/kimi-k3 id", () => {
			const result = applyOpenRouterMoonshotK3Profile("moonshotai/kimi-k3", { ...staleK3Record })

			expect(result.maxTokens).toBe(32_768)
			expect(result.supportsReasoningEffort).toEqual(["low", "high", "max"])
			expect(result.reasoningEffort).toBe("high")
			expect(result.supportsTemperature).toBe(true)
			expect(result.defaultTemperature).toBe(1.0)
			// Unprofiled fields pass through from the (stale) record
			expect(result.contextWindow).toBe(1_000_000)
			expect(result.description).toBe("Kimi K3 (stale cache)")
		})

		it("applies the profile to the tilde-prefixed rolling alias", () => {
			const result = applyOpenRouterMoonshotK3Profile("~moonshotai/kimi-latest", { ...staleK3Record })

			// The catalogue keeps the ~ prefix on the rolling alias id, so the profile
			// must recognize the exact string rather than a stripped or bare alias
			expect(result.maxTokens).toBe(32_768)
			expect(result.supportsReasoningEffort).toEqual(["low", "high", "max"])
			expect(result.reasoningEffort).toBe("high")
			expect(result.supportsTemperature).toBe(true)
			expect(result.defaultTemperature).toBe(1.0)
		})

		it("leaves non-K3 model records untouched", () => {
			const record: ModelInfo = { ...staleK3Record }

			expect(applyOpenRouterMoonshotK3Profile("moonshotai/kimi-k2-thinking", record)).toBe(record)
		})
	})
	describe("createMessage", () => {
		it("generates correct stream chunks", async () => {
			const handler = new OpenRouterHandler(mockOptions)

			const mockStream = asyncStreamFrom([
				{
					id: mockOptions.openRouterModelId,
					choices: [{ delta: { content: "test response" } }],
				},
				{
					id: "test-id",
					choices: [{ delta: {} }],
					usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.001 },
				},
			])

			// Mock OpenAI chat.completions.create
			const mockCreate = vitest.fn().mockResolvedValue(mockStream)

			// Typed per-instance injection: a prototype mutation would outlive the test
			// and hand later tests a stale mockCreate.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const systemPrompt = "test system prompt"
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user" as const, content: "test message" }]

			const chunks = await collectStream(handler.createMessage(systemPrompt, messages))

			// Verify stream chunks
			expect(chunks).toHaveLength(2) // One text chunk and one usage chunk
			expect(chunks[0]).toEqual({ type: "text", text: "test response" })
			expect(chunks[1]).toEqual({ type: "usage", inputTokens: 10, outputTokens: 20, totalCost: 0.001 })

			// Verify OpenAI client was called with correct parameters.
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					max_tokens: 8192,
					messages: [
						{
							content: [
								{ cache_control: { type: "ephemeral" }, text: "test system prompt", type: "text" },
							],
							role: "system",
						},
						{
							content: [{ cache_control: { type: "ephemeral" }, text: "test message", type: "text" }],
							role: "user",
						},
					],
					model: "anthropic/claude-sonnet-4",
					stream: true,
					stream_options: { include_usage: true },
					temperature: 0,
					top_p: undefined,
				}),
				{
					headers: { "x-anthropic-beta": "fine-grained-tool-streaming-2025-05-14" },
					signal: expect.any(AbortSignal),
				},
			)
		})

		it("adds cache control for supported models", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "anthropic/claude-3.5-sonnet",
				}),
			)

			const mockStream = asyncStreamFrom([
				{
					id: "test-id",
					choices: [{ delta: { content: "test response" } }],
				},
			])

			const mockCreate = vitest.fn().mockResolvedValue(mockStream)
			// Typed per-instance injection: a prototype mutation would outlive the test
			// and hand later tests a stale mockCreate.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "message 1" },
				{ role: "assistant", content: "response 1" },
				{ role: "user", content: "message 2" },
			]

			await handler.createMessage("test system", messages).next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					messages: expect.arrayContaining([
						expect.objectContaining({
							role: "system",
							content: expect.arrayContaining([
								expect.objectContaining({ cache_control: { type: "ephemeral" } }),
							]),
						}),
					]),
				}),
				{
					headers: { "x-anthropic-beta": "fine-grained-tool-streaming-2025-05-14" },
					signal: expect.any(AbortSignal),
				},
			)
		})

		describe("prompt cache TTL", () => {
			const mockStreamWithUsage = () =>
				asyncStreamFrom([
					{ id: "test-id", choices: [{ delta: { content: "test response" } }] },
					{ id: "test-id", choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 20 } },
				])

			const requestBody = (mockCreate: ReturnType<typeof vitest.fn>) =>
				mockCreate.mock.calls[mockCreate.mock.calls.length - 1]?.[0]

			// `openai` is mocked for this file, so the prototype is a plain object here.
			// Reaching it once keeps the casts out of each test body.
			const stubChatCreate = (mockCreate: ReturnType<typeof vitest.fn>) => {
				const proto = OpenAI.prototype as unknown as { chat: { completions: { create: unknown } } }
				proto.chat = { completions: { create: mockCreate } }
			}

			const cacheControlsIn = (body: unknown) => {
				const found: Array<Record<string, unknown>> = []
				const walk = (node: unknown) => {
					if (Array.isArray(node)) {
						node.forEach(walk)
						return
					}
					if (node && typeof node === "object") {
						for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
							if (key === "cache_control" && child && typeof child === "object") {
								found.push(child as Record<string, unknown>)
							}
							walk(child)
						}
					}
				}
				walk(JSON.parse(JSON.stringify(body)))
				return found
			}

			it("emits no ttl key when the knob is unset", async () => {
				const handler = new OpenRouterHandler(
					makeApiHandlerOptions({ ...mockOptions, openRouterModelId: "anthropic/claude-sonnet-4" }),
				)

				const mockCreate = vitest.fn().mockResolvedValue(mockStreamWithUsage())
				stubChatCreate(mockCreate)

				await collectStream(
					handler.createMessage("test system prompt", [{ role: "user", content: "test message" }]),
				)

				const body = requestBody(mockCreate)
				expect(JSON.stringify(body)).not.toContain("ttl")
				expect(cacheControlsIn(body).every((control) => control.ttl === undefined)).toBe(true)
			})

			it("fails closed when the resolved model advertises no TTL capability", async () => {
				// OpenRouter models come from a dynamic catalog that carries no TTL
				// capability data, so a 1h knob must not reach the wire (ADR-0006 I2,
				// and the ADR's stated risk for dynamic catalogs).
				const handler = new OpenRouterHandler(
					makeApiHandlerOptions({
						...mockOptions,
						openRouterModelId: "anthropic/claude-sonnet-4",
						promptCacheTtl: "1h",
					}),
				)

				expect(handler.getModel().info.promptCacheTtlSupport).toBeUndefined()

				const mockCreate = vitest.fn().mockResolvedValue(mockStreamWithUsage())
				stubChatCreate(mockCreate)

				await collectStream(
					handler.createMessage("test system prompt", [{ role: "user", content: "test message" }]),
				)

				const body = requestBody(mockCreate)
				expect(JSON.stringify(body)).not.toContain("ttl")
				expect(cacheControlsIn(body).every((control) => control.ttl === undefined)).toBe(true)
			})

			it("carries ttl 1h on every marker when the resolved model advertises it", async () => {
				const handler = new OpenRouterHandler(
					makeApiHandlerOptions({
						...mockOptions,
						openRouterModelId: "anthropic/claude-sonnet-4",
						promptCacheTtl: "1h",
					}),
				)

				// Simulate a catalog that does carry capability data.
				const model = handler.getModel()
				vitest.spyOn(handler, "getModel").mockReturnValue({
					...model,
					info: { ...model.info, promptCacheTtlSupport: ["5m", "1h"] },
				})

				const mockCreate = vitest.fn().mockResolvedValue(mockStreamWithUsage())
				stubChatCreate(mockCreate)

				await collectStream(
					handler.createMessage("test system prompt", [{ role: "user", content: "test message" }]),
				)

				const controls = cacheControlsIn(requestBody(mockCreate))
				expect(controls).toHaveLength(2)
				expect(controls.every((control) => control.ttl === "1h")).toBe(true)
			})
		})

		it("handles API errors and captures telemetry", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockStream = asyncStreamFrom([{ error: { message: "API Error", code: 500 } }])

			const mockCreate = vitest.fn().mockResolvedValue(mockStream)
			// Typed per-instance injection: a prototype mutation would outlive the test
			// and hand later tests a stale mockCreate.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const generator = handler.createMessage("test", [])
			await expect(generator.next()).rejects.toThrow("OpenRouter API Error 500: API Error")

			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "API Error",
					provider: providerIdentifiers.openrouter,
					modelId: mockOptions.openRouterModelId,
					operation: "createMessage",
					errorCode: 500,
					status: 500,
				}),
			)
		})

		it("captures telemetry when createMessage throws an exception", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockRejectedValue(new Error("Connection failed"))
			// Typed per-instance injection: a prototype mutation would outlive the test
			// and hand later tests a stale mockCreate.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const generator = handler.createMessage("test", [])
			await expect(generator.next()).rejects.toThrow()

			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Connection failed",
					provider: providerIdentifiers.openrouter,
					modelId: mockOptions.openRouterModelId,
					operation: "createMessage",
				}),
			)
		})

		it("passes SDK exceptions with status 429 to telemetry (filtering happens in PostHogTelemetryClient)", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const error = Object.assign(new Error("Rate limit exceeded: free-models-per-day"), { status: 429 })

			const mockCreate = vitest.fn().mockRejectedValue(error)
			// Typed per-instance injection: a prototype mutation would outlive the test
			// and hand later tests a stale mockCreate.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const generator = handler.createMessage("test", [])
			await expect(generator.next()).rejects.toThrow("Rate limit exceeded")

			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Rate limit exceeded: free-models-per-day",
					provider: providerIdentifiers.openrouter,
					modelId: mockOptions.openRouterModelId,
					operation: "createMessage",
				}),
			)
		})

		it("passes SDK exceptions with 429 in message to telemetry (filtering happens in PostHogTelemetryClient)", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const error = new Error("429 Rate limit exceeded: free-models-per-day")
			const mockCreate = vitest.fn().mockRejectedValue(error)
			// Typed per-instance injection: a prototype mutation would outlive the test
			// and hand later tests a stale mockCreate.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const generator = handler.createMessage("test", [])
			await expect(generator.next()).rejects.toThrow("429 Rate limit exceeded")

			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "429 Rate limit exceeded: free-models-per-day",
					provider: providerIdentifiers.openrouter,
					modelId: mockOptions.openRouterModelId,
					operation: "createMessage",
				}),
			)
		})

		it("passes SDK exceptions containing 'rate limit' to telemetry (filtering happens in PostHogTelemetryClient)", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const error = new Error("Request failed due to rate limit")
			const mockCreate = vitest.fn().mockRejectedValue(error)
			// Typed per-instance injection: a prototype mutation would outlive the test
			// and hand later tests a stale mockCreate.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const generator = handler.createMessage("test", [])
			await expect(generator.next()).rejects.toThrow("rate limit")

			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Request failed due to rate limit",
					provider: providerIdentifiers.openrouter,
					modelId: mockOptions.openRouterModelId,
					operation: "createMessage",
				}),
			)
		})

		it("passes 429 rate limit errors from stream to telemetry (filtering happens in PostHogTelemetryClient)", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockStream = asyncStreamFrom([{ error: { message: "Rate limit exceeded", code: 429 } }])

			const mockCreate = vitest.fn().mockResolvedValue(mockStream)
			// Typed per-instance injection: a prototype mutation would outlive the test
			// and hand later tests a stale mockCreate.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const generator = handler.createMessage("test", [])
			await expect(generator.next()).rejects.toThrow("OpenRouter API Error 429: Rate limit exceeded")

			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Rate limit exceeded",
					provider: providerIdentifiers.openrouter,
					modelId: mockOptions.openRouterModelId,
					operation: "createMessage",
					errorCode: 429,
					status: 429,
				}),
			)
		})

		it("yields tool_call_end events when finish_reason is tool_calls", async () => {
			// Import NativeToolCallParser to set up state
			const { NativeToolCallParser } = await import("../../../core/assistant-message/NativeToolCallParser")

			const handler = new OpenRouterHandler(mockOptions)

			const mockStream = asyncStreamFrom([
				{
					id: "test-id",
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_openrouter_test",
										function: { name: "read_file", arguments: '{"path":"test.ts"}' },
									},
								],
							},
							index: 0,
						},
					],
				},
				{
					id: "test-id",
					choices: [
						{
							delta: {},
							finish_reason: "tool_calls",
							index: 0,
						},
					],
					usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
				},
			])

			const mockCreate = vitest.fn().mockResolvedValue(mockStream)
			// Typed per-instance injection: a prototype mutation would outlive the test
			// and hand later tests a stale mockCreate.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const generator = handler.createMessage("test", [])
			const parserScope = NativeToolCallParser.createScope()
			const chunks = []

			for await (const chunk of generator) {
				// Simulate what Task.ts does: when we receive tool_call_partial,
				// process it through NativeToolCallParser to populate rawChunkTracker
				if (chunk.type === "tool_call_partial") {
					NativeToolCallParser.processRawChunk(
						{
							index: chunk.index,
							id: chunk.id,
							name: chunk.name,
							arguments: chunk.arguments,
						},
						parserScope,
					)
				}
				chunks.push(chunk)
			}

			// Should have tool_call_partial and tool_call_end
			const partialChunks = chunks.filter((chunk) => chunk.type === "tool_call_partial")
			const endChunks = chunks.filter((chunk) => chunk.type === "tool_call_end")

			expect(partialChunks).toHaveLength(1)
			expect(endChunks).toHaveLength(1)
			expect(endChunks[0].id).toBe("call_openrouter_test")
		})

		it("sends profiled max_tokens, explicit temperature 1.0, and reasoning effort for moonshotai/kimi-k3", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					openRouterApiKey: "test-key",
					openRouterModelId: "moonshotai/kimi-k3",
				}),
			)

			const mockStream = asyncStreamFrom([{ id: "test-id", choices: [{ delta: { content: "ok" } }] }])
			const mockCreate = vitest.fn().mockResolvedValue(mockStream)
			const chatStub = { completions: { create: mockCreate } }
			// The vitest-mocked OpenAI class is structurally incompatible with the narrow
			// chat stub; the double assertion routes through unknown (instead of any) to
			// keep this file's no-explicit-any budget flat.
			const openAiPrototype = OpenAI as unknown as { prototype: { chat?: unknown } }
			const originalChat = openAiPrototype.prototype.chat
			openAiPrototype.prototype.chat = chatStub

			try {
				const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "test message" }]
				await collectStream(handler.createMessage("test system prompt", messages))

				const [requestParams] = mockCreate.mock.calls[0] as [Record<string, unknown>]
				expect(requestParams).toMatchObject({
					model: "moonshotai/kimi-k3",
					max_tokens: 32768,
					temperature: 1,
					reasoning: { effort: "high" },
				})
				// K3 is fixed at temperature 1.0 upstream (issue #1316); the request
				// must carry it explicitly.
			} finally {
				// Restore the original prototype property so this stub cannot leak
				// into later tests; clearAllMocks does not undo prototype assignment.
				openAiPrototype.prototype.chat = originalChat
			}
		})

		it("emits completion only for identified calls and clears completed IDs", async () => {
			const toolCall = (id?: string) => ({
				id: "stream",
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 0, id, function: { name: "read_file", arguments: '{"path":"test.ts"}' } },
							],
						},
						index: 0,
					},
				],
			})
			const mockCreate = vitest
				.fn()
				.mockResolvedValueOnce(
					asyncStreamFrom([
						toolCall(),
						{ id: "stream", choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] },
					]),
				)
				.mockResolvedValueOnce(
					asyncStreamFrom([
						toolCall("call_openrouter_stop"),
						{ id: "stream", choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
					]),
				)
				.mockResolvedValueOnce(
					asyncStreamFrom([
						toolCall("call_openrouter_once"),
						{ id: "stream", choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] },
						{ id: "stream", choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] },
					]),
				)
			Object.defineProperty(OpenAI.prototype, "chat", {
				configurable: true,
				value: { completions: { create: mockCreate } },
			})
			const handler = new OpenRouterHandler(mockOptions)

			const idlessChunks = await collectStream(handler.createMessage("idless", []))
			const stoppedChunks = await collectStream(handler.createMessage("stopped", []))
			const completedChunks = await collectStream(handler.createMessage("completed", []))

			expect(idlessChunks.filter((chunk) => chunk.type === "tool_call_end")).toEqual([])
			expect(stoppedChunks.filter((chunk) => chunk.type === "tool_call_end")).toEqual([])
			expect(completedChunks.filter((chunk) => chunk.type === "tool_call_end")).toEqual([
				{ type: "tool_call_end", id: "call_openrouter_once" },
			])
		})

		it("isolates overlapping tool-call finalization between provider streams", async () => {
			let releaseFirstStream: (() => void) | undefined
			let markFirstStreamPaused: (() => void) | undefined
			const firstStreamRelease = new Promise<void>((resolve) => {
				releaseFirstStream = resolve
			})
			const firstStreamPaused = new Promise<void>((resolve) => {
				markFirstStreamPaused = resolve
			})
			const firstStream = async function* () {
				yield {
					id: "stream-a",
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_openrouter_a",
										function: { name: "read_file", arguments: '{"path":"a' },
									},
								],
							},
							index: 0,
						},
					],
				}
				markFirstStreamPaused?.()
				await firstStreamRelease
				yield {
					id: "stream-a",
					choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
				}
			}
			const secondStream = asyncStreamFrom([
				{
					id: "stream-b",
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_openrouter_b",
										function: { name: "read_file", arguments: '{"path":"b' },
									},
								],
							},
							index: 0,
						},
					],
				},
				{ id: "stream-b", choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] },
			])
			const mockCreate = vitest.fn().mockResolvedValueOnce(firstStream()).mockResolvedValueOnce(secondStream)
			Object.defineProperty(OpenAI.prototype, "chat", {
				configurable: true,
				value: { completions: { create: mockCreate } },
			})
			const handler = new OpenRouterHandler(mockOptions)

			const firstChunksPromise = collectStreamAndParseToolCalls(handler.createMessage("first", []))
			await firstStreamPaused
			const secondChunks = await collectStreamAndParseToolCalls(handler.createMessage("second", []))
			releaseFirstStream?.()
			const firstChunks = await firstChunksPromise

			expect(secondChunks.chunks.filter((chunk) => chunk.type === "tool_call_end")).toEqual([
				{ type: "tool_call_end", id: "call_openrouter_b" },
			])
			expect(firstChunks.chunks.filter((chunk) => chunk.type === "tool_call_end")).toEqual([
				{ type: "tool_call_end", id: "call_openrouter_a" },
			])
			expect(firstChunks.parserEvents).toEqual([
				{ type: "tool_call_start", id: "call_openrouter_a", name: "read_file" },
				{ type: "tool_call_delta", id: "call_openrouter_a", name: "read_file", delta: '{"path":"a' },
			])
			expect(secondChunks.parserEvents).toEqual([
				{ type: "tool_call_start", id: "call_openrouter_b", name: "read_file" },
				{ type: "tool_call_delta", id: "call_openrouter_b", name: "read_file", delta: '{"path":"b' },
			])
		})

		it("throws an OpenRouter API error for a streamed error chunk and reports telemetry", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{ id: "1", choices: [{ delta: { content: "ok" } }] },
					{
						id: "1",
						error: {
							message: "Upstream failed",
							code: 500,
							metadata: { raw: '{"message":"upstream: boom"}' },
						},
					},
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const stream = handler.createMessage("system", [{ role: "user" as const, content: "hi" }])

			await expect(collectStream(stream)).rejects.toThrow("OpenRouter API Error 500: upstream: boom")
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "upstream: boom",
					provider: providerIdentifiers.openrouter,
					modelId: "anthropic/claude-sonnet-4",
					operation: "createMessage",
				}),
			)
		})
		it("rejects with AbortError when the external signal is pre-aborted", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue({ choices: [{ message: { content: "response" } }] })
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			// The constructor loads models in the background; the pre-aborted path must fail
			// fast without starting a second discovery lookup.
			const { getModels } = await import("../fetchers/modelCache")
			const lookupsBefore = vitest.mocked(getModels).mock.calls.length

			const controller = new AbortController()
			controller.abort()
			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })

			await expect(
				handler.createMessage("test", [{ role: "user" as const, content: "hi" }], metadata).next(),
			).rejects.toMatchObject({
				name: "AbortError",
				message: "The OpenRouter request was aborted",
			})
			expect(mockCreate).not.toHaveBeenCalled()
			expect(vitest.mocked(getModels).mock.calls.length).toBe(lookupsBefore)
		})

		it("rejects with AbortError when the external signal aborts during deferred model discovery", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const controller = new AbortController()

			const mockCreate = vitest.fn()
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			// Model discovery is deferred: capture the resolver and settle it only at the end of
			// the test, so the abort deterministically lands while the lookup is still pending.
			// The barrier below (instead of a fixed sleep) synchronizes on the lookup starting.
			let resolveModelLookup!: (models: ModelRecord) => void
			const deferredModelLookup = new Promise<ModelRecord>((resolve) => {
				resolveModelLookup = resolve
			})
			let notifyLookupStarted!: () => void
			const lookupStarted = new Promise<void>((resolve) => {
				notifyLookupStarted = resolve
			})
			const { getModels } = await import("../fetchers/modelCache")
			vitest.mocked(getModels).mockImplementationOnce(() => {
				notifyLookupStarted()
				return deferredModelLookup
			})

			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })
			const generator = handler.createMessage("test", [{ role: "user" as const, content: "hi" }], metadata)

			const nextPromise = generator.next()
			await settlesWithin(lookupStarted, ABORT_SETTLE_MS)
			controller.abort()

			await expect(settlesWithin(nextPromise, ABORT_SETTLE_MS)).rejects.toMatchObject({
				name: "AbortError",
				message: "The OpenRouter request was aborted",
			})
			expect(mockCreate).not.toHaveBeenCalled()

			// Settle the abandoned lookup so it cannot outlive the test.
			resolveModelLookup({})
		})

		it("aborts the in-flight stream and rejects with AbortError when the external signal aborts", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const controller = new AbortController()

			let requestSignal: AbortSignal | undefined
			const mockCreate = vitest
				.fn()
				.mockImplementation(async (_params: unknown, options?: { signal?: AbortSignal }) => {
					requestSignal = options?.signal
					// Emulate the OpenAI SDK: the first chunk arrives, then the in-flight
					// response body rejects once the request signal aborts.
					return (async function* () {
						yield { id: "1", choices: [{ delta: { content: "first" } }] }
						await new Promise<void>((resolve) => {
							expect(requestSignal).toBeDefined()
							if (requestSignal!.aborted) {
								resolve()
							} else {
								requestSignal!.addEventListener("abort", () => resolve(), { once: true })
							}
						})
						const abortError = new Error("The user aborted a request")
						abortError.name = "AbortError"
						throw abortError
					})()
				})
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })
			const generator = handler.createMessage("test", [{ role: "user" as const, content: "hi" }], metadata)

			const chunks: unknown[] = []
			const iteration = (async () => {
				for await (const chunk of generator) {
					chunks.push(chunk)
					if (chunk.type === "text") {
						// Abort while the stream is still in flight.
						controller.abort()
					}
				}
			})()

			await expect(settlesWithin(iteration, ABORT_SETTLE_MS)).rejects.toMatchObject({
				name: "AbortError",
				message: "The OpenRouter request was aborted",
			})
			expect(chunks).toContainEqual({ type: "text", text: "first" })
		})
		it("cancels the in-flight stream when the consumer abandons the generator", async () => {
			const handler = new OpenRouterHandler(mockOptions)

			// Emulate the OpenAI SDK: the first chunk arrives, then the response body
			// stalls until the request signal aborts — no further chunk arrives on its own.
			let requestSignal: AbortSignal | undefined
			const mockCreate = vitest
				.fn()
				.mockImplementation(async (_params: unknown, options?: { signal?: AbortSignal }) => {
					requestSignal = options?.signal
					return (async function* () {
						yield { id: "1", choices: [{ delta: { content: "first" } }] }
						await new Promise<void>((resolve) => {
							expect(requestSignal).toBeDefined()
							if (requestSignal!.aborted) {
								resolve()
							} else {
								requestSignal!.addEventListener("abort", () => resolve(), { once: true })
							}
						})
						yield { id: "2", choices: [{ delta: { content: "second" } }] }
					})()
				})
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const generator = handler.createMessage("test", [{ role: "user" as const, content: "hi" }])

			const first = await settlesWithin(generator.next(), ABORT_SETTLE_MS)
			expect(first.value).toEqual({ type: "text", text: "first" })
			expect(requestSignal?.aborted).toBe(false)

			// Abandon the generator mid-stream: the finally block must abort the per-request
			// controller so the in-flight stream is cancelled instead of lingering until
			// the client-level timeout.
			await settlesWithin(generator.return(undefined), ABORT_SETTLE_MS)
			expect(requestSignal?.aborted).toBe(true)
		})
		it("does not emit buffered chunks after a mid-stream abort (iterator keeps delivering)", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const controller = new AbortController()

			// Simulate openai@5.23.2 delivering a buffered chunk after the abort has already
			// fired, then ending the iterator normally (no throw).
			let requestSignal: AbortSignal | undefined
			const mockCreate = vitest
				.fn()
				.mockImplementation(async (_params: unknown, options?: { signal?: AbortSignal }) => {
					requestSignal = options?.signal
					return (async function* () {
						yield { id: "1", choices: [{ delta: { content: "partial" } }] }
						// Wait for the abort instead of polling: the buffered chunk is delivered
						// once the request signal aborts.
						await new Promise<void>((resolve) => {
							expect(requestSignal).toBeDefined()
							if (requestSignal!.aborted) {
								resolve()
							} else {
								requestSignal!.addEventListener("abort", () => resolve(), { once: true })
							}
						})
						yield { id: "2", choices: [{ delta: { content: "after-abort" } }] }
					})()
				})
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })
			const generator = handler.createMessage("test", [{ role: "user" as const, content: "hi" }], metadata)

			const first = await generator.next()
			expect(first.value).toEqual({ type: "text", text: "partial" })
			// Abort mid-stream, after the first chunk has been yielded.
			controller.abort()

			// The buffered second chunk must not be emitted, and the generator must reject
			// with the provider AbortError.
			await expect(settlesWithin(generator.next(), ABORT_SETTLE_MS)).rejects.toMatchObject({
				name: "AbortError",
				message: "The OpenRouter request was aborted",
			})
		})
		it("registers the external abort listener with { once: true } and removes the exact reference on completion", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const controller = new AbortController()
			const addSpy = vi.spyOn(controller.signal, "addEventListener")
			const removeSpy = vi.spyOn(controller.signal, "removeEventListener")
			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })

			const stream = handler.createMessage("test", [{ role: "user" as const, content: "hi" }], metadata)
			await collectStream(stream)

			// The listener must be registered once with self-removal, and the exact
			// registered reference must be removed once the request completes.
			const registeredListener = addSpy.mock.calls[0]?.[1]
			expect(registeredListener).toBeTypeOf("function")
			expect(addSpy).toHaveBeenCalledWith("abort", registeredListener, { once: true })
			expect(removeSpy).toHaveBeenCalledWith("abort", registeredListener)
			addSpy.mockRestore()
			removeSpy.mockRestore()
		})

		it("resets the reasoning_details accumulator between requests on the same handler", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "google/gemini-2.5-pro",
				}),
			)
			const mockCreate = vitest.fn()
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			// Request 1: a Gemini stream with reasoning_details populates the handler's
			// accumulator when the stream completes.
			mockCreate.mockResolvedValueOnce(
				asyncStreamFrom([
					{
						id: "1",
						choices: [
							{ delta: { reasoning_details: [{ index: 0, type: "reasoning.text", text: "thinking" }] } },
						],
					},
					{ id: "2", choices: [{ delta: { content: "answer" } }] },
				]),
			)
			await collectStream(handler.createMessage("test", [{ role: "user" as const, content: "hi" }]))
			expect(handler.getReasoningDetails()?.length ?? 0).toBeGreaterThan(0)

			// Request 2 on the same handler must start from an empty accumulator so the
			// previous request's details cannot leak into the next one.
			mockCreate.mockResolvedValueOnce(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			await collectStream(handler.createMessage("test", [{ role: "user" as const, content: "hi" }]))
			expect(handler.getReasoningDetails()).toBeUndefined()
		})

		it("stops yielding a chunk's remaining events when the consumer aborts between them", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{
						id: "1",
						choices: [
							{
								delta: {
									reasoning_details: [{ index: 0, type: "reasoning.text", text: "thinking" }],
									content: "answer",
								},
							},
						],
					},
				]),
			)
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const controller = new AbortController()
			const iterator = handler
				.createMessage("system", [{ role: "user" as const, content: "hi" }], {
					taskId: "task",
					abortSignal: controller.signal,
				})
				[Symbol.asyncIterator]()

			// One SDK chunk yields reasoning BEFORE text: abort while the generator is paused
			// between the two yields, so the text must not be emitted.
			expect((await iterator.next()).value).toEqual({ type: "reasoning", text: "thinking" })
			controller.abort()
			await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" })
		})

		it("skips non-string reasoning detail fragments instead of coercing them", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{
						id: "1",
						choices: [
							{
								delta: {
									reasoning_details: [
										{ index: 0, type: "reasoning.text", text: { not: "a string" } },
										{ index: 0, type: "reasoning.text", text: "ok" },
									],
								},
							},
							{ id: "2", choices: [{ delta: { content: "answer" } }] },
						],
					},
				]),
			)
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			await collectStream(handler.createMessage("system", [{ role: "user" as const, content: "hi" }]))
			const details = handler.getReasoningDetails()
			const text = details?.find((d) => d.type === "reasoning.text")?.text
			// The object fragment is skipped and the later string accumulates from empty.
			expect(text).toBe("ok")
			expect(text).not.toContain("[object Object]")
		})

		it.each([
			{ type: "reasoning.text", field: "text", good: "ok", emitsReasoning: true },
			{ type: "reasoning.summary", field: "summary", good: "s", emitsReasoning: true },
			{ type: "reasoning.encrypted", field: "data", good: "enc", emitsReasoning: false },
		])(
			"keeps the valid fragment when a non-string $type fragment arrives after it at the same index",
			async ({ type, field, good, emitsReasoning }) => {
				const handler = new OpenRouterHandler(mockOptions)
				const mockCreate = vitest.fn().mockResolvedValue(
					asyncStreamFrom([
						{
							id: "1",
							choices: [
								{ delta: { reasoning_details: [{ index: 0, type, [field]: good }] } },
								{ delta: { reasoning_details: [{ index: 0, type, [field]: { not: "a string" } }] } },
							],
						},
					]),
				)
				// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
				const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
				Object.defineProperty(client, "chat", {
					value: { completions: { create: mockCreate } },
					configurable: true,
					writable: true,
				})

				const chunks = await collectStream(
					handler.createMessage("system", [{ role: "user" as const, content: "hi" }]),
				)
				// The valid fragment is the only displayable one; the non-string fragment yields nothing.
				expect(chunks).toEqual(emitsReasoning ? [{ type: "reasoning", text: good }] : [])

				const details = handler.getReasoningDetails()
				expect(details).toHaveLength(1)
				expect(details?.[0]).toMatchObject({ type, index: 0, [field]: good })
				expect(JSON.stringify(details)).not.toContain("[object Object]")
			},
		)

		it("excludes reasoning for Gemini 2.5 Pro models by default", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "google/gemini-2.5-pro-preview",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const stream = handler.createMessage("system", [{ role: "user" as const, content: "hi" }])
			await collectStream(stream)

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ reasoning: { exclude: true } }),
				expect.any(Object),
			)
		})

		it("excludes reasoning for the non-preview Gemini 2.5 Pro model by default", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "google/gemini-2.5-pro",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const stream = handler.createMessage("system", [{ role: "user" as const, content: "hi" }])
			await collectStream(stream)

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ reasoning: { exclude: true } }),
				expect.any(Object),
			)
		})

		it("does not inject reasoning exclusion for non-Gemini models without configured reasoning", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "openai/gpt-4o",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const stream = handler.createMessage("system", [{ role: "user" as const, content: "hi" }])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as { reasoning?: unknown }
			expect(params.reasoning).toBeUndefined()
		})

		it("keeps user-configured reasoning for Gemini 2.5 Pro models instead of overriding it", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "google/gemini-2.5-pro",
					enableReasoningEffort: true,
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			// The constructor already consumed the default model-cache mock; serve a Gemini
			// entry that advertises reasoning-budget support to fetchModel so getModelParams
			// resolves a user reasoning budget for this request.
			const { getModels } = await import("../fetchers/modelCache")
			vitest.mocked(getModels).mockImplementationOnce(async () => ({
				"google/gemini-2.5-pro": {
					maxTokens: 65536,
					contextWindow: 1048576,
					supportsPromptCache: false,
					supportsReasoningBudget: true,
				},
			}))

			const stream = handler.createMessage("system", [{ role: "user" as const, content: "hi" }])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as { reasoning?: { max_tokens?: number; exclude?: boolean } }
			expect(params.reasoning).toEqual({ max_tokens: 128 })
		})

		it("omits the anthropic beta header for non-Anthropic models", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "openai/gpt-4o",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const stream = handler.createMessage("system", [{ role: "user" as const, content: "hi" }])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as { messages: { role: string; content: unknown }[] }
			expect(params.messages[0]).toEqual({ role: "system", content: "system" })

			const options = mockCreate.mock.calls[0][1] as { headers?: Record<string, string>; signal?: AbortSignal }
			expect(options).not.toHaveProperty("headers")
			expect(options.signal).toBeInstanceOf(AbortSignal)
		})

		it("uses user role for the system prompt with DeepSeek R1 models", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "deepseek/deepseek-r1",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const stream = handler.createMessage("system prompt", [{ role: "user" as const, content: "hi" }])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as { messages: { role: string; content: unknown }[] }
			expect(params.messages[0].role).toBe("user")
			expect(params.messages.map((m) => m.role)).not.toContain("system")
		})

		it("uses user role for the system prompt with Perplexity Sonar Reasoning", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "perplexity/sonar-reasoning",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const stream = handler.createMessage("system prompt", [{ role: "user" as const, content: "hi" }])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as { messages: { role: string; content: unknown }[] }
			expect(params.messages[0].role).toBe("user")
			expect(params.messages.map((m) => m.role)).not.toContain("system")
		})

		it("pins provider order and only for a specific openRouterSpecificProvider", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterSpecificProvider: providerIdentifiers.anthropic,
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const stream = handler.createMessage("system", [{ role: "user" as const, content: "hi" }])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as {
				provider?: { order?: string[]; only?: string[]; allow_fallbacks?: boolean }
			}
			expect(params.provider).toEqual({
				order: [providerIdentifiers.anthropic],
				only: [providerIdentifiers.anthropic],
				allow_fallbacks: false,
			})
		})

		it("omits the provider option when openRouterSpecificProvider is [default]", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterSpecificProvider: "[default]",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const stream = handler.createMessage("system", [{ role: "user" as const, content: "hi" }])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as { provider?: unknown }
			expect(params).not.toHaveProperty("provider")
		})

		it("omits the provider option when openRouterSpecificProvider is unset", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const stream = handler.createMessage("system", [{ role: "user" as const, content: "hi" }])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as { provider?: unknown }
			expect(params).not.toHaveProperty("provider")
		})

		it("injects a fake encrypted reasoning block for Gemini tool calls without encrypted reasoning", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "google/gemini-2.5-flash",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			// reasoning_details is an OpenRouter extension field round-tripped on assistant
			// messages; the Anthropic SDK types do not include it, hence the structural cast.
			const assistantMessage = {
				role: "assistant" as const,
				content: [{ type: "tool_use" as const, id: "toolu_01", name: "get_weather", input: { city: "SF" } }],
				reasoning_details: [{ type: "reasoning.text", id: "toolu_01", text: "thinking", index: 0 }],
			}
			const stream = handler.createMessage("system", [
				assistantMessage as unknown as Anthropic.Messages.MessageParam,
			])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as {
				messages: {
					role: string
					tool_calls?: { id: string }[]
					reasoning_details?: { type: string; id: string; data: string }[]
				}[]
			}
			const assistant = params.messages.find((m) => m.role === "assistant")
			expect(assistant?.tool_calls).toHaveLength(1)
			const encrypted = assistant?.reasoning_details?.find((d) => d.type === "reasoning.encrypted")
			expect(encrypted).toMatchObject({
				id: "toolu_01",
				data: "skip_thought_signature_validator",
				format: "google-gemini-v1",
				index: 0,
			})
		})

		it("keeps the matching reasoning detail when sanitizing Gemini tool call messages", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "google/gemini-2.5-flash",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const assistantMessage = {
				role: "assistant" as const,
				content: [{ type: "tool_use" as const, id: "toolu_01", name: "get_weather", input: { city: "SF" } }],
				reasoning_details: [{ type: "reasoning.text", id: "toolu_01", text: "thinking", index: 0 }],
			}
			const stream = handler.createMessage("system", [
				assistantMessage as unknown as Anthropic.Messages.MessageParam,
			])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as {
				messages: {
					role: string
					tool_calls?: { id: string }[]
					reasoning_details?: { type: string; id?: string; text?: string }[]
				}[]
			}
			const assistant = params.messages.find((m) => m.role === "assistant")
			expect(assistant?.tool_calls).toHaveLength(1)
			const textDetail = assistant?.reasoning_details?.find((d) => d.type === "reasoning.text")
			expect(textDetail).toMatchObject({ id: "toolu_01", text: "thinking" })
			const encrypted = assistant?.reasoning_details?.find((d) => d.type === "reasoning.encrypted")
			expect(encrypted).toMatchObject({ id: "toolu_01" })
		})

		it("drops tool calls without reasoning details but keeps the content for Gemini messages", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "google/gemini-2.5-flash",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const assistantMessage = {
				role: "assistant" as const,
				content: [
					{ type: "text" as const, text: "kept content" },
					{ type: "tool_use" as const, id: "toolu_02", name: "get_weather", input: { city: "NY" } },
				],
			}
			const stream = handler.createMessage("system", [
				assistantMessage as unknown as Anthropic.Messages.MessageParam,
			])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as {
				messages: { role: string; content?: unknown; tool_calls?: unknown }[]
			}
			const assistant = params.messages.find((m) => m.role === "assistant")
			expect(assistant).toBeDefined()
			expect(assistant?.content).toBe("kept content")
			expect(assistant).not.toHaveProperty("tool_calls")
		})

		it("drops tool calls without a matching reasoning detail id for Gemini messages", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "google/gemini-2.5-flash",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const assistantMessage = {
				role: "assistant" as const,
				content: [
					{ type: "tool_use" as const, id: "toolu_03", name: "get_weather", input: { city: "SF" } },
					{ type: "tool_use" as const, id: "toolu_04", name: "search", input: { q: "x" } },
				],
				reasoning_details: [{ type: "reasoning.text", id: "toolu_03", text: "thinking", index: 0 }],
			}
			const stream = handler.createMessage("system", [
				assistantMessage as unknown as Anthropic.Messages.MessageParam,
			])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as {
				messages: { role: string; tool_calls?: { id: string }[] }[]
			}
			const assistant = params.messages.find((m) => m.role === "assistant")
			expect(assistant?.tool_calls).toHaveLength(1)
			expect(assistant?.tool_calls?.[0].id).toBe("toolu_03")
		})

		it("accumulates and yields reasoning_details from streamed chunks", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{ id: "1", choices: [{ delta: { reasoning: "top-level thinking" } }] },
					{
						id: "2",
						choices: [
							{ delta: { reasoning_details: [{ type: "reasoning.text", index: 0, text: "thinking " }] } },
						],
					},
					{
						id: "3",
						choices: [
							{
								delta: {
									reasoning_details: [
										{
											type: "reasoning.text",
											index: 0,
											text: "more",
											id: "r1",
											format: "google-gemini-v1",
											signature: "sig",
										},
									],
								},
							},
						],
					},
					{
						id: "4",
						choices: [
							{ delta: { reasoning_details: [{ type: "reasoning.summary", index: 1, summary: "sum" }] } },
						],
					},
					{ id: "5", choices: [{ delta: { content: "hello" } }] },
					{
						id: "6",
						choices: [
							{
								delta: {
									reasoning_details: [{ type: "reasoning.summary", index: 1, summary: " more" }],
								},
							},
						],
					},
					{
						id: "7",
						choices: [
							{ delta: { reasoning_details: [{ type: "reasoning.encrypted", index: 2, data: "enc-" }] } },
						],
					},
					{
						id: "8",
						choices: [
							{
								delta: {
									reasoning_details: [{ type: "reasoning.encrypted", index: 2, data: "rypted" }],
								},
							},
						],
					},
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const chunks = await collectStream(
				handler.createMessage("system", [{ role: "user" as const, content: "hi" }]),
			)

			expect(chunks).toContainEqual({ type: "reasoning", text: "top-level thinking" })
			expect(chunks).toContainEqual({ type: "reasoning", text: "thinking " })
			expect(chunks).toContainEqual({ type: "reasoning", text: "sum" })
			expect(chunks).toContainEqual({ type: "reasoning", text: " more" })
			expect(chunks).toContainEqual({ type: "text", text: "hello" })

			const details = handler.getReasoningDetails()
			expect(details).toHaveLength(3)
			expect(details?.find((d) => d.type === "reasoning.summary")?.summary).toBe("sum more")
			expect(details?.find((d) => d.type === "reasoning.encrypted")?.data).toBe("enc-rypted")
		})

		it("ignores chunks with empty choices", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{ id: "1", choices: [] },
					{ id: "1", choices: [{ delta: { content: "ok" } }] },
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const chunks = await collectStream(
				handler.createMessage("system", [{ role: "user" as const, content: "hi" }]),
			)
			expect(chunks).toContainEqual({ type: "text", text: "ok" })
		})

		it("keeps id, format and signature from the first reasoning chunk on updates", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{
						id: "1",
						choices: [
							{
								delta: {
									reasoning_details: [
										{
											type: "reasoning.text",
											index: 0,
											id: "det-1",
											format: "google-gemini-v1",
											signature: "sig-1",
										},
									],
								},
							},
						],
					},
					{
						id: "1",
						choices: [
							{ delta: { reasoning_details: [{ type: "reasoning.text", index: 0, text: "more" }] } },
						],
					},
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			await collectStream(handler.createMessage("system", [{ role: "user" as const, content: "hi" }]))

			const details = handler.getReasoningDetails()
			expect(details).toHaveLength(1)
			expect(details?.[0]).toMatchObject({
				type: "reasoning.text",
				text: "more",
				id: "det-1",
				format: "google-gemini-v1",
				signature: "sig-1",
				index: 0,
			})
		})

		it("initializes empty accumulator entries without undefined prefixes", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{ id: "1", choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", index: 0 }] } }] },
					{
						id: "1",
						choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", index: 0, text: "t0" }] } }],
					},
					{ id: "1", choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", index: 1 }] } }] },
					{
						id: "1",
						choices: [
							{ delta: { reasoning_details: [{ type: "reasoning.text", index: 1, summary: "s1" }] } },
						],
					},
					{ id: "1", choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", index: 2 }] } }] },
					{
						id: "1",
						choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", index: 2, data: "d2" }] } }],
					},
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			await collectStream(handler.createMessage("system", [{ role: "user" as const, content: "hi" }]))

			const details = handler.getReasoningDetails()
			expect(details).toHaveLength(3)
			expect(details?.find((d) => d.index === 0)?.text).toBe("t0")
			expect(details?.find((d) => d.index === 1)?.summary).toBe("s1")
			expect(details?.find((d) => d.index === 2)?.data).toBe("d2")
		})

		it("groups reasoning details without an explicit index under index 0", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{ id: "1", choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text: "a" }] } }] },
					{
						id: "1",
						choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text: "b", index: 0 }] } }],
					},
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			await collectStream(handler.createMessage("system", [{ role: "user" as const, content: "hi" }]))

			const details = handler.getReasoningDetails()
			expect(details).toHaveLength(1)
			expect(details?.[0]?.text).toBe("ab")
			expect(details?.[0]?.index).toBe(0)
		})

		it("accumulates reasoning text and summary with the same index separately", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{
						id: "1",
						choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", index: 0, text: "a" }] } }],
					},
					{
						id: "1",
						choices: [
							{ delta: { reasoning_details: [{ type: "reasoning.summary", index: 0, summary: "s" }] } },
						],
					},
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const chunks = await collectStream(
				handler.createMessage("system", [{ role: "user" as const, content: "hi" }]),
			)
			// Both fragments stream live in arrival order (the summary is yielded from detail.summary),
			// so a dropped summary is visible here rather than hidden by toContainEqual on one chunk.
			expect(chunks).toEqual([
				{ type: "reasoning", text: "a" },
				{ type: "reasoning", text: "s" },
			])

			const details = handler.getReasoningDetails()
			// consolidateReasoningDetails emits a summary entry only when no text arrived at the same
			// index (src/api/transform/openai-format.ts:116), so the consolidated store keeps the text
			// and drops the summary; asserting the drop is what makes this fail when that predicate
			// narrows. The companion test below covers the no-text branch. The entry's type label
			// follows the last fragment seen for the index (openai-format.ts:93-99, 105), which is why
			// it reports reasoning.summary while carrying text "a" and no summary field.
			expect(details).toHaveLength(1)
			expect(details?.[0]?.text).toBe("a")
			expect(details?.[0]?.index).toBe(0)
			expect(details?.[0]?.type).toBe("reasoning.summary")
			expect(details?.[0]?.summary).toBeUndefined()
		})

		it("keeps a reasoning summary entry when no text arrives at the same index", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{
						id: "1",
						choices: [
							{
								delta: { reasoning_details: [{ type: "reasoning.summary", index: 0, summary: "s" }] },
							},
						],
					},
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const chunks = await collectStream(
				handler.createMessage("system", [{ role: "user" as const, content: "hi" }]),
			)
			expect(chunks).toEqual([{ type: "reasoning", text: "s" }])

			const details = handler.getReasoningDetails()
			expect(details).toHaveLength(1)
			expect(details?.[0]).toMatchObject({ type: "reasoning.summary", index: 0, summary: "s" })
		})

		it("does not yield displayable reasoning for encrypted-only details", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{
						id: "1",
						choices: [
							{ delta: { reasoning_details: [{ type: "reasoning.encrypted", index: 0, data: "enc" }] } },
						],
					},
					{ id: "1", choices: [{ delta: { content: "ok" } }] },
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const chunks = await collectStream(
				handler.createMessage("system", [{ role: "user" as const, content: "hi" }]),
			)
			expect(chunks).toContainEqual({ type: "text", text: "ok" })
			expect(chunks).not.toContainEqual(expect.objectContaining({ type: "reasoning" }))

			const details = handler.getReasoningDetails()
			expect(details).toHaveLength(1)
			expect(details?.[0]?.data).toBe("enc")
		})

		it("ignores non-array reasoning_details values", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{ id: "1", choices: [{ delta: { reasoning_details: "not-an-array" } }] },
					{ id: "1", choices: [{ delta: { content: "ok" } }] },
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const chunks = await collectStream(
				handler.createMessage("system", [{ role: "user" as const, content: "hi" }]),
			)
			expect(chunks).toContainEqual({ type: "text", text: "ok" })
			expect(handler.getReasoningDetails()).toBeUndefined()
		})

		it("ignores object reasoning_details values", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{ id: "1", choices: [{ delta: { reasoning_details: { bogus: true } } }] },
					{ id: "1", choices: [{ delta: { content: "ok" } }] },
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const chunks = await collectStream(
				handler.createMessage("system", [{ role: "user" as const, content: "hi" }]),
			)
			expect(chunks).toContainEqual({ type: "text", text: "ok" })
			expect(handler.getReasoningDetails()).toBeUndefined()
		})

		it("rejects with AbortError when the external signal aborts during request creation", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const controller = new AbortController()

			// Deterministic synchronization (mirrors the Requesty test): the mock notifies the
			// test when the request actually starts, so the abort lands after create() began
			// instead of racing a fixed sleep that a slow runner can lose.
			let notifyCreateStarted!: () => void
			const createStarted = new Promise<void>((resolve) => {
				notifyCreateStarted = resolve
			})
			const mockCreate = vitest
				.fn()
				.mockImplementation(async (_params: unknown, options?: { signal?: AbortSignal }) => {
					notifyCreateStarted()
					// Emulate the OpenAI SDK: the pending request rejects when the signal aborts.
					await new Promise<void>((resolve) => {
						if (options?.signal?.aborted) {
							resolve()
						} else {
							options?.signal?.addEventListener("abort", () => resolve(), { once: true })
						}
					})
					const abortError = new Error("The user aborted a request")
					abortError.name = "AbortError"
					throw abortError
				})
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })
			const generator = handler.createMessage("system", [{ role: "user" as const, content: "hi" }], metadata)

			const nextPromise = generator.next()
			// Abort only once create() has actually started.
			await createStarted
			controller.abort()

			await expect(nextPromise).rejects.toMatchObject({
				name: "AbortError",
				message: "The OpenRouter request was aborted",
			})
		})

		it("normalizes Mistral tool call ids in tool result messages", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "Mistral/mixtral-large",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const stream = handler.createMessage("system", [
				{
					role: "user" as const,
					content: [
						{ type: "text" as const, text: "hi" },
						{ type: "tool_result" as const, tool_use_id: "toolu_123456789", content: "tool result ok" },
					],
				},
			])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as {
				messages: { role: string; tool_call_id?: string; content: unknown }[]
			}
			const toolMessage = params.messages.find((m) => m.role === "tool")
			expect(toolMessage).toMatchObject({ role: "tool", tool_call_id: "toolu1234", content: "tool result ok" })
		})

		it("uses user role for the system prompt with suffixed DeepSeek R1 model ids", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "deepseek/deepseek-r1-0528",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const stream = handler.createMessage("system prompt", [
				{ role: "assistant" as const, content: "earlier reply" },
			])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as { messages: { role: string; content: unknown }[] }
			expect(params.messages[0]).toMatchObject({ role: "user", content: "system prompt" })
			expect(params.messages[1]).toMatchObject({ role: "assistant", content: "earlier reply" })
			expect(params.messages.some((m) => m.role === "system")).toBe(false)
		})

		it("adds gemini cache breakpoints and the default max tokens for google/gemini models", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "google/gemini-2.5-flash",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const stream = handler.createMessage("sys-k1", [{ role: "user" as const, content: "hello" }])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as {
				messages: { role: string; content: unknown }[]
				max_tokens?: number
			}
			expect(params.messages[0]).toEqual({
				role: "system",
				content: [{ type: "text", text: "sys-k1", cache_control: { type: "ephemeral" } }],
			})
			expect(params.messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "hello" }] })
			expect(params.max_tokens).toBe(8192)
		})

		it("skips gemini sanitization for non-google gemini model ids", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "openai/gemini-2.5-flash",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			// No reasoning_details at all: gemini sanitization would drop this tool call, so a
			// surviving tool call proves the sanitization path was skipped.
			const assistantMessage = {
				role: "assistant" as const,
				content: [{ type: "tool_use" as const, id: "toolu_k2", name: "lookup", input: {} }],
			}
			const stream = handler.createMessage("system", [
				assistantMessage as unknown as Anthropic.Messages.MessageParam,
			])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as {
				messages: { role: string; tool_calls?: unknown[]; reasoning_details?: unknown[] }[]
			}
			const assistant = params.messages.find((m) => m.role === "assistant")
			expect(assistant?.tool_calls).toHaveLength(1)
			expect(assistant).not.toHaveProperty("reasoning_details")
		})

		it("does not inject fake encrypted reasoning when the assistant already carries encrypted details", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "google/gemini-2.5-flash",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "ok" } }] }]))
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			// The first assistant mixes a text detail with an encrypted one; the second carries
			// only encrypted details so the every()/==/-!== variants each diverge somewhere.
			const assistantOne = {
				role: "assistant" as const,
				content: [
					{ type: "tool_use" as const, id: "toolu_05", name: "lookup_a", input: {} },
					{ type: "tool_use" as const, id: "toolu_06", name: "lookup_b", input: {} },
				],
				reasoning_details: [
					{ type: "reasoning.text", id: "toolu_05", text: "t", index: 0 },
					{ type: "reasoning.encrypted", id: "toolu_06", data: "orig-enc", index: 1 },
				],
			}
			const assistantTwo = {
				role: "assistant" as const,
				content: [
					{ type: "tool_use" as const, id: "toolu_07", name: "lookup_c", input: {} },
					{ type: "tool_use" as const, id: "toolu_08", name: "lookup_d", input: {} },
				],
				reasoning_details: [
					{ type: "reasoning.encrypted", id: "toolu_07", data: "enc-7", index: 0 },
					{ type: "reasoning.encrypted", id: "toolu_08", data: "enc-8", index: 1 },
				],
			}
			const stream = handler.createMessage("system", [
				assistantOne as unknown as Anthropic.Messages.MessageParam,
				assistantTwo as unknown as Anthropic.Messages.MessageParam,
			])
			await collectStream(stream)

			const params = mockCreate.mock.calls[0][0] as {
				messages: {
					role: string
					tool_calls?: { id: string }[]
					reasoning_details?: { type: string; data?: string }[]
				}[]
			}
			const assistants = params.messages.filter((m) => m.role === "assistant")
			expect(assistants).toHaveLength(2)
			expect(assistants[0].tool_calls).toHaveLength(2)
			const firstEncrypted =
				assistants[0].reasoning_details?.filter((d) => d.type === "reasoning.encrypted") ?? []
			expect(firstEncrypted).toHaveLength(1)
			expect(firstEncrypted[0]).toMatchObject({ data: "orig-enc" })
			expect(assistants[1].tool_calls).toHaveLength(2)
			const secondEncrypted =
				assistants[1].reasoning_details?.filter((d) => d.type === "reasoning.encrypted") ?? []
			expect(secondEncrypted).toHaveLength(2)
		})

		it("keeps the last usage chunk when later chunks carry no usage", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{
						id: "1",
						choices: [],
						usage: {
							prompt_tokens: 10,
							completion_tokens: 5,
							cost: 2,
							cost_details: { upstream_inference_cost: 3 },
						},
					},
					{ id: "2", choices: [{ delta: { content: "ok" } }] },
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const chunks = await collectStream(
				handler.createMessage("system", [{ role: "user" as const, content: "hi" }]),
			)
			const usage = chunks.find((c) => c.type === "usage")
			expect(usage).toMatchObject({ type: "usage", inputTokens: 10, outputTokens: 5, totalCost: 5 })
		})

		it("merges id, format and signature into an existing reasoning detail", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{
						id: "1",
						choices: [
							{ delta: { reasoning_details: [{ type: "reasoning.text", index: 0, text: "start" }] } },
						],
					},
					{
						id: "2",
						choices: [
							{
								delta: {
									reasoning_details: [
										{
											type: "reasoning.text",
											index: 0,
											text: "more",
											id: "det-1",
											format: "google-gemini-v1",
											signature: "sig-1",
										},
									],
								},
							},
						],
					},
					{ id: "3", choices: [{ delta: { content: "ok" } }] },
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const chunks = await collectStream(
				handler.createMessage("system", [{ role: "user" as const, content: "hi" }]),
			)
			expect(chunks).toContainEqual({ type: "reasoning", text: "start" })
			const details = handler.getReasoningDetails()
			expect(details).toHaveLength(1)
			expect(details?.[0]).toMatchObject({
				type: "reasoning.text",
				text: "startmore",
				id: "det-1",
				format: "google-gemini-v1",
				signature: "sig-1",
				index: 0,
			})
		})

		it("ignores non-string text and summary values in reasoning details", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{
						id: "1",
						choices: [
							{
								delta: {
									reasoning_details: [
										{ type: "reasoning.encrypted", index: 0, text: "secret", data: "enc" },
										{ type: "reasoning.text", index: 1, text: 5 },
										{ type: "reasoning.text", index: 2, summary: "leak" },
										{ type: "reasoning.summary", index: 3, summary: 7 },
										{ type: "reasoning.summary", index: 4, summary: "sum-ok" },
										{ type: "reasoning.text", index: 5, text: "text-ok" },
									],
								},
							},
						],
					},
					{ id: "2", choices: [{ delta: { content: "ok" } }] },
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const chunks = await collectStream(
				handler.createMessage("system", [{ role: "user" as const, content: "hi" }]),
			)
			expect(chunks.filter((c) => c.type === "reasoning")).toEqual([
				{ type: "reasoning", text: "sum-ok" },
				{ type: "reasoning", text: "text-ok" },
			])
		})

		it("yields top-level reasoning only for non-empty string values", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{ id: "1", choices: [{ delta: { reasoning: 5 } }] },
					{ id: "2", choices: [{ delta: { reasoning: "" } }] },
					{ id: "3", choices: [{ delta: { reasoning: "top" } }] },
					{ id: "4", choices: [{ delta: { content: "ok" } }] },
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const chunks = await collectStream(
				handler.createMessage("system", [{ role: "user" as const, content: "hi" }]),
			)
			expect(chunks.filter((c) => c.type === "reasoning")).toEqual([{ type: "reasoning", text: "top" }])
			expect(chunks).toContainEqual({ type: "text", text: "ok" })
		})

		it("skips top-level reasoning once reasoning details have yielded displayable text", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{
						id: "1",
						choices: [
							{ delta: { reasoning_details: [{ type: "reasoning.text", index: 0, text: "det" }] } },
						],
					},
					{ id: "2", choices: [{ delta: { reasoning: "top" } }] },
					{ id: "3", choices: [{ delta: { content: "ok" } }] },
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const chunks = await collectStream(
				handler.createMessage("system", [{ role: "user" as const, content: "hi" }]),
			)
			expect(chunks.filter((c) => c.type === "reasoning")).toEqual([{ type: "reasoning", text: "det" }])
			expect(chunks).toContainEqual({ type: "text", text: "ok" })
		})

		it("ignores non-array tool_calls values in stream deltas", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{ id: "1", choices: [{ delta: { tool_calls: "nope", content: "x" } }] },
					{ id: "2", choices: [{ delta: { content: "ok" } }] },
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const chunks = await collectStream(
				handler.createMessage("system", [{ role: "user" as const, content: "hi" }]),
			)
			expect(chunks.some((c) => c.type === "tool_call_partial")).toBe(false)
			expect(chunks).toContainEqual({ type: "text", text: "x" })
		})

		it("emits tool_call_partial chunks for tool calls without a function payload", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue(
				asyncStreamFrom([
					{ id: "1", choices: [{ delta: { tool_calls: [{ index: 0, id: "c1" }], content: "x" } }] },
					{ id: "2", choices: [{ delta: { content: "ok" } }] },
				]),
			)
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const chunks = await collectStream(
				handler.createMessage("system", [{ role: "user" as const, content: "hi" }]),
			)
			expect(chunks).toContainEqual(expect.objectContaining({ type: "tool_call_partial", id: "c1", index: 0 }))
		})

		it("reports OpenRouter structured errors in createMessage with telemetry", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockRejectedValueOnce({
				error: {
					message: "Model not found",
					code: 404,
					metadata: { raw: '{"message":"upstream: model not found"}' },
				},
			})
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const generator = handler.createMessage("system", [{ role: "user" as const, content: "hi" }])

			await expect(generator.next()).rejects.toThrow(/completion error/)
			expect(mockCaptureException).toHaveBeenCalledTimes(1)
		})

		it("prefers the raw metadata message over the SDK error message in createMessage telemetry", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockRejectedValueOnce({
				error: {
					message: "Model not found",
					code: 404,
					metadata: { raw: '{"message":"upstream: model not found"}' },
				},
			})
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const generator = handler.createMessage("system", [{ role: "user" as const, content: "hi" }])

			await expect(generator.next()).rejects.toThrow(/completion error/)
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "upstream: model not found",
					provider: providerIdentifiers.openrouter,
					modelId: "anthropic/claude-sonnet-4",
					operation: "createMessage",
					status: 404,
				}),
			)
		})

		it("falls back to the SDK error message in createMessage telemetry when no raw metadata is present", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockRejectedValueOnce({
				error: {
					message: "Model not found",
					code: 404,
				},
			})
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const generator = handler.createMessage("system", [{ role: "user" as const, content: "hi" }])

			await expect(generator.next()).rejects.toThrow(/completion error/)
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Model not found",
					provider: providerIdentifiers.openrouter,
					modelId: "anthropic/claude-sonnet-4",
					operation: "createMessage",
				}),
			)
		})

		it("falls back to an unknown error in createMessage telemetry when no message is available", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockRejectedValueOnce({
				error: {
					code: 500,
				},
			})
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const generator = handler.createMessage("system", [{ role: "user" as const, content: "hi" }])

			await expect(generator.next()).rejects.toThrow(/completion error/)
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Unknown error",
					provider: providerIdentifiers.openrouter,
					modelId: "anthropic/claude-sonnet-4",
					operation: "createMessage",
				}),
			)
		})
	})

	describe("completePrompt", () => {
		it("returns correct response", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockResponse = { choices: [{ message: { content: "test completion" } }] }

			const mockCreate = vitest.fn().mockResolvedValue(mockResponse)
			// Typed per-instance injection: a prototype mutation would outlive the test
			// and hand later tests a stale mockCreate.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const result = await handler.completePrompt("test prompt")

			expect(result).toBe("test completion")

			expect(mockCreate).toHaveBeenCalledWith(
				{
					model: mockOptions.openRouterModelId,
					max_tokens: 8192,
					temperature: 0,
					messages: [{ role: "user", content: "test prompt" }],
					stream: false,
				},
				{ headers: { "x-anthropic-beta": "fine-grained-tool-streaming-2025-05-14" } },
			)
		})

		it("handles API errors and captures telemetry", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockError = {
				error: {
					message: "API Error",
					code: 500,
				},
			}

			const mockCreate = vitest.fn().mockResolvedValue(mockError)
			// Typed per-instance injection: a prototype mutation would outlive the test
			// and hand later tests a stale mockCreate.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			await expect(handler.completePrompt("test prompt")).rejects.toThrow("OpenRouter API Error 500: API Error")

			// Verify telemetry was captured
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "API Error",
					provider: providerIdentifiers.openrouter,
					modelId: mockOptions.openRouterModelId,
					operation: "completePrompt",
					errorCode: 500,
					status: 500,
				}),
			)
		})

		it("handles unexpected errors and captures telemetry", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const error = new Error("Unexpected error")
			const mockCreate = vitest.fn().mockRejectedValue(error)
			// Typed per-instance injection: a prototype mutation would outlive the test
			// and hand later tests a stale mockCreate.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			await expect(handler.completePrompt("test prompt")).rejects.toThrow("Unexpected error")

			// Verify telemetry was captured (filtering now happens inside PostHogTelemetryClient)
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Unexpected error",
					provider: providerIdentifiers.openrouter,
					modelId: mockOptions.openRouterModelId,
					operation: "completePrompt",
				}),
			)
		})

		it("passes SDK exceptions with status 429 to telemetry (filtering happens in PostHogTelemetryClient)", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const error = Object.assign(new Error("Rate limit exceeded: free-models-per-day"), { status: 429 })
			const mockCreate = vitest.fn().mockRejectedValue(error)
			// Typed per-instance injection: a prototype mutation would outlive the test
			// and hand later tests a stale mockCreate.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			await expect(handler.completePrompt("test prompt")).rejects.toThrow("Rate limit exceeded")

			// captureException is called, but PostHogTelemetryClient filters out 429 errors internally
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Rate limit exceeded: free-models-per-day",
					provider: providerIdentifiers.openrouter,
					modelId: mockOptions.openRouterModelId,
					operation: "completePrompt",
				}),
			)
		})

		it("passes SDK exceptions with 429 in message to telemetry (filtering happens in PostHogTelemetryClient)", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const error = new Error("429 Rate limit exceeded: free-models-per-day")
			const mockCreate = vitest.fn().mockRejectedValue(error)
			// Typed per-instance injection: a prototype mutation would outlive the test
			// and hand later tests a stale mockCreate.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			await expect(handler.completePrompt("test prompt")).rejects.toThrow("429 Rate limit exceeded")

			// captureException is called, but PostHogTelemetryClient filters out 429 errors internally
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "429 Rate limit exceeded: free-models-per-day",
					provider: providerIdentifiers.openrouter,
					modelId: mockOptions.openRouterModelId,
					operation: "completePrompt",
				}),
			)
		})

		it("passes SDK exceptions containing 'rate limit' to telemetry (filtering happens in PostHogTelemetryClient)", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const error = new Error("Request failed due to rate limit")
			const mockCreate = vitest.fn().mockRejectedValue(error)
			// Typed per-instance injection: a prototype mutation would outlive the test
			// and hand later tests a stale mockCreate.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			await expect(handler.completePrompt("test prompt")).rejects.toThrow("rate limit")

			// captureException is called, but PostHogTelemetryClient filters out rate limit errors internally
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Request failed due to rate limit",
					provider: providerIdentifiers.openrouter,
					modelId: mockOptions.openRouterModelId,
					operation: "completePrompt",
				}),
			)
		})

		it("passes 429 rate limit errors from response to telemetry (filtering happens in PostHogTelemetryClient)", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockError = {
				error: {
					message: "Rate limit exceeded",
					code: 429,
				},
			}

			const mockCreate = vitest.fn().mockResolvedValue(mockError)
			// Typed per-instance injection: a prototype mutation would outlive the test
			// and hand later tests a stale mockCreate.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			await expect(handler.completePrompt("test prompt")).rejects.toThrow(
				"OpenRouter API Error 429: Rate limit exceeded",
			)

			// captureException is called, but PostHogTelemetryClient filters out 429 errors internally
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Rate limit exceeded",
					provider: providerIdentifiers.openrouter,
					modelId: mockOptions.openRouterModelId,
					operation: "completePrompt",
					errorCode: 429,
					status: 429,
				}),
			)
		})
		it("should pass abort signal through to client", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const controller = new AbortController()
			const mockCreate = vitest.fn().mockResolvedValue({ choices: [{ message: { content: "response" } }] })
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			await handler.completePrompt("test prompt", { abortSignal: controller.signal })
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ model: expect.any(String) }),
				expect.objectContaining({ signal: controller.signal }),
			)
		})

		it("should pass timeout through to client", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue({ choices: [{ message: { content: "response" } }] })
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			await handler.completePrompt("test prompt", { timeoutMs: 5000 })
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ model: expect.any(String) }),
				expect.objectContaining({ timeout: 5000 }),
			)
		})

		it("normalizes the per-request timeout before handing it to the SDK", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue({ choices: [{ message: { content: "response" } }] })
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			// Fractional delays fail the SDK's integer validation: round up.
			await handler.completePrompt("test prompt", { timeoutMs: 1500.4 })
			expect(mockCreate.mock.calls[0][1]).toMatchObject({ timeout: 1501 })

			// Non-finite delays are not a timeout at all: omit the option.
			mockCreate.mockClear()
			await handler.completePrompt("test prompt", { timeoutMs: Number.POSITIVE_INFINITY })
			expect(mockCreate.mock.calls[0][1]).not.toHaveProperty("timeout")

			// Node clamps overflowing delays to 1 ms: cap them at the uint32 max.
			mockCreate.mockClear()
			await handler.completePrompt("test prompt", { timeoutMs: 9_000_000_000_000 })
			expect(mockCreate.mock.calls[0][1]).toMatchObject({ timeout: 2_147_483_647 })
		})

		it("should work without options (backward compatible)", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue({ choices: [{ message: { content: "response" } }] })
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const result = await handler.completePrompt("test prompt")
			expect(result).toBe("response")
		})

		it("omits the anthropic beta header for non-Anthropic models", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "openai/gpt-4o",
				}),
			)
			const mockCreate = vitest.fn().mockResolvedValue({ choices: [{ message: { content: "response" } }] })
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			await handler.completePrompt("test prompt")
			const options = mockCreate.mock.calls[0][1] as { headers?: Record<string, string> }
			expect(options).not.toHaveProperty("headers")
		})

		it("omits the signal and timeout options when timeoutMs is zero and no signal is provided", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue({ choices: [{ message: { content: "response" } }] })
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			await handler.completePrompt("test prompt", { timeoutMs: 0 })
			const options = mockCreate.mock.calls[0][1] as { signal?: AbortSignal; timeout?: number }
			expect(options).not.toHaveProperty("signal")
			expect(options).not.toHaveProperty("timeout")
		})

		it("propagates non-abort model-discovery failures from completePrompt", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue({ choices: [{ message: { content: "response" } }] })
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			// The constructor's background discovery consumed the default mock; make the next
			// lookup (completePrompt's own fetchModel) reject with a non-abort failure.
			const { getModels } = await import("../fetchers/modelCache")
			vitest.mocked(getModels).mockRejectedValueOnce(new Error("discovery failed"))

			await expect(handler.completePrompt("test prompt")).rejects.toThrow("discovery failed")
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("propagates an abort-named model-discovery failure unchanged in completePrompt", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue({ choices: [{ message: { content: "response" } }] })
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			// The constructor's background discovery consumed the default mock; make the next
			// lookup (completePrompt's own fetchModel) reject with an abort-named failure.
			const { getModels } = await import("../fetchers/modelCache")
			vitest.mocked(getModels).mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }))

			// An abort-shaped discovery failure with no caller cancellation is a
			// discovery failure: it keeps its original identity instead of being
			// reported as a cancellation.
			await expect(handler.completePrompt("test prompt")).rejects.toMatchObject({
				name: "AbortError",
				message: "aborted",
			})
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("rejects with AbortError when the request aborts before a late result lands", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const controller = new AbortController()

			// Deterministic synchronization: the mock notifies the test when create() has been
			// called, so the abort lands after model discovery instead of racing it.
			let notifyCreateStarted!: () => void
			const createStarted = new Promise<void>((resolve) => {
				notifyCreateStarted = resolve
			})
			let resolveCreate!: (value: unknown) => void
			const mockCreate = vitest.fn().mockImplementation(() => {
				notifyCreateStarted()
				return new Promise((resolve) => {
					resolveCreate = resolve
				})
			})
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const promise = handler.completePrompt("test prompt", { abortSignal: controller.signal })
			await createStarted
			controller.abort()
			resolveCreate({ choices: [{ message: { content: "late result" } }] })

			await expect(promise).rejects.toMatchObject({
				name: "AbortError",
				message: "The OpenRouter request was aborted",
			})
		})

		it("rejects with AbortError when the signal is pre-aborted", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockResolvedValue({ choices: [{ message: { content: "response" } }] })
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			// The catalog loads lazily via ensureModelFetched(), so a fresh handler has not
			// started a discovery lookup; the pre-abort guard must reject without starting one.
			const { getModels } = await import("../fetchers/modelCache")
			const lookupsBefore = vitest.mocked(getModels).mock.calls.length

			const controller = new AbortController()
			controller.abort()

			await expect(
				handler.completePrompt("test prompt", { abortSignal: controller.signal }),
			).rejects.toMatchObject({
				name: "AbortError",
				message: "The OpenRouter request was aborted",
			})
			expect(vitest.mocked(getModels).mock.calls.length).toBe(lookupsBefore)
		})

		it("rejects with AbortError when aborted mid-flight", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const controller = new AbortController()

			// Wait for create() to actually start before aborting: aborting during
			// model lookup would exercise the discovery race instead of the
			// in-flight SDK catch path this test names.
			let notifyCreateStarted!: () => void
			const createStarted = new Promise<void>((resolve) => {
				notifyCreateStarted = resolve
			})
			const mockCreate = vitest
				.fn()
				.mockImplementation(async (_params: unknown, options?: { signal?: AbortSignal }) => {
					notifyCreateStarted()
					// Emulate the OpenAI SDK: the in-flight request rejects when the signal aborts.
					await new Promise<void>((resolve) => {
						if (options?.signal?.aborted) {
							resolve()
						} else {
							options?.signal?.addEventListener("abort", () => resolve(), { once: true })
						}
					})
					const abortError = new Error("The user aborted a request")
					abortError.name = "AbortError"
					throw abortError
				})
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const promise = handler.completePrompt("test prompt", { abortSignal: controller.signal })
			await createStarted
			controller.abort()

			await expect(promise).rejects.toMatchObject({
				name: "AbortError",
				message: "The OpenRouter request was aborted",
			})
			// The in-flight catch path must have run: create() was entered exactly once.
			expect(mockCreate).toHaveBeenCalledTimes(1)
		})
		it("rejects with AbortError when only a timeout is provided and it elapses", async () => {
			// Non-Anthropic model: also exercises the no-beta-header branch of requestOptions.
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterModelId: "openai/gpt-4o",
				}),
			)
			const mockCreate = vitest
				.fn()
				.mockImplementation(async (_params: unknown, options?: { signal?: AbortSignal }) => {
					// Emulate the OpenAI SDK: the in-flight request rejects when the signal times out.
					await new Promise<void>((resolve) => {
						if (options?.signal?.aborted) {
							resolve()
						} else {
							options?.signal?.addEventListener("abort", () => resolve(), { once: true })
						}
					})
					const timeoutError = new Error("TimeoutError: Request timed out.")
					timeoutError.name = "TimeoutError"
					throw timeoutError
				})
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			await expect(handler.completePrompt("test prompt", { timeoutMs: 50 })).rejects.toMatchObject({
				name: "AbortError",
			})
		})

		it("rejects with AbortError when both an abort signal and a timeout are provided", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const controller = new AbortController()

			// Deterministic synchronization: the mock notifies the test when the request
			// actually starts, so the abort lands mid-flight (after model lookup) instead of
			// winning the race at model discovery on a slow runner.
			let notifyCreateStarted!: () => void
			const createStarted = new Promise<void>((resolve) => {
				notifyCreateStarted = resolve
			})
			let requestSignal: AbortSignal | undefined
			const mockCreate = vitest
				.fn()
				.mockImplementation(async (_params: unknown, options?: { signal?: AbortSignal }) => {
					notifyCreateStarted()
					requestSignal = options?.signal
					await new Promise<void>((resolve) => {
						if (options?.signal?.aborted) {
							resolve()
						} else {
							options?.signal?.addEventListener("abort", () => resolve(), { once: true })
						}
					})
					const abortError = new Error("The user aborted a request")
					abortError.name = "AbortError"
					throw abortError
				})
			// The auto-mocked OpenAI client is injected via a structural type to avoid `any` casts.
			const client = handler["client"] as unknown as { chat: { completions: { create: typeof mockCreate } } }
			Object.defineProperty(client, "chat", {
				value: { completions: { create: mockCreate } },
				configurable: true,
				writable: true,
			})

			const promise = handler.completePrompt("test prompt", {
				abortSignal: controller.signal,
				timeoutMs: 100_000,
			})
			// Abort only once create() has actually started (after model lookup).
			await createStarted
			controller.abort()

			await expect(promise).rejects.toMatchObject({
				name: "AbortError",
				message: "The OpenRouter request was aborted",
			})
			// The SDK received a merged signal (not the caller's signal) plus the timeout.
			expect(requestSignal).toBeDefined()
			expect(requestSignal).not.toBe(controller.signal)
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ model: expect.any(String) }),
				expect.objectContaining({ timeout: 100_000 }),
			)
		})
	})

	describe("model catalog", () => {
		it("reports its cache scope", () => {
			const handler = new OpenRouterHandler(mockOptions)
			expect(handler.getModelCacheScope()).toEqual({ urlScoped: false, keyScoped: false, authScoped: false })
		})

		it("does not fetch the catalog in the constructor", async () => {
			const { getModels } = await import("../fetchers/modelCache")

			new OpenRouterHandler(mockOptions)

			expect(getModels).not.toHaveBeenCalled()
			expect(mockGetModelEndpoints).not.toHaveBeenCalled()
		})

		it("populates models and endpoints when ensureModelFetched resolves", async () => {
			mockGetModelEndpoints.mockResolvedValue({
				moonshotai: {
					maxTokens: 1000,
					contextWindow: 2000,
					supportsPromptCache: false,
					description: "Moonshot endpoint",
				},
			})

			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterSpecificProvider: "moonshotai",
				}),
			)

			// Before the pre-warm both catalogs are empty, so getModel() falls back
			// to the hardcoded default info.
			expect(handler.getModel().info).toBe(openRouterDefaultModelInfo)

			await handler.ensureModelFetched()

			// The endpoint catalog is populated and selected for the specific provider.
			expect(handler.getModel().info.description).toBe("Moonshot endpoint")
			expect(handler.getModel().info.contextWindow).toBe(2000)

			// The model catalog is populated too: without a specific provider the
			// fetched record (not the hardcoded default) is used.
			const plainHandler = new OpenRouterHandler(mockOptions)
			await plainHandler.ensureModelFetched()
			expect(plainHandler.getModel().info.description).toBe("Claude 3.7 Sonnet")
		})

		it("retries while a selected provider's endpoint catalog is empty", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterSpecificProvider: "moonshotai",
				}),
			)

			// The model-level catalog resolves, but the endpoint request produced
			// nothing (e.g. it timed out). getModel() would fall back to the
			// model-level record, so the load must stay retryable.
			await handler.ensureModelFetched()
			expect(mockGetModelEndpoints).toHaveBeenCalledTimes(1)

			await handler.ensureModelFetched()
			expect(mockGetModelEndpoints).toHaveBeenCalledTimes(2)

			mockGetModelEndpoints.mockResolvedValue({
				moonshotai: {
					maxTokens: 1000,
					contextWindow: 2000,
					supportsPromptCache: false,
					description: "Moonshot endpoint",
				},
			})

			await handler.ensureModelFetched()
			expect(mockGetModelEndpoints).toHaveBeenCalledTimes(3)
			expect(handler.getModel().info.description).toBe("Moonshot endpoint")

			// Both catalogs are populated, so the load is now memoized.
			await handler.ensureModelFetched()
			expect(mockGetModelEndpoints).toHaveBeenCalledTimes(3)
		})

		it("keeps retrying when a lookup returns no models after an earlier partial load", async () => {
			const { getModels } = await import("../fetchers/modelCache")
			const mockedGetModels = vitest.mocked(getModels)

			mockGetModelEndpoints
				// Lookup 1: the model catalog arrives, the endpoint request produced nothing.
				.mockResolvedValueOnce({})
				// Lookup 2: the endpoints arrive, the model request answers an empty map.
				.mockResolvedValueOnce({ "provider-x": { ...openRouterDefaultModelInfo, maxTokens: 1000 } })
				// Lookup 3: both answers present, so the load is complete from here on.
				.mockResolvedValueOnce({ "provider-x": { ...openRouterDefaultModelInfo, maxTokens: 1000 } })

			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					openRouterApiKey: "test-key",
					openRouterModelId: "anthropic/claude-sonnet-4",
					openRouterSpecificProvider: "provider-x",
				}),
			)

			await handler.ensureModelFetched()
			expect(mockGetModelEndpoints).toHaveBeenCalledTimes(1)

			// The endpoint catalog fills in, but this lookup saw no models. The records from lookup 1
			// are still published, so judging by the published maps would call this load complete;
			// the load must stay retryable because the answer it got was empty.
			mockedGetModels.mockResolvedValueOnce({})
			await handler.ensureModelFetched()
			expect(mockGetModelEndpoints).toHaveBeenCalledTimes(2)

			await handler.ensureModelFetched()
			expect(mockGetModelEndpoints).toHaveBeenCalledTimes(3)
			expect(handler.getModel().info.maxTokens).toBe(1000)

			// A load that answered both catalogs is memoized.
			await handler.ensureModelFetched()
			expect(mockGetModelEndpoints).toHaveBeenCalledTimes(3)
			expect(mockedGetModels).toHaveBeenCalledTimes(3)
		})

		it("memoizes the default-provider load even when the endpoint catalog is empty", async () => {
			const handler = new OpenRouterHandler(mockOptions)

			await handler.ensureModelFetched()
			await handler.ensureModelFetched()

			// Without a selected provider the model-level catalog is what getModel()
			// uses, so an empty endpoint response must not force a refetch.
			expect(mockGetModelEndpoints).toHaveBeenCalledTimes(1)
		})

		it("treats the [default] provider sentinel as the default provider", async () => {
			const handler = new OpenRouterHandler(
				makeApiHandlerOptions({
					...mockOptions,
					openRouterSpecificProvider: OPENROUTER_DEFAULT_PROVIDER_NAME,
				}),
			)

			await handler.ensureModelFetched()
			await handler.ensureModelFetched()

			expect(mockGetModelEndpoints).toHaveBeenCalledTimes(1)
		})
	})
})
