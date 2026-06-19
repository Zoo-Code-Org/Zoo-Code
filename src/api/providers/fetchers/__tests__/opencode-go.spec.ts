// npx vitest run src/api/providers/fetchers/__tests__/opencode-go.spec.ts

import axios from "axios"

import { opencodeGoDefaultModelInfo, opencodeGoModels, getOpencodeGoModelInfo } from "@roo-code/types"

import { getOpencodeGoModels, parseOpencodeGoModel } from "../opencode-go"

vitest.mock("axios")
const mockedAxios = axios as any

describe("Opencode Go Fetchers", () => {
	beforeEach(() => {
		vitest.clearAllMocks()
	})

	describe("getOpencodeGoModels", () => {
		it("maps the /models response and sends the API key as a Bearer header", async () => {
			mockedAxios.get.mockResolvedValue({
				data: {
					data: [
						{
							id: "glm-5.1",
							name: "GLM-5.1",
							description: "Zhipu GLM 5.1",
							context_window: 202752,
							max_output_tokens: 32768,
						},
						{ id: "deepseek-v4-pro", context_length: 1048576 },
					],
				},
			})

			const models = await getOpencodeGoModels("test-key")

			expect(mockedAxios.get).toHaveBeenCalledWith("https://opencode.ai/zen/go/v1/models", {
				headers: { Authorization: "Bearer test-key" },
				timeout: 10_000,
			})

			expect(Object.keys(models).sort()).toEqual(["deepseek-v4-pro", "glm-5.1"])
			// Live endpoint values override the native registry for volatile fields,
			// while capability flags and pricing come from the native registry.
			expect(models["glm-5.1"]).toMatchObject({
				contextWindow: 202752,
				maxTokens: 32768,
				supportsPromptCache: true,
				supportsReasoningEffort: ["disable", "medium"],
				preserveReasoning: true,
				description: "Zhipu GLM 5.1",
			})
			expect(models["deepseek-v4-pro"].contextWindow).toBe(1048576)
			expect(models["deepseek-v4-pro"].supportsReasoningEffort).toEqual([
				"disable",
				"low",
				"medium",
				"high",
				"xhigh",
			])
		})

		it("uses native registry config for a curated model when metadata is absent", async () => {
			mockedAxios.get.mockResolvedValue({ data: { data: [{ id: "kimi-k2.6" }] } })

			const models = await getOpencodeGoModels("k")

			// kimi-k2.6 is curated, so it gets its native context/max tokens and
			// capability flags rather than the generic default fallback.
			expect(models["kimi-k2.6"]).toMatchObject({
				contextWindow: 262_144,
				maxTokens: 16_384,
				supportsPromptCache: true,
				supportsTemperature: true,
				defaultTemperature: 1.0,
			})
		})

		it("falls back to default context/max tokens for an unknown model when metadata is absent", async () => {
			mockedAxios.get.mockResolvedValue({ data: { data: [{ id: "some-unknown-model" }] } })

			const models = await getOpencodeGoModels("k")

			expect(models["some-unknown-model"]).toMatchObject({
				contextWindow: opencodeGoDefaultModelInfo.contextWindow,
				maxTokens: opencodeGoDefaultModelInfo.maxTokens,
				supportsPromptCache: false,
			})
		})

		it("returns an empty map on network error", async () => {
			mockedAxios.get.mockRejectedValue(new Error("network"))
			expect(await getOpencodeGoModels("k")).toEqual({})
		})

		it("falls back to an empty array when response.data.data is not an array", async () => {
			mockedAxios.get.mockResolvedValue({ data: { data: null } })
			expect(await getOpencodeGoModels("k")).toEqual({})
		})

		it("skips entries that fail safeParse with a console.warn", async () => {
			mockedAxios.get.mockResolvedValue({
				data: {
					data: [
						{ id: "valid-model", context_window: 50000 },
						{ not_a_field: true }, // no `id` — will fail safeParse
					],
				},
			})
			const warnSpy = vitest.spyOn(console, "warn").mockImplementation(function () {})

			const models = await getOpencodeGoModels("k")

			expect(Object.keys(models)).toEqual(["valid-model"])
			// Two warns: one for the outer schema mismatch, one for the invalid item
			expect(warnSpy).toHaveBeenCalledTimes(2)
			expect(warnSpy.mock.calls[0][0]).toContain("did not match expected schema")
			expect(warnSpy.mock.calls[1][0]).toContain("Skipping invalid Opencode Go model entry")

			warnSpy.mockRestore()
		})
	})

	describe("parseOpencodeGoModel", () => {
		it("merges live endpoint values over the native registry for a curated model", () => {
			const info = parseOpencodeGoModel({ id: "glm-5.1", context_window: 150000, max_output_tokens: 8000 })
			// Live values win for volatile fields.
			expect(info.contextWindow).toBe(150000)
			expect(info.maxTokens).toBe(8000)
			// Capability flags and pricing come from the native registry.
			expect(info.supportsPromptCache).toBe(true)
			expect(info.supportsMaxTokens).toBe(true)
			expect(info.supportsReasoningEffort).toEqual(["disable", "medium"])
			expect(info.preserveReasoning).toBe(true)
			expect(info.inputPrice).toBe(1.4)
		})

		it("uses native registry defaults when the live payload omits volatile fields", () => {
			const info = parseOpencodeGoModel({ id: "deepseek-v4-flash" })
			const native = getOpencodeGoModelInfo("deepseek-v4-flash")!
			expect(info.contextWindow).toBe(native.contextWindow)
			expect(info.maxTokens).toBe(native.maxTokens)
			expect(info.supportsPromptCache).toBe(true)
			expect(info.preserveReasoning).toBe(true)
			expect(info.supportsReasoningEffort).toEqual(["disable", "low", "medium", "high", "xhigh"])
		})

		it("resolves GLM-5.2 with its 1M context and High/Max reasoning effort", () => {
			const info = parseOpencodeGoModel({ id: "glm-5.2" })
			expect(info.contextWindow).toBe(1_000_000)
			expect(info.maxTokens).toBe(131_072)
			expect(info.supportsPromptCache).toBe(true)
			expect(info.supportsMaxTokens).toBe(true)
			expect(info.supportsReasoningEffort).toEqual(["disable", "high", "max"])
			expect(info.reasoningEffort).toBe("high")
			expect(info.preserveReasoning).toBe(true)
			expect(info.inputPrice).toBe(1.4)
			expect(info.outputPrice).toBe(4.4)
		})

		it("falls back to defaults for an unknown model with no cache pricing", () => {
			const info = parseOpencodeGoModel({ id: "x", context_window: 100000, max_tokens: 8000 })
			expect(info.supportsPromptCache).toBe(false)
			expect(info.contextWindow).toBe(100000)
			expect(info.maxTokens).toBe(8000)
		})

		it("falls back to default context/max tokens for an unknown model with no metadata", () => {
			const info = parseOpencodeGoModel({ id: "unknown-model" })
			expect(info.contextWindow).toBe(opencodeGoDefaultModelInfo.contextWindow)
			expect(info.maxTokens).toBe(opencodeGoDefaultModelInfo.maxTokens)
			expect(info.supportsPromptCache).toBe(false)
		})

		it("every curated model in the registry produces a fully-populated ModelInfo", () => {
			for (const [id, native] of Object.entries(opencodeGoModels)) {
				const info = parseOpencodeGoModel({ id })
				expect(info.contextWindow).toBe(native.contextWindow)
				expect(info.maxTokens).toBe(native.maxTokens)
				expect(info.supportsPromptCache).toBe(native.supportsPromptCache)
				expect(info.description).toBeTruthy()
			}
		})
	})
})
