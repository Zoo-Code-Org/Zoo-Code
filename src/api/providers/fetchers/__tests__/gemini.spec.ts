// Mocks must come first, before imports

const { mockList, mockConstruct } = vi.hoisted(() => ({
	mockList: vi.fn(),
	mockConstruct: vi.fn(),
}))

vi.mock("@google/genai", () => ({
	GoogleGenAI: class {
		constructor(options: unknown) {
			mockConstruct(options)
		}
		models = { list: mockList }
	},
}))

import { getGeminiModels } from "../gemini"
import { geminiModels } from "@roo-code/types"

// Builds the async-iterable pager that client.models.list() resolves to. The
// fetcher only iterates it, so a plain async iterable of minimal Model-likes
// (name only) is sufficient — no real SDK Pager is constructed.
function fakePager(names: Array<string | undefined>) {
	const models = names.map((name) => ({ name }))
	return {
		[Symbol.asyncIterator]() {
			let index = 0
			return {
				next(): Promise<IteratorResult<{ name?: string }>> {
					if (index < models.length) {
						return Promise.resolve({ value: models[index++], done: false })
					}
					return Promise.resolve({ value: undefined, done: true })
				},
			}
		},
	}
}

describe("getGeminiModels", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockList.mockResolvedValue(fakePager(["models/gemini-2.5-flash"]))
	})

	it("constructs the client with the caller's API key", async () => {
		await getGeminiModels("test-key")

		expect(mockConstruct).toHaveBeenCalledWith({ apiKey: "test-key" })
	})

	it("strips the models/ prefix and returns a null-prototype record", async () => {
		mockList.mockResolvedValue(fakePager(["models/gemini-2.5-flash", "models/gemini-3.8-flash"]))

		const models = await getGeminiModels("test-key")

		expect(Object.keys(models).sort()).toEqual(["gemini-2.5-flash", "gemini-3.8-flash"])
		expect(Object.getPrototypeOf(models)).toBeNull()
	})

	it("copies static specs from geminiModels for known model IDs", async () => {
		mockList.mockResolvedValue(fakePager(["models/gemini-2.5-flash"]))

		const models = await getGeminiModels("test-key")

		expect(models["gemini-2.5-flash"]).toEqual(geminiModels["gemini-2.5-flash"])
		// Known pricing must survive the merge so cost reporting stays accurate.
		expect(models["gemini-2.5-flash"].inputPrice).toBe(geminiModels["gemini-2.5-flash"].inputPrice)
	})

	it("applies Gemini-family defaults without pricing for unknown model IDs", async () => {
		mockList.mockResolvedValue(fakePager(["models/gemini-9.9-future"]))

		const models = await getGeminiModels("test-key")

		expect(models["gemini-9.9-future"]).toEqual({
			maxTokens: 65_536,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: true,
			description: "Gemini model: gemini-9.9-future",
		})
		// No pricing fields: cost must show "unknown", not charge default rates.
		expect(models["gemini-9.9-future"].inputPrice).toBeUndefined()
		expect(models["gemini-9.9-future"].outputPrice).toBeUndefined()
	})

	it("excludes embedding, TTS, and Imagen families and non-gemini IDs", async () => {
		mockList.mockResolvedValue(
			fakePager([
				"models/gemini-2.5-flash",
				"models/gemini-embedding-001",
				"models/gemini-2.5-flash-preview-tts",
				"models/imagen-3.0-generate-002",
				"models/embedding-001",
				"models/aqa",
			]),
		)

		const models = await getGeminiModels("test-key")

		// The catalog is limited to generative gemini-* models the handler can call.
		expect(Object.keys(models)).toEqual(["gemini-2.5-flash"])
	})

	it("skips entries with a missing resource name", async () => {
		mockList.mockResolvedValue(fakePager([undefined, "models/gemini-2.5-flash"]))

		const models = await getGeminiModels("test-key")

		expect(Object.keys(models)).toEqual(["gemini-2.5-flash"])
	})

	it("throws a clear error when no API key is provided", async () => {
		await expect(getGeminiModels()).rejects.toThrow("Failed to fetch Gemini models: API key is required.")
		expect(mockList).not.toHaveBeenCalled()
	})

	it("forwards the base URL through httpOptions", async () => {
		await getGeminiModels("test-key", "https://gemini-proxy.example")

		expect(mockList).toHaveBeenCalledWith({
			config: expect.objectContaining({
				httpOptions: { baseUrl: "https://gemini-proxy.example" },
			}),
		})
	})

	it("omits httpOptions when no base URL is provided", async () => {
		await getGeminiModels("test-key")

		expect(mockList).toHaveBeenCalledWith({
			config: expect.objectContaining({
				httpOptions: undefined,
			}),
		})
	})

	it("requests a single page large enough to hold the full catalog", async () => {
		await getGeminiModels("test-key")

		expect(mockList).toHaveBeenCalledWith({
			config: expect.objectContaining({
				pageSize: 1000,
			}),
		})
	})

	it("passes the caller's abort signal to the request", async () => {
		const controller = new AbortController()

		await getGeminiModels("test-key", undefined, { signal: controller.signal })

		expect(mockList).toHaveBeenCalledWith({
			config: expect.objectContaining({
				abortSignal: controller.signal,
			}),
		})
	})
})
