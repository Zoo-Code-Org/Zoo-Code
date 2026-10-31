// npx vitest run api/providers/fetchers/__tests__/fireworks.spec.ts
// Response fixtures mirror real payloads from /inference/v1/models, /v1/accounts and
// /v1/accounts/{id}/serverlessModels.

import {
	FIREWORKS_ACCOUNTS_URL,
	FIREWORKS_MODELS_URL,
	getFireworksModels,
	parseFireworksServerlessPricing,
} from "../fireworks"

const ACCOUNT = "accounts/acct-123"
const SERVERLESS_URL_PREFIX = `https://api.fireworks.ai/v1/${ACCOUNT}/serverlessModels`

const usd = (value: number) => ({
	currencyCode: "USD",
	units: String(Math.trunc(value)),
	nanos: Math.round((value - Math.trunc(value)) * 1e9),
})

const sku = (name: string, value: number) => ({ sku: name, amount: usd(value), unit: "1M tokens" })

const pricedMode = (
	name: string,
	prices: { input: number; output: number; cached?: number },
	extra: Record<string, unknown> = {},
) => ({
	name,
	serviceTier: "",
	usageIdentifier: "",
	skuInfos: [
		sku("LLM output tokens", prices.output),
		...(prices.cached !== undefined ? [sku("LLM input tokens (cached)", prices.cached)] : []),
		sku("LLM input tokens (uncached)", prices.input),
	],
	...extra,
})

const glmModel = {
	id: "accounts/fireworks/models/glm-5p3",
	supports_chat: true,
	supports_image_input: false,
	supports_tools: true,
	context_length: 1_048_576,
}

const serverlessModelsBody = {
	models: [
		{
			name: "accounts/fireworks/models/glm-5p3",
			serverlessModes: [
				pricedMode("accounts/fireworks/models/glm-5p3/serverlessModes/default", {
					input: 1.4,
					output: 4.4,
					cached: 0.26,
				}),
				pricedMode(
					"accounts/fireworks/models/glm-5p3/serverlessModes/priority",
					{ input: 1.75, output: 5.5, cached: 0.325 },
					{ serviceTier: "priority" },
				),
				pricedMode(
					"accounts/fireworks/models/glm-5p3/serverlessModes/fast",
					{ input: 2.1, output: 6.6, cached: 0.39 },
					{ usageIdentifier: "accounts/fireworks/routers/glm-5p3-fast" },
				),
			],
		},
	],
}

type RouteMap = Record<string, () => Response>

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

/**
 * Route fetch calls by URL prefix (longest prefix wins, since the accounts URL is a
 * prefix of the serverlessModels URL); unmatched URLs return 404.
 */
const mockFetchRoutes = (routes: RouteMap) =>
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = String(input)
		const match = Object.keys(routes)
			.filter((prefix) => url.startsWith(prefix))
			.sort((a, b) => b.length - a.length)[0]
		return match ? routes[match]() : new Response("not found", { status: 404, statusText: "Not Found" })
	})

const defaultRoutes = (models: unknown[] = [glmModel]): RouteMap => ({
	[FIREWORKS_MODELS_URL]: () => json({ data: models }),
	[FIREWORKS_ACCOUNTS_URL]: () => json({ accounts: [{ name: ACCOUNT }] }),
	[SERVERLESS_URL_PREFIX]: () => json(serverlessModelsBody),
})

describe("parseFireworksServerlessPricing", () => {
	it("maps default and fast modes (via usageIdentifier) and skips the priority tier", () => {
		const pricing = parseFireworksServerlessPricing(serverlessModelsBody)

		expect(pricing.get("accounts/fireworks/models/glm-5p3")).toEqual({
			inputPrice: 1.4,
			outputPrice: 4.4,
			cacheReadsPrice: 0.26,
		})
		expect(pricing.get("accounts/fireworks/routers/glm-5p3-fast")).toEqual({
			inputPrice: 2.1,
			outputPrice: 6.6,
			cacheReadsPrice: 0.39,
		})
		expect(pricing.size).toBe(2)
	})

	it("drops pricing when only one token direction is priced", () => {
		// A missing output rate would otherwise be read as $0 by calculateApiCostInternal
		// and silently under-report the request cost.
		const pricing = parseFireworksServerlessPricing({
			models: [
				{
					name: "accounts/fireworks/models/input-only",
					serverlessModes: [
						{
							name: "accounts/fireworks/models/input-only/serverlessModes/default",
							skuInfos: [sku("LLM input tokens (uncached)", 1)],
						},
					],
				},
				{
					name: "accounts/fireworks/models/output-only",
					serverlessModes: [
						{
							name: "accounts/fireworks/models/output-only/serverlessModes/default",
							skuInfos: [sku("LLM output tokens", 2)],
						},
					],
				},
			],
		})

		expect(pricing.size).toBe(0)
	})

	it("ignores unknown SKUs, non-USD amounts, non per-1M units and malformed entries", () => {
		const pricing = parseFireworksServerlessPricing({
			models: [
				{
					name: "accounts/fireworks/models/embed",
					serverlessModes: [
						{
							name: "accounts/fireworks/models/embed/serverlessModes/default",
							skuInfos: [sku("Embedding input tokens", 0.1)],
						},
					],
				},
				{
					name: "accounts/fireworks/models/eur",
					serverlessModes: [
						{
							name: "accounts/fireworks/models/eur/serverlessModes/default",
							skuInfos: [
								{
									sku: "LLM output tokens",
									amount: { currencyCode: "EUR", units: "1" },
									unit: "1M tokens",
								},
								{ sku: "LLM input tokens (uncached)", amount: usd(1), unit: "1K tokens" },
							],
						},
					],
				},
				null,
				{ name: 123 },
				{ name: "accounts/fireworks/models/no-modes" },
			],
		})

		expect(pricing.size).toBe(0)
	})

	it("returns an empty map for unexpected payloads", () => {
		expect(parseFireworksServerlessPricing(undefined).size).toBe(0)
		expect(parseFireworksServerlessPricing({ models: "nope" }).size).toBe(0)
	})
})

