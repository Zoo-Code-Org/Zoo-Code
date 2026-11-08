import axios, { AxiosError } from "axios"

import { lMStudioDefaultModelInfo, providerIdentifiers } from "@roo-code/types"

import { forceFullModelDetailsLoad, getLMStudioModels, getLMStudioModelAlias, hasLoadedFullDetails } from "../lmstudio"
import type { ApiHandler } from "../../../index"

import nativeFixture from "./fixtures/lmstudio-model-details.json"

const mockFlushModels = vi.hoisted(() => vi.fn())
vi.mock("../modelCache", () => ({ flushModels: mockFlushModels }))

const get = vi.spyOn(axios, "get")
const post = vi.spyOn(axios, "post")

// Only fetchModels and cache scope are used by the refresh double in these tests.
const handler = {
	fetchModels: vi.fn(),
	getModelCacheScope: () => ({ urlScoped: true, keyScoped: false, authScoped: false }),
} as unknown as ApiHandler

const baseUrl = "http://localhost:1234"
const modelKey = "smollm2-135m-instruct@q8_0"
const nativeModel = (instances = [{ id: "smollm2-135m-instruct", config: { context_length: 1024 } }]) => ({
	...nativeFixture.models[0],
	loaded_instances: instances,
})
const nativeResponse = (instances?: ReturnType<typeof nativeModel>["loaded_instances"]) => ({
	data: { models: [nativeModel(instances)] },
})
const httpError = (status: number) =>
	new AxiosError("HTTP error", undefined, undefined, undefined, {
		status,
		statusText: "Error",
		data: {},
		headers: {},
		config: { headers: new axios.AxiosHeaders() },
	})

beforeEach(async () => {
	get.mockReset()
	post.mockReset()
	mockFlushModels.mockReset()
	get.mockResolvedValue({ data: { models: [] } })
	await getLMStudioModels(baseUrl)
	get.mockReset()
	vi.spyOn(console, "error").mockImplementation(() => {})
	vi.spyOn(console, "warn").mockImplementation(() => {})
})

