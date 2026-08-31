// npx vitest run api/providers/fetchers/__tests__/friendli.spec.ts

import axios from "axios"

import { getModelMaxOutputTokens } from "../../../../shared/api"

import { getFriendliModels, parseFriendliModel } from "../friendli"
import type { FriendliModel } from "../friendli"

vi.mock("axios")
const mockedAxios = vi.mocked(axios, { partial: true })

describe("Friendli Fetchers", () => {
	beforeEach(() => {
		vitest.clearAllMocks()
	})

	describe("getFriendliModels", () => {
		const mockResponse = {
			data: {
				data: [
					{
						id: "zai-org/GLM-5.2",
						name: "zai-org/GLM-5.2",
						created: 1776162486,
						context_length: 1048576,
						max_completion_tokens: 131072,
						pricing: {
							input: "0.0000014",
							output: "0.0000044",
							input_cache_read: "0.00000026",
							cache_write: "0.0000015",
						},
						functionality: {
							tool_call: true,
							parallel_tool_call: true,
							structured_output: true,
							tool_choice: true,
							system_messages: true,
						},
						description: "GLM-5.2 flagship model",
						reasoning: true,
						reasoning_options: [
							{ type: "toggle" },
							{ type: "effort", values: ["low", "medium", "high", "default"] },
							{ type: "budget_tokens", min: -1, max: 202752 },
						],
						input_modalities: ["text"],
						output_modalities: ["text"],
						mode: "chat",
					},
					{
						id: "deepseek-ai/DeepSeek-V3.2",
						name: "deepseek-ai/DeepSeek-V3.2",
						context_length: 163840,
						max_completion_tokens: 163840,
						pricing: {
							input: "0.0000005",
							output: "0.0000015",
							input_cache_read: "0.00000025",
						},
						functionality: {
							tool_call: true,
							parallel_tool_call: true,
							structured_output: true,
						},
						description: "DeepSeek V3.2",
						reasoning: false,
						input_modalities: ["text"],
						output_modalities: ["text"],
						mode: "chat",
					},
					{
						id: "some/embedding-model",
						context_length: 8192,
						max_completion_tokens: 8192,
						mode: "embedding",
						pricing: { input: "0.0000001", output: "0" },
					},
				],
			},
		}

		it("fetches and parses models correctly", async () => {
			mockedAxios.get.mockResolvedValueOnce(mockResponse)

			const models = await getFriendliModels()

			expect(mockedAxios.get).toHaveBeenCalledWith("https://api.friendli.ai/serverless/v1/models", {
				timeout: 10_000,
			})
			// Two chat models, embedding model filtered out
			expect(Object.keys(models)).toHaveLength(2)
			expect(models["zai-org/GLM-5.2"]).toBeDefined()
			expect(models["deepseek-ai/DeepSeek-V3.2"]).toBeDefined()
		})

		it("handles API errors gracefully", async () => {
			const consoleErrorSpy = vitest.spyOn(console, "error").mockImplementation(function () {})
			mockedAxios.get.mockRejectedValueOnce(new Error("Network error"))

			const models = await getFriendliModels()

			expect(models).toEqual({})
			expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Error fetching Friendli models"))
			consoleErrorSpy.mockRestore()
		})

		it("handles invalid response schema gracefully", async () => {
			const consoleErrorSpy = vitest.spyOn(console, "error").mockImplementation(function () {})
			mockedAxios.get.mockResolvedValueOnce({
				data: { invalid: "response" },
			})

			const models = await getFriendliModels()

			expect(models).toEqual({})
			expect(consoleErrorSpy).toHaveBeenCalled()
			consoleErrorSpy.mockRestore()
		})

		it("filters out non-chat models", async () => {
			mockedAxios.get.mockResolvedValueOnce({
				data: {
					data: [
						{
							id: "test/chat-model",
							context_length: 4096,
							max_completion_tokens: 2048,
							mode: "chat",
							pricing: { input: "0.0000001", output: "0.0000002" },
						},
						{
							id: "test/embedding-model",
							context_length: 4096,
							max_completion_tokens: 2048,
							mode: "embedding",
							pricing: { input: "0.0000001", output: "0" },
						},
					],
				},
			})

			const models = await getFriendliModels()

			expect(Object.keys(models)).toHaveLength(1)
			expect(models["test/chat-model"]).toBeDefined()
			expect(models["test/embedding-model"]).toBeUndefined()
		})
	})

	describe("parseFriendliModel", () => {
		const baseModel: FriendliModel = {
			id: "test/model",
			name: "test/model",
			context_length: 100000,
			max_completion_tokens: 8000,
			pricing: {
				input: "0.0000025",
				output: "0.00001",
			},
			description: "A test model",
			input_modalities: ["text"],
			output_modalities: ["text"],
			mode: "chat",
		}

		it("parses basic model info correctly", () => {
			const result = parseFriendliModel({ id: "test/model", model: baseModel })

			expect(result.maxTokens).toBe(8000)
			expect(result.contextWindow).toBe(100000)
			expect(result.supportsImages).toBe(false)
			expect(result.supportsPromptCache).toBe(false)
			expect(result.inputPrice).toBe(2.5) // 0.0000025 * 1_000_000 = 2.5
			expect(result.outputPrice).toBe(10) // 0.00001 * 1_000_000 = 10
			expect(result.cacheWritesPrice).toBeUndefined()
			expect(result.cacheReadsPrice).toBeUndefined()
			expect(result.description).toBe("A test model")
		})

		it("parses cache pricing when available", () => {
			const modelWithCache: FriendliModel = {
				...baseModel,
				pricing: {
					input: "0.0000030",
					output: "0.0000150",
					input_cache_read: "0.00000030",
					cache_write: "0.00000375",
				},
			}

			const result = parseFriendliModel({ id: "test/model", model: modelWithCache })

			expect(result.supportsPromptCache).toBe(true)
			expect(result.cacheWritesPrice).toBe(3.75)
			expect(result.cacheReadsPrice).toBe(0.3)
		})

		it("handles partial cache pricing (only read)", () => {
			const modelPartialCache: FriendliModel = {
				...baseModel,
				pricing: {
					input: "0.0000025",
					output: "0.00001",
					input_cache_read: "0.00000030",
				},
			}

			const result = parseFriendliModel({ id: "test/model", model: modelPartialCache })

			expect(result.supportsPromptCache).toBe(true)
			expect(result.cacheWritesPrice).toBeUndefined()
			expect(result.cacheReadsPrice).toBe(0.3)
		})

		it("falls back to max_completion_tokens * 5 for contextWindow when context_length is missing", () => {
			const { context_length: _unused, ...modelWithoutContextLength } = baseModel

			const result = parseFriendliModel({ id: "test/model", model: modelWithoutContextLength })

			// contextWindow must never be 0 here — a 0 window makes
			// getModelMaxOutputTokens clamp maxTokens to 0, and the API
			// rejects max_tokens: 0 with a 400. The *5 multiplier inverts the
			// 20% clamp so max_completion_tokens survives unclamped (see next test).
			expect(result.contextWindow).toBe(40000)
			expect(result.contextWindow).not.toBe(0)
		})

		it("keeps max_completion_tokens unclamped by getModelMaxOutputTokens when context_length is missing", () => {
			// Regression test for the actual bug the *5 fallback fixes: without
			// it, contextWindow === maxTokens === max_completion_tokens, and
			// getModelMaxOutputTokens's 20% clamp would silently cut max_tokens
			// to 20% of what the model can actually produce.
			const { context_length: _unused, ...modelWithoutContextLength } = baseModel

			const result = parseFriendliModel({ id: "test/model", model: modelWithoutContextLength })
			const maxOutputTokens = getModelMaxOutputTokens({
				modelId: "test/model",
				model: result,
				settings: {},
				format: "openai",
			})

			expect(maxOutputTokens).toBe(8000)
		})

		it("detects image support from input_modalities", () => {
			const visionModel: FriendliModel = {
				...baseModel,
				input_modalities: ["text", "image"],
			}

			const result = parseFriendliModel({ id: "test/model", model: visionModel })

			expect(result.supportsImages).toBe(true)
		})

		it("sets supportsReasoningEffort as array for controllable reasoning models", () => {
			const model: FriendliModel = {
				...baseModel,
				reasoning: true,
				reasoning_options: [
					{ type: "toggle" },
					{ type: "effort", values: ["low", "medium", "high", "default"] },
					{ type: "budget_tokens", min: -1, max: 8000 },
				],
			}

			const result = parseFriendliModel({ id: "test/model", model })

			// Only API-provided known values are preserved; "default" and unknown
			// values (e.g. "ultracode") are dropped.
			expect(result.supportsReasoningEffort).toEqual(["low", "medium", "high"])
			expect(result.supportsReasoningEffort).not.toContain("default")
			expect(result.reasoningEffort).toBe("high")
			expect(result.supportsMaxTokens).toBe(true)
		})

		it("sets supportsReasoningBinary for reasoning models without effort options", () => {
			const model: FriendliModel = {
				...baseModel,
				reasoning: true,
			}

			const result = parseFriendliModel({ id: "test/model", model })

			expect(result.supportsReasoningBinary).toBe(true)
			expect(result.supportsReasoningEffort).toBeUndefined()
			expect(result.reasoningEffort).toBeUndefined()
			// supportsMaxTokens is set for all reasoning models with max_completion_tokens
			expect(result.supportsMaxTokens).toBe(true)
		})

		it("drops unknown reasoning effort values like ultracode and de-duplicates", () => {
			const model: FriendliModel = {
				...baseModel,
				reasoning: true,
				reasoning_options: [
					{ type: "effort", values: ["low", "ultracode", "low", "high", "ultracode", "max", "default"] },
				],
			}

			const result = parseFriendliModel({ id: "test/model", model })

			// "ultracode" is not a known effort — dropped; "default" dropped;
			// duplicates removed; known values preserved in API order.
			expect(result.supportsReasoningEffort).toEqual(["low", "high", "max"])
		})

		it("returns binary reasoning when all effort values are unknown or default", () => {
			const model: FriendliModel = {
				...baseModel,
				reasoning: true,
				reasoning_options: [{ type: "effort", values: ["ultracode", "default"] }],
			}

			const result = parseFriendliModel({ id: "test/model", model })

			// All effort values filtered out -- instead of an empty array that would
			// default to "high" (unsupported by the API), fall back to binary reasoning.
			expect(result.supportsReasoningBinary).toBe(true)
			expect(result.supportsReasoningEffort).toBeUndefined()
			expect(result.reasoningEffort).toBeUndefined()
		})

		it("returns undefined for non-reasoning model with all effort values filtered", () => {
			const model: FriendliModel = {
				...baseModel,
				reasoning: false,
				reasoning_options: [{ type: "effort", values: ["ultracode", "default"] }],
			}

			const result = parseFriendliModel({ id: "test/model", model })

			expect(result.supportsReasoningBinary).toBeUndefined()
			expect(result.supportsReasoningEffort).toBeUndefined()
			expect(result.reasoningEffort).toBeUndefined()
		})

		it("sets supportsMaxTokens for non-reasoning models with max_completion_tokens", () => {
			const model: FriendliModel = {
				...baseModel,
				reasoning: false,
				max_completion_tokens: 8192,
			}

			const result = parseFriendliModel({ id: "test/model", model })

			expect(result.supportsMaxTokens).toBe(true)
		})

		it("omits supportsReasoningEffort for non-reasoning models", () => {
			const model: FriendliModel = {
				...baseModel,
				reasoning: false,
			}

			const result = parseFriendliModel({ id: "test/model", model })

			expect(result.supportsReasoningEffort).toBeUndefined()
		})

		it("does not mark models whose deprecation date is in the future", () => {
			const model: FriendliModel = {
				...baseModel,
				deprecation_date: "2099-01-01T00:00:00Z",
			}

			const result = parseFriendliModel({ id: "test/model", model })

			expect(result.deprecated).toBeUndefined()
		})

		it("marks models whose deprecation date has passed", () => {
			const model: FriendliModel = {
				...baseModel,
				deprecation_date: "2000-01-01T00:00:00Z",
			}

			const result = parseFriendliModel({ id: "test/model", model })

			expect(result.deprecated).toBe(true)
		})

		it("does not mark models without a deprecation date", () => {
			const result = parseFriendliModel({ id: "test/model", model: baseModel })

			expect(result.deprecated).toBeUndefined()
		})

		it("does not mark models with a null deprecation date", () => {
			const model: FriendliModel = {
				...baseModel,
				deprecation_date: null,
			}

			const result = parseFriendliModel({ id: "test/model", model })

			expect(result.deprecated).toBeUndefined()
		})

		it("fails safe on malformed deprecation dates (treated as deprecated)", () => {
			const model: FriendliModel = {
				...baseModel,
				deprecation_date: "not-a-date",
			}

			const result = parseFriendliModel({ id: "test/model", model })

			expect(result.deprecated).toBe(true)
		})

		it("handles empty description", () => {
			const model: FriendliModel = {
				...baseModel,
				description: " ",
			}

			const result = parseFriendliModel({ id: "test/model", model })

			expect(result.description).toBeUndefined()
		})

		it("falls back to prompt/completion pricing aliases", () => {
			const model: FriendliModel = {
				...baseModel,
				pricing: {
					prompt: "0.0000025",
					completion: "0.00001",
				},
			}

			const result = parseFriendliModel({ id: "test/model", model })

			expect(result.inputPrice).toBe(2.5)
			expect(result.outputPrice).toBe(10)
		})
	})
})
