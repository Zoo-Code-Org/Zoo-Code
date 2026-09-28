// npx vitest run api/providers/fetchers/__tests__/fireworks.spec.ts

import { fireworksModels } from "@roo-code/types"

import { FIREWORKS_MODELS_URL, getFireworksModels } from "../fireworks"

const mockFetchJson = (body: unknown) =>
	vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))

describe("getFireworksModels", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("requests the OpenAI-compatible models endpoint with the API key", async () => {
		const fetchSpy = mockFetchJson({ data: [] })

		await getFireworksModels("fw-key")

		expect(fetchSpy).toHaveBeenCalledWith(
			FIREWORKS_MODELS_URL,
			expect.objectContaining({
				headers: expect.objectContaining({ Authorization: "Bearer fw-key" }),
			}),
		)
		expect(FIREWORKS_MODELS_URL).toBe("https://api.fireworks.ai/inference/v1/models")
	})

	it("omits the Authorization header when no API key is provided", async () => {
		const fetchSpy = mockFetchJson({ data: [] })

		await getFireworksModels(undefined)

		const init = fetchSpy.mock.calls[0][1] as RequestInit
		expect((init.headers as Record<string, string>)["Authorization"]).toBeUndefined()
	})

	it("keeps curated static specs (including pricing) for known models", async () => {
		const knownId = "accounts/fireworks/models/kimi-k2p6"
		mockFetchJson({
			data: [
				{
					id: knownId,
					supports_chat: true,
					supports_image_input: false,
					supports_tools: true,
					context_length: 1,
				},
			],
		})

		const models = await getFireworksModels("fw-key")

		expect(models[knownId]).toEqual(fireworksModels[knownId])
	})

	it("builds model info from API metadata for unknown models without pricing", async () => {
		mockFetchJson({
			data: [
				{
					id: "accounts/fireworks/models/glm-5p3",
					supports_chat: true,
					supports_image_input: true,
					supports_tools: true,
					context_length: 1_048_576,
				},
			],
		})

		const models = await getFireworksModels("fw-key")

		expect(models["accounts/fireworks/models/glm-5p3"]).toEqual({
			maxTokens: 16_384,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: false,
			description: "Fireworks model: accounts/fireworks/models/glm-5p3",
		})
		expect(models["accounts/fireworks/models/glm-5p3"].inputPrice).toBeUndefined()
	})

	it("uses fallbacks when context length is missing and caps maxTokens to small windows", async () => {
		mockFetchJson({
			data: [
				{ id: "accounts/fireworks/routers/no-ctx", supports_chat: true },
				{ id: "accounts/fireworks/models/tiny", supports_chat: true, context_length: 8192 },
			],
		})

		const models = await getFireworksModels("fw-key")

		expect(models["accounts/fireworks/routers/no-ctx"]).toMatchObject({
			contextWindow: 128_000,
			maxTokens: 16_384,
			supportsImages: false,
		})
		expect(models["accounts/fireworks/models/tiny"]).toMatchObject({ contextWindow: 8192, maxTokens: 8192 })
	})

	it("skips non-chat models and entries without a valid id", async () => {
		mockFetchJson({
			data: [
				{ id: "accounts/fireworks/models/qwen3-embedding-8b", supports_chat: false },
				{ id: "" },
				{ id: 123 },
				null,
				{ id: "accounts/fireworks/models/ok", supports_chat: true, context_length: 32_000 },
			],
		})

		const models = await getFireworksModels("fw-key")

		expect(Object.keys(models)).toEqual(["accounts/fireworks/models/ok"])
	})

	it("throws for HTTP errors", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response('{"error":"bad key"}', { status: 401, statusText: "Unauthorized" }),
		)
		vi.spyOn(console, "error").mockImplementation(() => {})

		await expect(getFireworksModels("bad")).rejects.toThrow("HTTP 401: Unauthorized")
	})

	it("throws on unexpected response format", async () => {
		mockFetchJson({ data: "nope" })
		vi.spyOn(console, "error").mockImplementation(() => {})

		await expect(getFireworksModels("fw-key")).rejects.toThrow("Unexpected response format")
	})

	it("passes the caller's abort signal to the request", async () => {
		const fetchSpy = mockFetchJson({ data: [] })
		const controller = new AbortController()

		await getFireworksModels("fw-key", { signal: controller.signal })

		expect(fetchSpy).toHaveBeenCalledWith(
			FIREWORKS_MODELS_URL,
			expect.objectContaining({ signal: controller.signal }),
		)
	})

	it("rejects with the abort reason when the caller aborts a pending request", async () => {
		const controller = new AbortController()
		vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
			return new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
			})
		})

		const fetchPromise = getFireworksModels("fw-key", { signal: controller.signal })
		controller.abort(new Error("caller canceled"))

		await expect(fetchPromise).rejects.toThrow("caller canceled")
	})
})
