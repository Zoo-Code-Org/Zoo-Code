import axios from "axios"

import {
	STANDARD_COMPUTE_BASE_URL,
	standardComputeDefaultModelId,
	standardComputeDefaultModelInfo,
} from "@roo-code/types"

import { getStandardComputeModels, parseStandardComputeModel } from "../standard-compute"

vi.mock("axios")

describe("Standard Compute model fetcher", () => {
	beforeEach(() => vi.clearAllMocks())

	it("requests the catalog with optional Bearer authorization", async () => {
		vi.mocked(axios.get).mockResolvedValue({ data: { data: [] } })
		await getStandardComputeModels("key-a")
		expect(axios.get).toHaveBeenCalledWith(`${STANDARD_COMPUTE_BASE_URL}/models`, {
			headers: { Authorization: "Bearer key-a" },
			timeout: 10_000,
			signal: undefined,
		})
	})

	it("supports unauthenticated catalog requests", async () => {
		vi.mocked(axios.get).mockResolvedValue({ data: { data: [] } })
		await getStandardComputeModels()
		expect(axios.get).toHaveBeenCalledWith(`${STANDARD_COMPUTE_BASE_URL}/models`, {
			headers: undefined,
			timeout: 10_000,
			signal: undefined,
		})
	})

	it("forwards the caller's abort signal to the request", async () => {
		vi.mocked(axios.get).mockResolvedValue({ data: { data: [] } })
		const controller = new AbortController()

		await getStandardComputeModels("test-key", { signal: controller.signal })

		expect(axios.get).toHaveBeenCalledWith(`${STANDARD_COMPUTE_BASE_URL}/models`, {
			headers: { Authorization: "Bearer test-key" },
			timeout: 10_000,
			signal: controller.signal,
		})
	})

	it("rejects with an AbortError when the signal aborts the pending request", async () => {
		const controller = new AbortController()
		vi.mocked(axios.get).mockImplementation((_url, config) => {
			// Mirror the HTTP client: a pending request rejects when its signal fires.
			return new Promise<never>((_resolve, reject) => {
				config?.signal?.addEventListener?.("abort", () => reject(new Error("canceled")), { once: true })
			})
		})

		const fetchPromise = getStandardComputeModels("k", { signal: controller.signal })
		controller.abort()

		await expect(fetchPromise).rejects.toMatchObject({ name: "AbortError" })
	})

	it("maps catalog metadata for multiple models", async () => {
		vi.mocked(axios.get).mockResolvedValue({
			data: {
				object: "list",
				data: [
					{
						id: "vision-model",
						object: "model",
						created: 0,
						owned_by: "StandardCompute",
						display_name: "Vision Model",
						context_length: 1_048_576,
						architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
						supported_parameters: ["tools", "tool_choice", "reasoning"],
						unknown: "allowed",
					},
					{
						id: "text-model",
						context_length: 262_144,
						architecture: { input_modalities: ["text"] },
						supported_parameters: ["tools"],
					},
				],
			},
		})

		const models = await getStandardComputeModels()
		expect(Object.keys(models)).toEqual(["vision-model", "text-model"])
		expect(models["vision-model"]).toEqual({
			contextWindow: 1_048_576,
			maxTokens: standardComputeDefaultModelInfo.maxTokens,
			supportsImages: true,
			supportsPromptCache: false,
			displayName: "Vision Model",
		})
		expect(models["text-model"].supportsImages).toBe(false)
		expect(models["text-model"].contextWindow).toBe(262_144)
	})

	it("marks the routed model as image capable when the catalog lists no modalities", () => {
		const info = parseStandardComputeModel({ id: standardComputeDefaultModelId, context_length: 1_000_000 })
		expect(info.supportsImages).toBe(true)
		expect(info.contextWindow).toBe(1_000_000)
	})

	it("keeps the routed model image capable when its modality list omits images", () => {
		const info = parseStandardComputeModel({
			id: standardComputeDefaultModelId,
			architecture: { input_modalities: ["text"] },
		})
		expect(info.supportsImages).toBe(true)
	})

	it("skips models whose context window leaves no output budget", async () => {
		vi.mocked(axios.get).mockResolvedValue({
			data: {
				data: [
					{ id: "tiny-1", context_length: 1 },
					{ id: "tiny-4", context_length: 4 },
					{ id: "smallest-usable", context_length: 5 },
				],
			},
		})
		const models = await getStandardComputeModels()
		expect(Object.keys(models)).toEqual(["smallest-usable"])
		expect(models["smallest-usable"]).toMatchObject({ contextWindow: 5, maxTokens: 1 })
	})

	it("skips malformed records and models without tool support", async () => {
		vi.mocked(axios.get).mockResolvedValue({
			data: {
				data: [
					{ id: "eligible" },
					{ missing: "id" },
					{ id: "chat-only", supported_parameters: ["response_format"] },
				],
			},
		})
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
		expect(await getStandardComputeModels()).toEqual({
			eligible: {
				contextWindow: standardComputeDefaultModelInfo.contextWindow,
				maxTokens: standardComputeDefaultModelInfo.maxTokens,
				supportsImages: false,
				supportsPromptCache: false,
			},
		})
		expect(warning).toHaveBeenCalledOnce()
		warning.mockRestore()
	})

	it("keeps a hostile catalog id as an own entry instead of polluting the prototype chain", async () => {
		vi.mocked(axios.get).mockResolvedValue({
			data: { data: [{ id: "__proto__", context_length: 8_192 }, { id: "constructor" }] },
		})
		const models = await getStandardComputeModels()
		expect(Object.getPrototypeOf(models)).toBeNull()
		expect(Object.keys(models)).toEqual(["__proto__", "constructor"])
		expect(models["__proto__"]).toMatchObject({ contextWindow: 8_192 })
		expect(({} as Record<string, unknown>).contextWindow).toBeUndefined()
	})

	it("falls back to the default context window for a null context_length", () => {
		const info = parseStandardComputeModel({ id: "legacy-entry", context_length: null })
		expect(info.contextWindow).toBe(standardComputeDefaultModelInfo.contextWindow)
		expect(info.maxTokens).toBe(standardComputeDefaultModelInfo.maxTokens)
	})

	it.each([{ data: null }, [], null])("returns no models for invalid top-level data %#", async (data) => {
		vi.mocked(axios.get).mockResolvedValue({ data })
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
		expect(await getStandardComputeModels()).toEqual({})
		warning.mockRestore()
	})

	it.each([new Error("network unavailable"), "network unavailable"])(
		"returns no models on network failure",
		async (error) => {
			vi.mocked(axios.get).mockRejectedValue(error)
			const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
			expect(await getStandardComputeModels()).toEqual({})
			consoleError.mockRestore()
		},
	)

	it("rejects invalid numeric metadata without leaking the API key in errors", async () => {
		vi.mocked(axios.get)
			.mockResolvedValueOnce({
				data: {
					data: [
						{ id: "valid", context_length: 8_192 },
						{ id: "invalid-context", context_length: -1 },
					],
				},
			})
			.mockRejectedValueOnce(new Error("upstream rejected secret-key"))
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)

		expect(await getStandardComputeModels("secret-key")).toEqual({
			valid: expect.objectContaining({ contextWindow: 8_192, maxTokens: 1_638 }),
		})
		expect(await getStandardComputeModels("secret-key")).toEqual({})
		expect(consoleError).toHaveBeenLastCalledWith(
			"Error fetching Standard Compute models: upstream rejected [REDACTED]",
		)

		warning.mockRestore()
		consoleError.mockRestore()
	})

	it("does not invent absent optional metadata", () => {
		const info = parseStandardComputeModel({ id: "minimal" })
		expect(info).toEqual({
			contextWindow: standardComputeDefaultModelInfo.contextWindow,
			maxTokens: standardComputeDefaultModelInfo.maxTokens,
			supportsImages: false,
			supportsPromptCache: false,
		})
	})
})
