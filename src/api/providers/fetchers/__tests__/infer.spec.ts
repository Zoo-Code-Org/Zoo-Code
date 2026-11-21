import axios from "axios"

import { INFER_CATALOG_URL, openAiModelInfoSaneDefaults } from "@roo-code/types"

import { getInferModels } from "../infer"

vi.mock("axios")

/** A route as the public catalog publishes it, with overridable fields. */
const route = (selector: string, overrides: Record<string, unknown> = {}) => ({
	selector,
	available: true,
	input_per_million_usd: 2,
	cached_input_per_million_usd: 0.2,
	cache_write_per_million_usd: 2.5,
	output_per_million_usd: 10,
	runtime: { max_context_tokens: null, max_output_tokens: null, vision: false, tools: true, streaming: true },
	...overrides,
})

/** A text model with model-level limits and the given routes. */
const model = (slug: string, tiers: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
	slug,
	name: slug,
	kind: "exact",
	runtime: { max_context_tokens: 200_000, max_output_tokens: 64_000, vision: false, tools: true, streaming: true },
	tiers,
	...overrides,
})

const mockCatalog = (models: unknown[]) => vi.mocked(axios.get).mockResolvedValue({ data: { models } })

describe("Infer model fetcher", () => {
	beforeEach(() => vi.clearAllMocks())

	it("requests the public catalog without credentials", async () => {
		mockCatalog([])
		await getInferModels()
		expect(axios.get).toHaveBeenCalledWith(INFER_CATALOG_URL, { timeout: 10_000, signal: undefined })
	})

	it("forwards the caller's abort signal to the request", async () => {
		mockCatalog([])
		const controller = new AbortController()

		await getInferModels({ signal: controller.signal })

		expect(axios.get).toHaveBeenCalledWith(INFER_CATALOG_URL, { timeout: 10_000, signal: controller.signal })
	})

	it("rejects with an AbortError when the signal aborts the pending request", async () => {
		const controller = new AbortController()
		vi.mocked(axios.get).mockImplementation((_url, config) => {
			// Mirror the HTTP client: a pending request rejects when its signal fires.
			return new Promise<never>((_resolve, reject) => {
				config?.signal?.addEventListener?.("abort", () => reject(new Error("canceled")), { once: true })
			})
		})

		const fetchPromise = getInferModels({ signal: controller.signal })
		controller.abort()

		await expect(fetchPromise).rejects.toMatchObject({ name: "AbortError" })
	})

	it("lists each available route under its selector with exact per-million prices and route limits", async () => {
		mockCatalog([
			model("model-a", {
				"low-cost": route("infer/model-a:low-cost"),
				official: route("infer/model-a:official", {
					input_per_million_usd: 5,
					cached_input_per_million_usd: 0.5,
					cache_write_per_million_usd: 6.25,
					output_per_million_usd: 25,
					runtime: {
						max_context_tokens: 1_000_000,
						max_output_tokens: 128_000,
						vision: true,
						tools: true,
						streaming: true,
					},
				}),
			}),
		])

		const models = await getInferModels()

		expect(Object.keys(models)).toEqual(["infer/model-a:low-cost", "infer/model-a:official"])
		// A discount route publishes no limits of its own, so the model-level limits apply.
		expect(models["infer/model-a:low-cost"]).toEqual({
			contextWindow: 200_000,
			maxTokens: 64_000,
			supportsImages: false,
			supportsPromptCache: true,
			inputPrice: 2,
			outputPrice: 10,
			cacheReadsPrice: 0.2,
			cacheWritesPrice: 2.5,
			displayName: "model-a (Low cost)",
		})
		expect(models["infer/model-a:official"]).toEqual({
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			supportsImages: true,
			supportsPromptCache: true,
			inputPrice: 5,
			outputPrice: 25,
			cacheReadsPrice: 0.5,
			cacheWritesPrice: 6.25,
			displayName: "model-a (Official)",
		})
	})

	it.each([
		["omitted", undefined],
		["zero", 0],
	])("prices cache writes at the input rate when the cache-write rate is %s", async (_label, rate) => {
		const overrides: Record<string, unknown> =
			rate === undefined ? { cache_write_per_million_usd: undefined } : { cache_write_per_million_usd: rate }
		mockCatalog([model("model-a", { "low-cost": route("infer/model-a:low-cost", overrides) })])

		const models = await getInferModels()

		expect(models["infer/model-a:low-cost"].cacheWritesPrice).toBe(2)
	})

	it("omits the cache-write price when the route publishes no prices", async () => {
		mockCatalog([
			model("model-a", {
				"low-cost": route("infer/model-a:low-cost", {
					input_per_million_usd: undefined,
					cache_write_per_million_usd: undefined,
				}),
			}),
		])

		const models = await getInferModels()

		expect(models["infer/model-a:low-cost"]).not.toHaveProperty("cacheWritesPrice")
	})

	it.each([
		["balanced", "Balanced"],
		["stable", "Stable"],
		["future-route", "future-route"],
		["constructor", "constructor"],
	])("labels the %s route as %s", async (routeId, label) => {
		mockCatalog([model("model-a", { [routeId]: route(`infer/model-a:${routeId}`) }, { name: "Model A" })])
		const models = await getInferModels()
		expect(models[`infer/model-a:${routeId}`].displayName).toBe(`Model A (${label})`)
	})

	it.each([
		"supportsReasoningEffort",
		"supportsReasoningBudget",
		"supportsReasoningBinary",
		"requiredReasoningEffort",
		"requiredReasoningBudget",
		"reasoningEffort",
		"preserveReasoning",
		"supportsMaxTokens",
	])("sets no %s flag on any route, so the settings show no reasoning control", async (flag) => {
		mockCatalog([
			model("model-a", {
				"low-cost": route("infer/model-a:low-cost"),
				official: route("infer/model-a:official", { runtime: { vision: true, tools: true, streaming: true } }),
			}),
		])

		const models = await getInferModels()

		expect(models["infer/model-a:low-cost"]).not.toHaveProperty(flag)
		expect(models["infer/model-a:official"]).not.toHaveProperty(flag)
	})

	it("falls back to the default context window and omits the output limit when no limit is published", async () => {
		mockCatalog([
			model(
				"model-b",
				{ stable: route("infer/model-b:stable", { cached_input_per_million_usd: 0 }) },
				{ name: undefined, runtime: { max_context_tokens: null, max_output_tokens: 0 } },
			),
		])

		const info = (await getInferModels())["infer/model-b:stable"]

		expect(info.contextWindow).toBe(openAiModelInfoSaneDefaults.contextWindow)
		expect(info).not.toHaveProperty("maxTokens")
		// No cache-read price means the route does not bill cached input separately.
		expect(info.supportsPromptCache).toBe(false)
		expect(info.displayName).toBe("model-b (Stable)")
	})

	it("skips generation models and routes that are unavailable, lack tools, or cannot stream", async () => {
		mockCatalog([
			model("video-model", { stable: route("infer/video-model:stable") }, { kind: "video_generation" }),
			model("image-model", { stable: route("infer/image-model:stable") }, { kind: "image_generation" }),
			model("text-model", {
				"low-cost": route("infer/text-model:low-cost"),
				balanced: route("infer/text-model:balanced", { available: false }),
				stable: route("infer/text-model:stable", { runtime: { tools: false } }),
				official: route("infer/text-model:official", { runtime: { streaming: false } }),
			}),
			model("unflagged-model", { stable: route("infer/unflagged-model:stable", { runtime: undefined }) }),
		])

		expect(Object.keys(await getInferModels())).toEqual([
			"infer/text-model:low-cost",
			"infer/unflagged-model:stable",
		])
	})

	it("leaves out Gemini routes and keeps the Claude ones", async () => {
		mockCatalog([
			model("gemini-3.8-flash", {
				"low-cost": route("infer/gemini-3.8-flash:low-cost"),
				official: route("infer/gemini-3.8-flash:official"),
			}),
			model("claude-opus-5-5", {
				"low-cost": route("infer/claude-opus-5-5:low-cost"),
				official: route("infer/claude-opus-5-5:official"),
			}),
		])

		expect(Object.keys(await getInferModels())).toEqual([
			"infer/claude-opus-5-5:low-cost",
			"infer/claude-opus-5-5:official",
		])
	})

	it("skips malformed models and routes", async () => {
		mockCatalog([
			{ name: "missing slug", tiers: {} },
			model("model-c", {
				"low-cost": route("infer/model-c:low-cost"),
				balanced: { available: true },
				stable: route("infer/model-c:stable", { input_per_million_usd: -1 }),
			}),
		])
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)

		expect(Object.keys(await getInferModels())).toEqual(["infer/model-c:low-cost"])
		expect(warning).toHaveBeenCalledTimes(3)
		warning.mockRestore()
	})

	it("keeps a hostile selector as an own entry instead of polluting the prototype chain", async () => {
		mockCatalog([model("hostile", { stable: route("__proto__"), official: route("constructor") })])
		const models = await getInferModels()
		expect(Object.getPrototypeOf(models)).toBeNull()
		expect(Object.keys(models)).toEqual(["__proto__", "constructor"])
		expect(models["__proto__"]).toMatchObject({ inputPrice: 2 })
		expect(({} as Record<string, unknown>).inputPrice).toBeUndefined()
	})

	it.each([{ models: null }, [], null])("returns no models for invalid top-level data %#", async (data) => {
		vi.mocked(axios.get).mockResolvedValue({ data })
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
		expect(await getInferModels()).toEqual({})
		warning.mockRestore()
	})

	it.each([new Error("network unavailable"), "network unavailable"])(
		"returns no models on network failure",
		async (error) => {
			vi.mocked(axios.get).mockRejectedValue(error)
			const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
			expect(await getInferModels()).toEqual({})
			expect(consoleError).toHaveBeenCalledWith("Error fetching Infer models: network unavailable")
			consoleError.mockRestore()
		},
	)
})
