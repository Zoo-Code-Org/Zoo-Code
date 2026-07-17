// npx vitest run src/api/providers/fetchers/__tests__/kenari.spec.ts

import axios from "axios"

import { kenariDefaultModelInfo } from "@roo-code/types"

import { getKenariModels, parseKenariModel } from "../kenari"

vitest.mock("axios")
const mockedAxios = axios as any

describe("Kenari Fetchers", () => {
	beforeEach(() => {
		vitest.clearAllMocks()
	})

	describe("getKenariModels", () => {
		it("maps the /models response and sends the API key as a Bearer header", async () => {
			mockedAxios.get.mockResolvedValue({
				data: {
					data: [
						{
							id: "glm-5-2",
							description: "Zhipu GLM 5.2",
							context_length: 1048576,
							modalities: { input: ["text"], output: ["text"] },
						},
						{
							id: "claude-sonnet-5",
							context_length: 1000000,
							modalities: { input: ["text", "image", "pdf"], output: ["text"] },
						},
					],
				},
			})

			const models = await getKenariModels("test-key")

			expect(mockedAxios.get).toHaveBeenCalledWith("https://kenari.id/v1/models", {
				headers: { Authorization: "Bearer test-key" },
				timeout: 10_000,
			})

			expect(Object.keys(models).sort()).toEqual(["claude-sonnet-5", "glm-5-2"])
			expect(models["glm-5-2"]).toMatchObject({
				contextWindow: 1048576,
				supportsImages: false,
				supportsPromptCache: false,
				description: "Zhipu GLM 5.2",
			})
			expect(models["claude-sonnet-5"]).toMatchObject({
				contextWindow: 1000000,
				supportsImages: true,
			})
		})

		it("falls back to default context/max tokens when metadata is absent", async () => {
			mockedAxios.get.mockResolvedValue({ data: { data: [{ id: "kimi-k2-7-code" }] } })

			const models = await getKenariModels("k")

			expect(models["kimi-k2-7-code"]).toMatchObject({
				contextWindow: kenariDefaultModelInfo.contextWindow,
				maxTokens: kenariDefaultModelInfo.maxTokens,
				supportsPromptCache: false,
			})
		})

		it("returns an empty map on network error", async () => {
			mockedAxios.get.mockRejectedValue(new Error("network"))
			expect(await getKenariModels("k")).toEqual({})
		})

		it("falls back to an empty array when response.data.data is not an array", async () => {
			mockedAxios.get.mockResolvedValue({ data: { data: null } })
			expect(await getKenariModels("k")).toEqual({})
		})

		it("skips entries that fail safeParse with a console.warn", async () => {
			mockedAxios.get.mockResolvedValue({
				data: {
					data: [
						{ id: "valid-model", context_window: 50000 },
						{ not_a_field: true }, // no `id`, so it will fail safeParse
					],
				},
			})
			const warnSpy = vitest.spyOn(console, "warn").mockImplementation(() => {})

			const models = await getKenariModels("k")

			expect(Object.keys(models)).toEqual(["valid-model"])
			// The surviving entry keeps its mapped metadata (context_window -> contextWindow),
			// so a field-mapping regression in this fallback branch is caught here.
			expect(models["valid-model"].contextWindow).toBe(50000)
			// Two warns: one for the outer schema mismatch, one for the invalid item
			expect(warnSpy).toHaveBeenCalledTimes(2)
			expect(warnSpy.mock.calls[0][0]).toContain("did not match expected schema")
			expect(warnSpy.mock.calls[1][0]).toContain("Skipping invalid Kenari model entry")

			warnSpy.mockRestore()
		})
	})

	describe("parseKenariModel", () => {
		it("sends no Authorization header when called without an API key", async () => {
			mockedAxios.get.mockResolvedValue({ data: { data: [] } })

			await getKenariModels()

			expect(mockedAxios.get).toHaveBeenCalledWith("https://kenari.id/v1/models", {
				headers: undefined,
				timeout: 10_000,
			})
		})

		it("returns an empty map on a non-Error rejection", async () => {
			mockedAxios.get.mockRejectedValue("boom")
			expect(await getKenariModels("k")).toEqual({})
		})

		it("falls back to the model name when no description is provided", () => {
			const info = parseKenariModel({ id: "x", name: "Model X" })
			expect(info.description).toBe("Model X")
		})

		it("prefers context_window over context_length and max_output_tokens over max_tokens", () => {
			const info = parseKenariModel({
				id: "dual",
				context_window: 111,
				context_length: 222,
				max_output_tokens: 33,
				max_tokens: 44,
			})
			expect(info.contextWindow).toBe(111)
			expect(info.maxTokens).toBe(33)
		})

		it("treats a model with no cache pricing as not cache-capable", () => {
			const info = parseKenariModel({ id: "x", context_window: 100000, max_tokens: 8000 })
			expect(info.supportsPromptCache).toBe(false)
			expect(info.contextWindow).toBe(100000)
			expect(info.maxTokens).toBe(8000)
		})
	})
})