describe("LM Studio HTTP discovery", () => {
	it("returns only catalog keys while retaining saved instance aliases separately", async () => {
		get.mockResolvedValueOnce({ data: nativeFixture })
		const models = await getLMStudioModels(baseUrl)
		expect(get).toHaveBeenCalledExactlyOnceWith(`${baseUrl}/api/v1/models`, { signal: undefined })
		expect(models[modelKey]).toMatchObject({ contextWindow: 1024, maxTokens: 1024, supportsImages: false })
		expect(Object.keys(models)).toEqual([modelKey])
		expect(getLMStudioModelAlias("smollm2-135m-instruct", baseUrl)).toEqual(models[modelKey])
		expect(models["text-embedding-nomic-embed-text-v1.5"]).toBeUndefined()
		expect(hasLoadedFullDetails(modelKey, baseUrl)).toBe(true)
	})

	it("prefers an instance matching the catalog key, otherwise server order, and gives aliases their own context", async () => {
		get.mockResolvedValueOnce(
			nativeResponse([
				{ id: "custom", config: { context_length: 2048 } },
				{ id: modelKey, config: { context_length: 4096 } },
			]),
		)
		const models = await getLMStudioModels(baseUrl)
		expect(models[modelKey].contextWindow).toBe(4096)
		expect(models.custom).toBeUndefined()
		expect(getLMStudioModelAlias("custom", baseUrl)?.contextWindow).toBe(2048)
	})

	it.each([8192, null])("uses maximum/default context %s for an unloaded model", async (maxContext) => {
		get.mockResolvedValueOnce({
			data: { models: [{ ...nativeModel([]), max_context_length: maxContext, capabilities: { vision: true } }] },
		})
		const models = await getLMStudioModels(baseUrl)
		expect(models[modelKey].contextWindow).toBe(maxContext ?? lMStudioDefaultModelInfo.contextWindow)
		expect(models[modelKey].supportsImages).toBe(true)
		expect(hasLoadedFullDetails(modelKey, baseUrl)).toBe(false)
	})

	it.each([404, 405])("falls back to v0 only on unsupported native endpoint %s", async (status) => {
		get.mockRejectedValueOnce(httpError(status)).mockResolvedValueOnce({
			data: {
				data: [
					{ id: "vision", type: "vlm", max_context_length: 8192, state: "loaded" },
					{ id: "text", type: "llm", max_context_length: 4096 },
					{ id: "embedding", type: "embeddings", max_context_length: 2048 },
				],
			},
		})
		const models = await getLMStudioModels(baseUrl)
		expect(Object.keys(models)).toEqual(["vision", "text"])
		expect(models.vision).toMatchObject({ supportsImages: true, contextWindow: 8192 })
		expect(models.text).toMatchObject({ supportsImages: false, contextWindow: 4096 })
		expect(hasLoadedFullDetails("vision", baseUrl)).toBe(false)
		expect(get.mock.calls.map(([url]) => url)).toEqual([`${baseUrl}/api/v1/models`, `${baseUrl}/api/v0/models`])
	})

	it("skips a malformed native entry and keeps the valid models", async () => {
		get.mockResolvedValueOnce({
			data: { models: [{ type: "llm", key: "broken", loaded_instances: "oops" }, ...nativeFixture.models] },
		})
		const models = await getLMStudioModels(baseUrl)
		expect(Object.keys(models)).toEqual([modelKey])
		expect(get).toHaveBeenCalledOnce()
	})

	it("returns no models without falling back when the native body has no model list", async () => {
		get.mockResolvedValueOnce({ data: { unexpected: true } })
		expect(await getLMStudioModels(baseUrl)).toEqual({})
		expect(get).toHaveBeenCalledOnce()
	})

	it("falls back to OpenAI IDs when both native APIs are unsupported", async () => {
		get.mockRejectedValueOnce(httpError(404))
			.mockRejectedValueOnce(httpError(405))
			.mockResolvedValueOnce({ data: { data: [{ id: "legacy" }] } })
		expect(await getLMStudioModels(baseUrl)).toEqual({
			legacy: { ...lMStudioDefaultModelInfo, description: "legacy" },
		})
		expect(get.mock.calls.map(([url]) => url)).toEqual([
			`${baseUrl}/api/v1/models`,
			`${baseUrl}/api/v0/models`,
			`${baseUrl}/v1/models`,
		])
	})

	it.each([401, 403, 429, 500, "timeout", "malformed"])("does not fall back for %s", async (failure) => {
		if (failure === "malformed") get.mockResolvedValueOnce({ data: { models: [{}] } })
		else
			get.mockRejectedValueOnce(
				typeof failure === "number" ? httpError(failure) : new AxiosError("timeout", "ECONNABORTED"),
			)
		expect(await getLMStudioModels(baseUrl)).toEqual({})
		expect(get).toHaveBeenCalledTimes(1)
	})

	it.each([401, 403, 500])("does not fall through a v0 failure %s", async (status) => {
		get.mockRejectedValueOnce(httpError(404)).mockRejectedValueOnce(httpError(status))
		expect(await getLMStudioModels(baseUrl)).toEqual({})
		expect(get).toHaveBeenCalledTimes(2)
	})

	it("keeps loaded detail flags scoped to the server and clears them after unloading", async () => {
		get.mockResolvedValueOnce(nativeResponse())
			.mockResolvedValueOnce(nativeResponse([]))
			.mockResolvedValueOnce(nativeResponse([]))
		await getLMStudioModels(baseUrl)
		await getLMStudioModels("http://other:1234")
		expect(hasLoadedFullDetails(modelKey, baseUrl)).toBe(true)
		expect(hasLoadedFullDetails(modelKey, "http://other:1234")).toBe(false)
		await getLMStudioModels(baseUrl)
		expect(hasLoadedFullDetails(modelKey, baseUrl)).toBe(false)
	})

	it("keeps duplicate and custom aliases out of the dropdown and expires them on refresh", async () => {
		const instances = [
			{ id: "old-unsuffixed-id", config: { context_length: 1024 } },
			{ id: "old-unsuffixed-id:2", config: { context_length: 2048 } },
			{ id: "custom", config: { context_length: 4096 } },
		]
		get.mockResolvedValueOnce(nativeResponse(instances))
			.mockResolvedValueOnce(nativeResponse([]))
			.mockResolvedValueOnce(nativeResponse([]))
		expect(Object.keys(await getLMStudioModels(baseUrl))).toEqual([modelKey])
		for (const instance of instances) {
			expect(getLMStudioModelAlias(instance.id, baseUrl)?.contextWindow).toBe(instance.config.context_length)
			expect(getLMStudioModelAlias(instance.id, "http://other:1234")).toBeUndefined()
		}
		await getLMStudioModels("http://other:1234")
		expect(getLMStudioModelAlias("custom", baseUrl)).toBeDefined()
		await getLMStudioModels(baseUrl)
		expect(getLMStudioModelAlias("custom", baseUrl)).toBeUndefined()
	})

	it.each(["", `${baseUrl}/`])("normalizes the base URL %s", async (url) => {
		get.mockResolvedValueOnce(nativeResponse())
		await getLMStudioModels(url)
		expect(get).toHaveBeenCalledWith(`${baseUrl}/api/v1/models`, { signal: undefined })
	})

	it("does not request an invalid URL", async () => {
		expect(await getLMStudioModels("not a URL")).toEqual({})
		expect(get).not.toHaveBeenCalled()
	})

	it("passes the signal through every fallback request", async () => {
		const { signal } = new AbortController()
		get.mockRejectedValueOnce(httpError(404))
			.mockRejectedValueOnce(httpError(405))
			.mockResolvedValueOnce({ data: { data: [] } })
		await getLMStudioModels(baseUrl, { signal })
		for (const [, config] of get.mock.calls) expect(config?.signal).toBe(signal)
	})

	it("rejects on abort without falling back", async () => {
		const controller = new AbortController()
		get.mockImplementationOnce(async () => {
			controller.abort()
			throw httpError(404)
		})
		await expect(getLMStudioModels(baseUrl, { signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		})
		expect(get).toHaveBeenCalledTimes(1)
	})

	it("logs only the server origin on connection refusal", async () => {
		get.mockRejectedValueOnce(new AxiosError("refused", "ECONNREFUSED"))
		await getLMStudioModels("http://user:pass@localhost:1234/path?token=secret")
		expect(console.warn).toHaveBeenCalledWith("Error connecting to LMStudio at http://localhost:1234")
	})
})

describe("LM Studio explicit loading", () => {
	it.each([modelKey, "custom"])("reuses an existing instance for %s and refreshes metadata", async (savedId) => {
		get.mockResolvedValueOnce(nativeResponse([{ id: "custom", config: { context_length: 2048 } }]))
		await forceFullModelDetailsLoad(baseUrl, savedId, handler)
		expect(post).not.toHaveBeenCalled()
		expect(mockFlushModels).toHaveBeenCalledExactlyOnceWith(
			{ provider: providerIdentifiers.lmstudio, baseUrl },
			handler,
			true,
		)
	})

	it("loads by exact catalog key, then refreshes", async () => {
		get.mockResolvedValueOnce(nativeResponse([]))
		post.mockResolvedValueOnce({ data: { instance_id: modelKey } })
		mockFlushModels.mockImplementationOnce(() => {
			expect(post).toHaveBeenCalledExactlyOnceWith(`${baseUrl}/api/v1/models/load`, { model: modelKey })
		})
		await forceFullModelDetailsLoad(baseUrl, modelKey, handler)
		expect(mockFlushModels).toHaveBeenCalledTimes(1)
	})

	it("shares one load and refresh across concurrent callers, including normalized URLs", async () => {
		get.mockResolvedValue(nativeResponse([]))
		let finishRefresh: (() => void) | undefined
		mockFlushModels.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finishRefresh = resolve
				}),
		)
		post.mockResolvedValue({ data: {} })
		const first = forceFullModelDetailsLoad(baseUrl, modelKey, handler)
		await vi.waitFor(() => expect(mockFlushModels).toHaveBeenCalledTimes(1))
		const second = forceFullModelDetailsLoad(`${baseUrl}/`, modelKey, handler)
		expect(get).toHaveBeenCalledTimes(1)
		expect(post).toHaveBeenCalledTimes(1)
		finishRefresh?.()
		await Promise.all([first, second])
		expect(mockFlushModels).toHaveBeenCalledTimes(1)
	})

	it("prevents late pre-load discovery from creating a duplicate after the first operation finishes", async () => {
		let finishLoad: () => void = () => {
			throw new Error("load not started")
		}
		let finishLateDiscovery: (response: ReturnType<typeof nativeResponse>) => void = () => {
			throw new Error("discovery not set up")
		}
		const lateDiscovery = new Promise<ReturnType<typeof nativeResponse>>((resolve) => {
			finishLateDiscovery = resolve
		})
		get.mockResolvedValueOnce(nativeResponse([])).mockReturnValueOnce(lateDiscovery)
		post.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishLoad = () => resolve({ data: {} })
				}),
		)
		const first = forceFullModelDetailsLoad(baseUrl, modelKey, handler)
		await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1))
		const second = forceFullModelDetailsLoad(baseUrl, modelKey, handler)
		finishLoad()
		await first
		// The old implementation started this second discovery before the first
		// load completed, then acted on its stale response after releasing the slot.
		finishLateDiscovery(nativeResponse([]))
		await second
		expect(get).toHaveBeenCalledTimes(1)
		expect(post).toHaveBeenCalledTimes(1)
		expect(mockFlushModels).toHaveBeenCalledTimes(1)
	})

	it("keeps independent model keys separate on the same server", async () => {
		get.mockResolvedValue({ data: { models: [nativeModel([]), { ...nativeModel([]), key: "another-model" }] } })
		post.mockResolvedValue({ data: {} })
		await Promise.all([
			forceFullModelDetailsLoad(baseUrl, modelKey, handler),
			forceFullModelDetailsLoad(baseUrl, "another-model", handler),
		])
		expect(post).toHaveBeenCalledTimes(2)
		expect(post).toHaveBeenCalledWith(`${baseUrl}/api/v1/models/load`, { model: "another-model" })
	})

	it("records loaded details from the refreshed catalog rather than an optimistic load flag", async () => {
		get.mockResolvedValueOnce(nativeResponse([])).mockResolvedValueOnce(nativeResponse())
		post.mockResolvedValue({ data: {} })
		mockFlushModels.mockImplementationOnce(async () => {
			expect(hasLoadedFullDetails(modelKey, baseUrl)).toBe(false)
			await getLMStudioModels(baseUrl)
		})
		await forceFullModelDetailsLoad(baseUrl, modelKey, handler)
		expect(hasLoadedFullDetails(modelKey, baseUrl)).toBe(true)
	})

	it("does not combine loads for different servers", async () => {
		get.mockResolvedValue(nativeResponse([]))
		post.mockResolvedValue({ data: {} })
		await Promise.all([
			forceFullModelDetailsLoad(baseUrl, modelKey, handler),
			forceFullModelDetailsLoad("http://other:1234", modelKey, handler),
		])
		expect(post).toHaveBeenCalledTimes(2)
		expect(mockFlushModels).toHaveBeenCalledTimes(2)
	})

	it.each(["load", "refresh"])("permits a retry after a failed %s", async (failure) => {
		get.mockResolvedValue(nativeResponse([]))
		post.mockResolvedValue({ data: {} })
		if (failure === "load") post.mockRejectedValueOnce(new Error("load failed"))
		else mockFlushModels.mockRejectedValueOnce(new Error("refresh failed"))
		await forceFullModelDetailsLoad(baseUrl, modelKey, handler)
		await forceFullModelDetailsLoad(baseUrl, modelKey, handler)
		expect(post).toHaveBeenCalledTimes(2)
		expect(mockFlushModels).toHaveBeenCalledTimes(failure === "load" ? 1 : 2)
	})

	it.each(["legacy/path/model.gguf", "unrelated-model"])("does not guess a key for %s", async (savedId) => {
		get.mockResolvedValueOnce(nativeResponse([]))
		await forceFullModelDetailsLoad(baseUrl, savedId, handler)
		expect(post).not.toHaveBeenCalled()
		expect(mockFlushModels).not.toHaveBeenCalled()
	})

	it("does not invent a load endpoint on legacy servers", async () => {
		get.mockRejectedValueOnce(httpError(404)).mockResolvedValueOnce({
			data: { data: [{ id: "legacy", type: "llm" }] },
		})
		await forceFullModelDetailsLoad(baseUrl, "legacy", handler)
		expect(post).not.toHaveBeenCalled()
	})
})