describe("getFireworksModels", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("builds model info from the models endpoint and attaches serverlessModels pricing", async () => {
		const fetchSpy = mockFetchRoutes(defaultRoutes())

		const models = await getFireworksModels("fw-key")

		expect(models["accounts/fireworks/models/glm-5p3"]).toEqual({
			// Fireworks reports no separate output ceiling, so the 20% output convention is
			// used instead of a flat 16,384 cap.
			maxTokens: 209_716,
			contextWindow: 1_048_576,
			supportsImages: false,
			supportsPromptCache: true,
			supportsMaxTokens: true,
			inputPrice: 1.4,
			outputPrice: 4.4,
			cacheReadsPrice: 0.26,
		})

		const urls = fetchSpy.mock.calls.map(([input]) => String(input))
		expect(urls).toContain(FIREWORKS_MODELS_URL)
		expect(urls).toContain(FIREWORKS_ACCOUNTS_URL)
		expect(urls).toContain(`${SERVERLESS_URL_PREFIX}?pageSize=200`)
		for (const [, init] of fetchSpy.mock.calls) {
			expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer fw-key")
		}
	})

	it("prices router ids through the fast mode usageIdentifier", async () => {
		mockFetchRoutes(
			defaultRoutes([
				glmModel,
				{ ...glmModel, id: "accounts/fireworks/routers/glm-5p3-fast", supports_image_input: true },
			]),
		)

		const models = await getFireworksModels("fw-key")

		expect(models["accounts/fireworks/routers/glm-5p3-fast"]).toMatchObject({
			supportsImages: true,
			inputPrice: 2.1,
			outputPrice: 6.6,
			cacheReadsPrice: 0.39,
		})
	})

	it("keeps models without a price and leaves their cost unknown", async () => {
		mockFetchRoutes(
			defaultRoutes([{ id: "accounts/fireworks/models/inkling", supports_chat: true, context_length: 8192 }]),
		)

		const models = await getFireworksModels("fw-key")

		expect(models["accounts/fireworks/models/inkling"]).toEqual({
			maxTokens: 8192,
			contextWindow: 8192,
			supportsImages: false,
			supportsPromptCache: false,
			supportsMaxTokens: true,
		})
	})

	it("uses a fallback context window when context_length is missing", async () => {
		mockFetchRoutes(defaultRoutes([{ id: "accounts/fireworks/models/no-ctx", supports_chat: true }]))

		const models = await getFireworksModels("fw-key")

		expect(models["accounts/fireworks/models/no-ctx"]).toMatchObject({
			contextWindow: 128_000,
			maxTokens: 25_600,
		})
	})

	it("keeps the historical output budget as a floor below the 20% clamp", async () => {
		mockFetchRoutes(
			defaultRoutes([{ id: "accounts/fireworks/models/mid", supports_chat: true, context_length: 40_960 }]),
		)

		const models = await getFireworksModels("fw-key")

		// 20% of 40,960 is 8,192, below the previous 16,384 allowance, so the floor wins.
		expect(models["accounts/fireworks/models/mid"].maxTokens).toBe(16_384)
	})

	it("caps the output budget at the context window", async () => {
		mockFetchRoutes(
			defaultRoutes([{ id: "accounts/fireworks/models/tiny", supports_chat: true, context_length: 8192 }]),
		)

		const models = await getFireworksModels("fw-key")

		expect(models["accounts/fireworks/models/tiny"].maxTokens).toBe(8192)
	})

	it("warns when the pricing page cap truncates the catalog", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const alwaysMore = () => json({ ...serverlessModelsBody, nextPageToken: "more" })
		mockFetchRoutes({ ...defaultRoutes(), [SERVERLESS_URL_PREFIX]: alwaysMore })

		const models = await getFireworksModels("fw-key")

		// The catalog still loads; only the pricing lookup is bounded.
		expect(models["accounts/fireworks/models/glm-5p3"].inputPrice).toBe(1.4)
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Pricing pagination truncated"))
	})

	it("follows serverlessModels pagination", async () => {
		const fetchSpy = mockFetchRoutes({
			...defaultRoutes([glmModel, { id: "accounts/fireworks/models/kimi-k3", supports_chat: true }]),
			[`${SERVERLESS_URL_PREFIX}?pageSize=200&pageToken=p2`]: () =>
				json({
					models: [
						{
							name: "accounts/fireworks/models/kimi-k3",
							serverlessModes: [
								pricedMode("accounts/fireworks/models/kimi-k3/serverlessModes/default", {
									input: 1,
									output: 5,
								}),
							],
						},
					],
				}),
			[SERVERLESS_URL_PREFIX]: () => json({ ...serverlessModelsBody, nextPageToken: "p2" }),
		})

		const models = await getFireworksModels("fw-key")

		expect(models["accounts/fireworks/models/glm-5p3"].inputPrice).toBe(1.4)
		expect(models["accounts/fireworks/models/kimi-k3"]).toMatchObject({
			inputPrice: 1,
			outputPrice: 5,
			supportsPromptCache: false,
		})
		expect(fetchSpy.mock.calls.filter(([input]) => String(input).startsWith(SERVERLESS_URL_PREFIX))).toHaveLength(2)
	})

	it.each([
		["accounts lookup fails", { [FIREWORKS_ACCOUNTS_URL]: () => json({}, 500) }],
		["accounts payload has no account", { [FIREWORKS_ACCOUNTS_URL]: () => json({ accounts: [] }) }],
		["serverlessModels is forbidden", { [SERVERLESS_URL_PREFIX]: () => json({ code: 7 }, 403) }],
		[
			"serverlessModels throws",
			{
				[SERVERLESS_URL_PREFIX]: () => {
					throw new Error("network down")
				},
			},
		],
	])("still returns the model list without prices when %s", async (_label, overrides) => {
		vi.spyOn(console, "warn").mockImplementation(() => {})
		mockFetchRoutes({ ...defaultRoutes(), ...overrides })

		const models = await getFireworksModels("fw-key")

		expect(models["accounts/fireworks/models/glm-5p3"]).toBeDefined()
		expect(models["accounts/fireworks/models/glm-5p3"].inputPrice).toBeUndefined()
	})

	it("skips the pricing lookup and Authorization header when no API key is provided", async () => {
		const fetchSpy = mockFetchRoutes(defaultRoutes())

		await getFireworksModels(undefined)

		expect(fetchSpy).toHaveBeenCalledTimes(1)
		const init = fetchSpy.mock.calls[0][1] as RequestInit
		expect((init.headers as Record<string, string>)["Authorization"]).toBeUndefined()
	})

	it("skips non-chat and embedding models and entries without a valid id", async () => {
		mockFetchRoutes(
			defaultRoutes([
				{ id: "accounts/fireworks/models/no-chat", supports_chat: false },
				// Embedding/reranker models report supports_chat: true but kind EMBEDDING_MODEL.
				{ id: "accounts/fireworks/models/qwen3-embedding-8b", kind: "EMBEDDING_MODEL", supports_chat: true },
				{ id: "accounts/fireworks/models/qwen3-reranker-8b", kind: "EMBEDDING_MODEL", supports_chat: true },
				{ id: "" },
				{ id: 123 },
				null,
				glmModel,
			]),
		)

		const models = await getFireworksModels("fw-key")

		expect(Object.keys(models)).toEqual(["accounts/fireworks/models/glm-5p3"])
	})

	it("throws for HTTP errors from the models endpoint", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		mockFetchRoutes({
			...defaultRoutes(),
			[FIREWORKS_MODELS_URL]: () =>
				new Response('{"error":"bad key"}', { status: 401, statusText: "Unauthorized" }),
		})

		await expect(getFireworksModels("bad")).rejects.toThrow("HTTP 401: Unauthorized")
	})

	it("throws on unexpected models response format", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		mockFetchRoutes({ ...defaultRoutes(), [FIREWORKS_MODELS_URL]: () => json({ data: "nope" }) })

		await expect(getFireworksModels("fw-key")).rejects.toThrow("Unexpected response format")
	})

	it("passes the caller's abort signal to every request", async () => {
		const fetchSpy = mockFetchRoutes(defaultRoutes())
		const controller = new AbortController()

		await getFireworksModels("fw-key", { signal: controller.signal })

		expect(fetchSpy).toHaveBeenCalledTimes(3)
		for (const [, init] of fetchSpy.mock.calls) {
			expect(init?.signal).toBe(controller.signal)
		}
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
