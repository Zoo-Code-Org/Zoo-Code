import axios, { AxiosError, type GenericAbortSignal } from "axios"

import { lMStudioDefaultModelInfo, providerIdentifiers } from "@roo-code/types"

import {
	forceFullModelDetailsLoad,
	getLMStudioModels,
	getLMStudioModelAlias,
	hasLoadedFullDetails,
	LM_STUDIO_MODEL_LOAD_TIMEOUT_MS,
} from "../lmstudio"
import { MODEL_CATALOG_FETCH_TIMEOUT_MS } from "../modelCache"
import type { ApiHandler } from "../../../index"

import nativeFixture from "./fixtures/lmstudio-model-details.json"

const mockFlushModels = vi.hoisted(() => vi.fn())
vi.mock("../modelCache", async (importOriginal) => ({
	...(await importOriginal<typeof import("../modelCache")>()),
	flushModels: mockFlushModels,
}))

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
	it.each(["Unexpected endpoint or method", "Endpoint not found", "Unrecognized request", ""])(
		"falls back for an explicit unsupported-route body: %s",
		async (error) => {
			get.mockResolvedValueOnce({ data: { error } })
				.mockResolvedValueOnce({ data: { error } })
				.mockResolvedValueOnce({ data: { data: [{ id: "legacy" }] } })
			expect((await getLMStudioModels(baseUrl)).legacy.supportsImages).toBe(false)
			expect(get).toHaveBeenCalledTimes(3)
		},
	)

	it.each([undefined, 42, { message: "unsupported" }])(
		"does not fall back for a malformed non-string error: %s",
		async (error) => {
			get.mockResolvedValueOnce({ data: { error } })
			expect(await getLMStudioModels(baseUrl)).toEqual({})
			expect(get).toHaveBeenCalledOnce()
		},
	)

	it.each([{ error: 42 }, { unexpected: true }])("rejects an invalid v0 body %j", async (data) => {
		get.mockRejectedValueOnce(httpError(404)).mockResolvedValueOnce({ data })
		expect(await getLMStudioModels(baseUrl)).toEqual({})
		expect(get).toHaveBeenCalledTimes(2)
	})

	it("reports an OpenAI error body after HTTP fallback failures", async () => {
		get.mockRejectedValueOnce(httpError(404))
			.mockRejectedValueOnce(httpError(405))
			.mockResolvedValueOnce({ data: { error: "OpenAI endpoint unavailable" } })
		expect(await getLMStudioModels(baseUrl)).toEqual({})
		expect(console.error).toHaveBeenCalledWith(expect.any(String), "OpenAI endpoint unavailable")
	})

	it("reports discovery deadline expiration as a timeout", async () => {
		const deadline = new AbortController()
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal)
		try {
			get.mockImplementationOnce(async () => {
				deadline.abort(new DOMException("deadline", "TimeoutError"))
				throw new AxiosError("cancelled", "ERR_CANCELED")
			})
			expect(await getLMStudioModels(baseUrl)).toEqual({})
			expect(console.error).toHaveBeenCalledWith(expect.any(String), "LM Studio model discovery timed out")
		} finally {
			timeout.mockRestore()
		}
	})

	it("retains the first server error when every endpoint fails", async () => {
		get.mockResolvedValueOnce({ data: { error: "Invalid API key" } })
			.mockResolvedValueOnce({ data: { error: "second error" } })
			.mockResolvedValueOnce({ data: { error: "last error" } })
		expect(await getLMStudioModels(baseUrl)).toEqual({})
		expect(get).toHaveBeenCalledTimes(3)
		expect(console.error).toHaveBeenCalledWith(expect.any(String), "Invalid API key")
	})

	it("preserves a healthy refresh when an older flight is cancelled", async () => {
		const controller = new AbortController()
		let rejectFlight: (error: Error) => void = () => {
			throw new Error("flight not started")
		}
		get.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					rejectFlight = reject
				}),
		)
		const cancelled = getLMStudioModels(baseUrl, { signal: controller.signal })
		const assertion = expect(cancelled).rejects.toMatchObject({ name: "AbortError" })
		get.mockResolvedValueOnce(nativeResponse())
		await getLMStudioModels(baseUrl)
		controller.abort()
		rejectFlight(new Error("cancelled"))
		await assertion
		expect(hasLoadedFullDetails(modelKey, baseUrl)).toBe(true)
		expect(getLMStudioModelAlias("smollm2-135m-instruct", baseUrl)).toBeDefined()
	})

	it("prefers a valid native catalog over an accompanying error string", async () => {
		get.mockResolvedValueOnce({ data: { ...nativeResponse().data, error: "ignored" } })
		expect(Object.keys(await getLMStudioModels(baseUrl))).toEqual([modelKey])
		expect(get).toHaveBeenCalledOnce()
	})

	it("expires loaded details and aliases after a failed refresh", async () => {
		get.mockResolvedValueOnce(nativeResponse()).mockRejectedValueOnce(new Error("server offline"))
		await getLMStudioModels(baseUrl)
		expect(hasLoadedFullDetails(modelKey, baseUrl)).toBe(true)
		expect(getLMStudioModelAlias("smollm2-135m-instruct", baseUrl)).toBeDefined()
		await getLMStudioModels(baseUrl)
		expect(hasLoadedFullDetails(modelKey, baseUrl)).toBe(false)
		expect(getLMStudioModelAlias("smollm2-135m-instruct", baseUrl)).toBeUndefined()
	})

	it.each(["__proto__", "constructor"])("preserves catalog keys and aliases named %s", async (id) => {
		get.mockResolvedValueOnce(nativeResponse([{ id, config: { context_length: 2048 } }]))
		await getLMStudioModels(baseUrl)
		expect(getLMStudioModelAlias(id, baseUrl)?.contextWindow).toBe(2048)
		get.mockResolvedValueOnce({ data: { models: [{ ...nativeModel([]), key: id }] } })
		const models = await getLMStudioModels(baseUrl)
		expect(Object.keys(models)).toEqual([id])
		expect(models[id].supportsImages).toBe(false)
	})

	it("returns only catalog keys while retaining saved instance aliases separately", async () => {
		get.mockResolvedValueOnce({ data: nativeFixture })
		const models = await getLMStudioModels(baseUrl)
		expect(get).toHaveBeenCalledExactlyOnceWith(`${baseUrl}/api/v1/models`, { signal: expect.any(AbortSignal) })
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
		vi.mocked(console.warn).mockClear()
		get.mockResolvedValueOnce({
			data: { models: [{ type: "llm", key: "broken", loaded_instances: "oops" }, ...nativeFixture.models] },
		})
		const models = await getLMStudioModels(baseUrl)
		expect(Object.keys(models)).toEqual([modelKey])
		expect(get).toHaveBeenCalledOnce()
		expect(console.warn).toHaveBeenCalledExactlyOnceWith(
			`LM Studio at ${baseUrl} dropped 1 invalid catalog entries`,
		)
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
			legacy: { ...lMStudioDefaultModelInfo, description: "legacy", supportsImages: false },
		})
		expect(get.mock.calls.map(([url]) => url)).toEqual([
			`${baseUrl}/api/v1/models`,
			`${baseUrl}/api/v0/models`,
			`${baseUrl}/v1/models`,
		])
	})

	it.each([401, 403, 429, 500, "timeout", "malformed"])("does not fall back for %s", async (failure) => {
		if (failure === "malformed") get.mockResolvedValueOnce({ data: { models: "invalid" } })
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
		expect(get).toHaveBeenCalledWith(`${baseUrl}/api/v1/models`, { signal: expect.any(AbortSignal) })
	})

	it("does not request an invalid URL", async () => {
		expect(await getLMStudioModels("not a URL")).toEqual({})
		expect(get).not.toHaveBeenCalled()
	})

	it("passes the signal through every fallback request", async () => {
		const controller = new AbortController()
		const { signal } = controller
		get.mockRejectedValueOnce(httpError(404))
			.mockRejectedValueOnce(httpError(405))
			.mockResolvedValueOnce({ data: { data: [] } })
		await getLMStudioModels(baseUrl, { signal })
		const mergedSignal = get.mock.calls[0][1]?.signal
		expect(mergedSignal).toBeInstanceOf(AbortSignal)
		for (const [, config] of get.mock.calls) expect(config?.signal).toBe(mergedSignal)
		controller.abort()
		expect(mergedSignal?.aborted).toBe(true)
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
	it("allows a successful model load to run beyond the catalog deadline", async () => {
		vi.useFakeTimers()
		const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
			const controller = new AbortController()
			setTimeout(() => controller.abort(), ms)
			return controller.signal
		})
		try {
			get.mockResolvedValueOnce(nativeResponse([]))
			let finishLoad: () => void = () => {
				throw new Error("load not started")
			}
			let loadSignal: GenericAbortSignal | undefined
			post.mockImplementationOnce(
				(_url, _body, config) =>
					new Promise((resolve, reject) => {
						loadSignal = config?.signal
						loadSignal?.addEventListener?.("abort", () => reject(new Error("load timed out")))
						finishLoad = () => resolve({ data: {} })
					}),
			)
			const pending = forceFullModelDetailsLoad(baseUrl, modelKey, handler)
			await vi.advanceTimersByTimeAsync(30_000)
			expect(post).toHaveBeenCalledOnce()
			expect(loadSignal?.aborted).toBe(false)
			expect(mockFlushModels).not.toHaveBeenCalled()
			finishLoad()
			await pending
			expect(mockFlushModels).toHaveBeenCalledOnce()
		} finally {
			timeout.mockRestore()
			vi.useRealTimers()
		}
	})

	it.each(["discovery", "load"])(
		"bounds a hung %s request and releases the pending slot for retry",
		async (phase) => {
			const deadline = new AbortController()
			const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal)
			try {
				get.mockResolvedValue(nativeResponse([]))
				post.mockResolvedValue({ data: {} })
				let requestSignal: AbortSignal | undefined
				const hang = (_url: string, config?: { signal?: GenericAbortSignal }) =>
					new Promise<never>((_resolve, reject) => {
						requestSignal = config?.signal instanceof AbortSignal ? config.signal : undefined
						requestSignal?.addEventListener(
							"abort",
							() => reject(new AxiosError("timeout", "ERR_CANCELED")),
							{ once: true },
						)
					})
				if (phase === "discovery") get.mockImplementationOnce(hang)
				else post.mockImplementationOnce((url, _body, config) => hang(url, config))
				const pending = forceFullModelDetailsLoad(baseUrl, modelKey, handler)
				await vi.waitFor(() => expect(requestSignal).toBeInstanceOf(AbortSignal))
				expect(timeout).toHaveBeenLastCalledWith(
					phase === "discovery" ? MODEL_CATALOG_FETCH_TIMEOUT_MS : LM_STUDIO_MODEL_LOAD_TIMEOUT_MS,
				)
				deadline.abort()
				expect(requestSignal?.aborted).toBe(true)
				await pending
				expect(mockFlushModels).not.toHaveBeenCalled()
				timeout.mockRestore()
				await forceFullModelDetailsLoad(baseUrl, modelKey, handler)
				expect(mockFlushModels).toHaveBeenCalledOnce()
			} finally {
				timeout.mockRestore()
			}
		},
	)

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
		let finishLoad: () => void = () => {
			throw new Error("load not started")
		}
		post.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishLoad = () => resolve({ data: { instance_id: modelKey } })
				}),
		)
		const pending = forceFullModelDetailsLoad(baseUrl, modelKey, handler)
		await vi.waitFor(() => expect(post).toHaveBeenCalledOnce())
		expect(mockFlushModels).not.toHaveBeenCalled()
		finishLoad()
		await pending
		expect(mockFlushModels).toHaveBeenCalledTimes(1)
		expect(post).toHaveBeenCalledExactlyOnceWith(
			`${baseUrl}/api/v1/models/load`,
			{ model: modelKey },
			{ signal: expect.any(AbortSignal) },
		)
		expect(post.mock.invocationCallOrder[0]).toBeLessThan(mockFlushModels.mock.invocationCallOrder[0])
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
		expect(post).toHaveBeenCalledWith(
			`${baseUrl}/api/v1/models/load`,
			{ model: "another-model" },
			{ signal: expect.any(AbortSignal) },
		)
	})

	it("records loaded details from the refreshed catalog rather than an optimistic load flag", async () => {
		get.mockResolvedValueOnce(nativeResponse([])).mockResolvedValueOnce(nativeResponse())
		post.mockResolvedValue({ data: {} })
		let loadedBeforeRefresh: boolean | undefined
		mockFlushModels.mockImplementationOnce(async () => {
			loadedBeforeRefresh = hasLoadedFullDetails(modelKey, baseUrl)
			await getLMStudioModels(baseUrl)
		})
		await forceFullModelDetailsLoad(baseUrl, modelKey, handler)
		expect(loadedBeforeRefresh).toBe(false)
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

describe("LM Studio review regressions", () => {
	it("keeps preview metadata out of runtime state", async () => {
		get.mockResolvedValueOnce(nativeResponse()).mockResolvedValueOnce(nativeResponse([]))
		await getLMStudioModels(baseUrl)
		const alias = getLMStudioModelAlias("smollm2-135m-instruct", baseUrl)
		await getLMStudioModels(baseUrl, { commit: false })
		expect(hasLoadedFullDetails(modelKey, baseUrl)).toBe(true)
		expect(getLMStudioModelAlias("smollm2-135m-instruct", baseUrl)).toEqual(alias)
	})

	it("does not commit a successful response that arrives after cancellation", async () => {
		get.mockResolvedValueOnce(nativeResponse())
		await getLMStudioModels(baseUrl)
		const alias = getLMStudioModelAlias("smollm2-135m-instruct", baseUrl)
		const controller = new AbortController()
		get.mockImplementationOnce(async () => {
			controller.abort()
			return nativeResponse([])
		})
		await expect(getLMStudioModels(baseUrl, { signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		})
		expect(hasLoadedFullDetails(modelKey, baseUrl)).toBe(true)
		expect(getLMStudioModelAlias("smollm2-135m-instruct", baseUrl)).toEqual(alias)
	})

	it.each(["v0", "openai"])("skips native loading after detecting %s", async (version) => {
		get.mockRejectedValueOnce(httpError(404))
		if (version === "openai") get.mockRejectedValueOnce(httpError(404))
		get.mockResolvedValueOnce({ data: { data: [{ id: modelKey, type: "llm" }] } })
		await getLMStudioModels(baseUrl)
		get.mockClear()
		await forceFullModelDetailsLoad(baseUrl, modelKey, handler)
		expect(get).not.toHaveBeenCalled()
		expect(post).not.toHaveBeenCalled()
	})

	it("retains the first server error when subsequent routes return 404", async () => {
		get.mockResolvedValueOnce({ data: { error: "first server error" } })
			.mockRejectedValueOnce(httpError(404))
			.mockRejectedValueOnce(httpError(404))
		await getLMStudioModels(baseUrl)
		expect(console.error).toHaveBeenCalledWith(expect.any(String), "first server error")
	})

	it.each([1, 2])("reports a timeout at fallback endpoint %s and clears stale metadata", async (endpoint) => {
		get.mockResolvedValueOnce(nativeResponse())
		await getLMStudioModels(baseUrl)
		const deadline = new AbortController()
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal)
		try {
			for (let index = 0; index < endpoint; index++) get.mockRejectedValueOnce(httpError(404))
			get.mockImplementationOnce(async () => {
				deadline.abort(new DOMException("deadline", "TimeoutError"))
				throw new AxiosError("cancelled", "ERR_CANCELED")
			})
			await getLMStudioModels(baseUrl, { signal: deadline.signal })
			expect(hasLoadedFullDetails(modelKey, baseUrl)).toBe(false)
			expect(getLMStudioModelAlias("smollm2-135m-instruct", baseUrl)).toBeUndefined()
			expect(console.error).toHaveBeenCalledWith(expect.any(String), "LM Studio model discovery timed out")
		} finally {
			timeout.mockRestore()
		}
	})

	it("keeps catalog keys out of the alias map", async () => {
		get.mockResolvedValueOnce({
			data: {
				models: [
					{ ...nativeModel([{ id: "other-key", config: { context_length: 2048 } }]) },
					{ ...nativeModel([]), key: "other-key", max_context_length: 8192 },
				],
			},
		})
		const models = await getLMStudioModels(baseUrl)
		expect(models["other-key"].contextWindow).toBe(8192)
		expect(getLMStudioModelAlias("other-key", baseUrl)).toBeUndefined()
	})

	it("forwards cancellation to explicit loading", async () => {
		const controller = new AbortController()
		get.mockResolvedValueOnce(nativeResponse([]))
		let loadSignal: GenericAbortSignal | undefined
		post.mockImplementationOnce(
			(_url, _body, config) =>
				new Promise((_resolve, reject) => {
					loadSignal = config?.signal
					loadSignal?.addEventListener?.("abort", () => reject(new AxiosError("cancelled", "ERR_CANCELED")))
				}),
		)
		const pending = forceFullModelDetailsLoad(baseUrl, modelKey, handler, controller.signal)
		await vi.waitFor(() => expect(post).toHaveBeenCalledOnce())
		controller.abort()
		await pending
		expect(loadSignal?.aborted).toBe(true)
		expect(mockFlushModels).not.toHaveBeenCalled()
	})
})

it("detaches one cancelled load caller without cancelling another", async () => {
	get.mockResolvedValueOnce(nativeResponse([]))
	let finishLoad: () => void = () => {
		throw new Error("load not started")
	}
	let loadSignal: GenericAbortSignal | undefined
	post.mockImplementationOnce(
		(_url, _body, config) =>
			new Promise((resolve) => {
				loadSignal = config?.signal
				finishLoad = () => resolve({ data: {} })
			}),
	)
	const controller = new AbortController()
	const first = forceFullModelDetailsLoad(baseUrl, modelKey, handler, controller.signal)
	await vi.waitFor(() => expect(post).toHaveBeenCalledOnce())
	const second = forceFullModelDetailsLoad(baseUrl, modelKey, handler)
	controller.abort()
	await first
	expect(loadSignal?.aborted).toBe(false)
	finishLoad()
	await second
	expect(post).toHaveBeenCalledOnce()
	expect(mockFlushModels).toHaveBeenCalledOnce()
})
