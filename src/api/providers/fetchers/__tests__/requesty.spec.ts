// npx vitest run api/providers/fetchers/__tests__/requesty.spec.ts

import axios from "axios"

import { getRequestyModels } from "../requesty"

vi.mock("axios")
const mockAxiosGet = vi.mocked(axios.get)

function makeRawModel(overrides: Record<string, unknown>) {
	return {
		id: "some/model",
		max_output_tokens: 8192,
		context_window: 200000,
		supports_caching: false,
		supports_vision: false,
		supports_reasoning: false,
		input_price: "0.000003",
		output_price: "0.000015",
		description: "Test model",
		caching_price: null,
		cached_price: null,
		...overrides,
	}
}

describe("getRequestyModels", () => {
	it("applies Fable 5.1 overrides when parsing anthropic/claude-fable-5.1", async () => {
		const rawFable51 = makeRawModel({
			id: "anthropic/claude-fable-5.1",
			max_output_tokens: 128000,
			context_window: 1000000,
			supports_caching: true,
			supports_vision: true,
			supports_reasoning: true,
			input_price: "0.00001",
			output_price: "0.00005",
			caching_price: "0.0000125",
			cached_price: "0.00000025",
		})

		mockAxiosGet.mockResolvedValueOnce({ data: { data: [rawFable51] } })

		const models = await getRequestyModels()
		const fable51 = models["anthropic/claude-fable-5.1"]

		expect(fable51).toBeDefined()
		expect(fable51.cacheReadsPrice).toBe(0.25)
		expect(fable51.supportsReasoningBudget).toBe(true)
		expect(fable51.supportsReasoningBinary).toBe(true)
		expect(fable51.supportsTemperature).toBe(false)
	})

	it("applies Fable 5 overrides when parsing anthropic/claude-fable-5", async () => {
		const rawFable5 = makeRawModel({
			id: "anthropic/claude-fable-5",
			max_output_tokens: 128000,
			context_window: 1000000,
			supports_caching: true,
			supports_vision: true,
			supports_reasoning: true,
			input_price: "0.00001",
			output_price: "0.00005",
			caching_price: "0.0000125",
			cached_price: "0.000001",
		})

		mockAxiosGet.mockResolvedValueOnce({ data: { data: [rawFable5] } })

		const models = await getRequestyModels()
		const fable5 = models["anthropic/claude-fable-5"]

		expect(fable5).toBeDefined()
		expect(fable5.supportsReasoningBudget).toBe(true)
		expect(fable5.supportsReasoningBinary).toBe(true)
		expect(fable5.supportsTemperature).toBe(false)
	})

	it("applies Sonnet 5 overrides when parsing anthropic/claude-sonnet-5", async () => {
		const rawSonnet5 = makeRawModel({
			id: "anthropic/claude-sonnet-5",
			max_output_tokens: 128000,
			context_window: 1000000,
			supports_caching: true,
			supports_vision: true,
			supports_reasoning: true,
			input_price: "0.000003",
			output_price: "0.000015",
			caching_price: "0.00000375",
			cached_price: "0.0000003",
		})

		mockAxiosGet.mockResolvedValueOnce({ data: { data: [rawSonnet5] } })

		const models = await getRequestyModels()
		const sonnet5 = models["anthropic/claude-sonnet-5"]

		expect(sonnet5).toBeDefined()
		expect(sonnet5.supportsReasoningBudget).toBe(true)
		expect(sonnet5.supportsReasoningBinary).toBe(true)
		expect(sonnet5.supportsTemperature).toBe(false)
	})

	it("applies Opus 5 overrides when parsing anthropic/claude-opus-5", async () => {
		const rawOpus5 = makeRawModel({
			id: "anthropic/claude-opus-5",
			max_output_tokens: 128000,
			context_window: 1000000,
			supports_caching: true,
			supports_vision: true,
			supports_reasoning: true,
			input_price: "0.000005",
			output_price: "0.000025",
			caching_price: "0.00000625",
			cached_price: "0.0000005",
		})

		mockAxiosGet.mockResolvedValueOnce({ data: { data: [rawOpus5] } })

		const models = await getRequestyModels()
		const opus5 = models["anthropic/claude-opus-5"]

		expect(opus5).toBeDefined()
		expect(opus5.supportsReasoningBudget).toBe(true)
		expect(opus5.supportsReasoningBinary).toBe(true)
		expect(opus5.supportsTemperature).toBe(false)
	})

	it("applies Opus 5.5 overrides when parsing anthropic/claude-opus-5-5", async () => {
		const rawOpus55 = makeRawModel({
			id: "anthropic/claude-opus-5-5",
			max_output_tokens: 128000,
			context_window: 1000000,
			supports_caching: true,
			supports_vision: true,
			supports_reasoning: true,
			input_price: "0.000004",
			output_price: "0.00002",
			caching_price: "0.000005",
			cached_price: "0.0000002",
		})

		mockAxiosGet.mockResolvedValueOnce({ data: { data: [rawOpus55] } })

		const models = await getRequestyModels()
		const opus55 = models["anthropic/claude-opus-5-5"]

		expect(opus55).toBeDefined()
		expect(opus55.supportsReasoningBudget).toBe(true)
		expect(opus55.supportsReasoningBinary).toBe(true)
		expect(opus55.supportsTemperature).toBe(false)
	})

	it("does not apply Fable 5 overrides to other models", async () => {
		const rawSonnet = makeRawModel({
			id: "anthropic/claude-sonnet-4.6",
			supports_reasoning: true,
		})

		mockAxiosGet.mockResolvedValueOnce({ data: { data: [rawSonnet] } })

		const models = await getRequestyModels()
		const sonnet = models["anthropic/claude-sonnet-4.6"]

		expect(sonnet.supportsReasoningBinary).toBeUndefined()
		expect(sonnet.supportsTemperature).toBeUndefined()
	})

	it("threads a wall-clock merged signal and the bounded timeout into the models request", async () => {
		const controller = new AbortController()
		mockAxiosGet.mockResolvedValueOnce({ data: { data: [] } })

		await getRequestyModels(undefined, undefined, { signal: controller.signal })

		// The shared axios mock accumulates calls across this file's tests, so assert on
		// the call this test just made (the last one) rather than a global call count.
		const calls = mockAxiosGet.mock.calls
		const config = calls[calls.length - 1]?.[1]
		expect(config?.signal).toBeInstanceOf(AbortSignal)
		// The request signal is the caller's signal merged with the wall-clock
		// deadline, not the raw caller signal: axios's timeout option resets when
		// headers arrive, so only the merged signal enforces the 10_000 ms limit.
		expect(config?.signal).not.toBe(controller.signal)
		expect(config?.timeout).toBe(10_000)

		// The caller's abort still propagates through the merged signal.
		controller.abort()
		expect(config?.signal?.aborted).toBe(true)
	})

	it("applies the bounded timeout as a standalone timeout signal when no signal is provided", async () => {
		mockAxiosGet.mockResolvedValueOnce({ data: { data: [] } })

		await getRequestyModels()

		const calls = mockAxiosGet.mock.calls
		const config = calls[calls.length - 1]?.[1]
		// Even without a caller signal the request carries the wall-clock deadline
		// as its own timeout signal.
		expect(config?.signal).toBeInstanceOf(AbortSignal)
		expect(config?.signal?.aborted).toBe(false)
		expect(config?.timeout).toBe(10_000)
	})

	it("passes a merged request signal and the bounded timeout to the catalog request", async () => {
		const controller = new AbortController()
		mockAxiosGet.mockResolvedValueOnce({ data: { data: [] } })

		await getRequestyModels(undefined, undefined, { signal: controller.signal })

		const calls = mockAxiosGet.mock.calls
		const config = calls[calls.length - 1]?.[1]
		expect(mockAxiosGet).toHaveBeenCalledWith("https://router.requesty.ai/v1/models", {
			headers: {},
			signal: config?.signal,
			timeout: 10_000,
		})
		expect(config?.signal).toBeInstanceOf(AbortSignal)
	})

	it("aborts the catalog request when the caller signal aborts after the request signal was merged", async () => {
		const controller = new AbortController()
		let requestSignal: AbortSignal | undefined
		mockAxiosGet.mockImplementation(((_url: string, config?: { signal?: AbortSignal }) => {
			requestSignal = config?.signal
			// Mirror the HTTP client: reject when the request signal fires.
			return new Promise<never>((_resolve, reject) => {
				requestSignal?.addEventListener("abort", () => reject(new Error("canceled")), { once: true })
			})
		}) as typeof axios.get)

		const fetchPromise = getRequestyModels(undefined, undefined, { signal: controller.signal })
		expect(requestSignal).toBeInstanceOf(AbortSignal)
		expect(requestSignal).not.toBe(controller.signal)
		controller.abort()

		await expect(fetchPromise).rejects.toMatchObject({ name: "AbortError" })
	})

	it("rejects with an AbortError when the signal aborts the pending request", async () => {
		const controller = new AbortController()
		mockAxiosGet.mockImplementation((_url, config) => {
			// Mirror the HTTP client: a request rejects when its signal fires,
			// including when the signal was already aborted when the request started.
			return new Promise<never>((_resolve, reject) => {
				if (config?.signal?.aborted) {
					reject(new Error("canceled"))
					return
				}
				config?.signal?.addEventListener?.("abort", () => reject(new Error("canceled")), { once: true })
			})
		})

		const fetchPromise = getRequestyModels(undefined, undefined, { signal: controller.signal })
		controller.abort()

		await expect(fetchPromise).rejects.toMatchObject({ name: "AbortError" })
	})
})
