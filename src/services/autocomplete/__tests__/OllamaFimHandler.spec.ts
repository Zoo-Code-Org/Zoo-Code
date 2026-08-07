import type { FimRequest } from "../providers/FimCompletionHandler"
import { OllamaFimHandler } from "../providers/OllamaFimHandler"

vi.mock("vscode", async () => {
	const actual = await vi.importActual<typeof import("vscode")>("vscode")
	return { ...actual, InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 } }
})

function makeReadableStream(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder()
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk))
			}
			controller.close()
		},
	})
}

function ndjsonStream(items: unknown[]): ReadableStream<Uint8Array> {
	return makeReadableStream(items.map((item) => `${JSON.stringify(item)}\n`))
}

function makeRequest(overrides: Partial<FimRequest> = {}): FimRequest {
	return {
		modelId: "qwen2.5-coder:1.5b-base",
		baseUrl: "http://localhost:11434",
		apiKey: undefined,
		prefix: "function fi",
		suffix: ") { return a + b }",
		renderedPrompt: "function fi) { return a + b }",
		supportsFim: true,
		useChatEndpoint: false,
		stopSequences: ["<|fim_pad|>"],
		temperature: 0.01,
		maxOutputTokens: 256,
		contextLength: 8192,
		requestTimeoutMs: 5000,
		signal: new AbortController().signal,
		...overrides,
	}
}

describe("OllamaFimHandler", () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn()
		globalThis.fetch = fetchMock as typeof fetch
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("sends a native FIM request with prefix and suffix", async () => {
		fetchMock.mockResolvedValueOnce({
			ok: true,
			body: ndjsonStream([
				{ response: "b", done: false },
				{ response: "()", done: true },
			]),
		})

		const handler = new OllamaFimHandler({
			getConfig: () => ({ modelId: "qwen2.5-coder:1.5b-base", baseUrl: "http://localhost:11434" }),
			getApiKey: () => undefined,
		})

		const chunks: string[] = []

		for await (const chunk of handler.streamFim(makeRequest())) {
			chunks.push(chunk)
		}

		expect(chunks.join("")).toBe("b()")

		const call = fetchMock.mock.calls[0]
		const url = call[0]
		const body = JSON.parse(call[1].body)

		expect(url).toBe("http://localhost:11434/api/generate")
		expect(body.model).toBe("qwen2.5-coder:1.5b-base")
		expect(body.prompt).toBe("function fi")
		expect(body.suffix).toBe(") { return a + b }")
		expect(body.stream).toBe(true)
		expect(body.options.temperature).toBe(0.01)
		expect(body.options.num_predict).toBe(256)
		expect(body.options.stop).toEqual(["<|fim_pad|>"])
	})

	it("parses NDJSON across partial line boundaries", async () => {
		// Stream where JSON objects are split across chunks
		const encoder = new TextEncoder()
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('{"response": "hel'))
				controller.enqueue(encoder.encode('lo", "done": false}\n'))
				controller.enqueue(encoder.encode('{"response": " world", "done": true}\n'))
				controller.close()
			},
		})

		fetchMock.mockResolvedValueOnce({ ok: true, body: stream })

		const handler = new OllamaFimHandler({
			getConfig: () => ({ modelId: "model", baseUrl: "http://localhost:11434" }),
			getApiKey: () => undefined,
		})

		const chunks: string[] = []
		for await (const chunk of handler.streamFim(makeRequest())) {
			chunks.push(chunk)
		}
		expect(chunks.join("")).toBe("hello world")
	})

	it("falls back to raw prompt on 400 'does not support insert'", async () => {
		// First call: 400 with the "does not support insert" error
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 400,
			text: async () => "model does not support insert mode",
		})

		// Second call (retry): 200 with raw prompt
		fetchMock.mockResolvedValueOnce({
			ok: true,
			body: ndjsonStream([{ response: "completion", done: true }]),
		})

		const handler = new OllamaFimHandler({
			getConfig: () => ({ modelId: "model", baseUrl: "http://localhost:11434" }),
			getApiKey: () => undefined,
		})

		const chunks: string[] = []
		for await (const chunk of handler.streamFim(makeRequest())) {
			chunks.push(chunk)
		}
		expect(chunks.join("")).toBe("completion")

		// Second request should use raw mode
		const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body)
		expect(retryBody.raw).toBe(true)
		expect(retryBody.prompt).toBe("function fi) { return a + b }")
		expect(retryBody.suffix).toBeUndefined()
	})

	it("memoises the degraded mode for subsequent requests", async () => {
		// First request: 400, triggers fallback
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 400,
			text: async () => "does not support insert",
		})
		fetchMock.mockResolvedValueOnce({
			ok: true,
			body: ndjsonStream([{ response: "x", done: true }]),
		})

		const handler = new OllamaFimHandler({
			getConfig: () => ({ modelId: "model", baseUrl: "http://localhost:11434" }),
			getApiKey: () => undefined,
		})

		// Consume first request (triggers fallback + memoisation)
		const first: string[] = []
		for await (const chunk of handler.streamFim(makeRequest())) {
			first.push(chunk)
		}

		// Second request should use raw mode immediately (no 400 retry)
		fetchMock.mockResolvedValueOnce({
			ok: true,
			body: ndjsonStream([{ response: "y", done: true }]),
		})
		const second: string[] = []
		for await (const chunk of handler.streamFim(makeRequest())) {
			second.push(chunk)
		}
		expect(second.join("")).toBe("y")

		// Only 3 fetch calls total (1 failed + 1 retry + 1 direct-raw)
		expect(fetchMock).toHaveBeenCalledTimes(3)
		expect(JSON.parse(fetchMock.mock.calls[2][1].body).raw).toBe(true)
	})

	it("throws on a non-400 error response", async () => {
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 500,
			text: async () => "Internal server error",
		})

		const handler = new OllamaFimHandler({
			getConfig: () => ({ modelId: "model", baseUrl: "http://localhost:11434" }),
			getApiKey: () => undefined,
		})

		await expect(async () => {
			for await (const _chunk of handler.streamFim(makeRequest())) {
				// should throw
			}
		}).rejects.toThrow("Ollama generate failed (500)")
	})

	it("throws on an error field in the stream", async () => {
		fetchMock.mockResolvedValueOnce({
			ok: true,
			body: ndjsonStream([{ error: "model not found" }]),
		})

		const handler = new OllamaFimHandler({
			getConfig: () => ({ modelId: "model", baseUrl: "http://localhost:11434" }),
			getApiKey: () => undefined,
		})

		await expect(async () => {
			for await (const _chunk of handler.streamFim(makeRequest())) {
				// should throw
			}
		}).rejects.toThrow("model not found")
	})

	it("swallows AbortError from a cancelled stream", async () => {
		const encoder = new TextEncoder()
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('{"response": "hel'))
				// Simulate the reader being cancelled (AbortError)
				controller.error(new DOMException("Aborted", "AbortError"))
			},
		})

		fetchMock.mockResolvedValueOnce({ ok: true, body: stream })

		const handler = new OllamaFimHandler({
			getConfig: () => ({ modelId: "model", baseUrl: "http://localhost:11434" }),
			getApiKey: () => undefined,
		})

		// Should not throw — AbortError is swallowed. Partial buffered data is
		// dropped: a cancelled request must not yield stale output.
		const chunks: string[] = []
		for await (const chunk of handler.streamFim(makeRequest())) {
			chunks.push(chunk)
		}
		expect(chunks.join("")).toBe("")
	})

	describe("listModels", () => {
		const handlerFor = (modelId?: string) =>
			new OllamaFimHandler({
				getConfig: () => ({ modelId, baseUrl: "http://localhost:11434" }),
				getApiKey: () => undefined,
			})

		const tagsResponse = (body: unknown) => ({ ok: true, json: async () => body })

		it("maps the tag list to model summaries", async () => {
			fetchMock.mockResolvedValue(tagsResponse({ models: [{ name: "qwen2.5-coder:1.5b-base" }] }))

			const models = await handlerFor().listModels(new AbortController().signal)

			expect(models).toEqual([
				{
					id: "qwen2.5-coder:1.5b-base",
					label: "qwen2.5-coder:1.5b-base",
					contextWindow: undefined,
					supportsFim: true,
				},
			])
		})

		it("drops models that cannot serve completions", async () => {
			// An embedding-only model appears in /api/tags but can never complete.
			fetchMock.mockResolvedValue(
				tagsResponse({
					models: [
						{ name: "nomic-embed-text", capabilities: ["embedding"] },
						{ name: "qwen2.5-coder:1.5b-base", capabilities: ["completion"] },
					],
				}),
			)

			const models = await handlerFor().listModels(new AbortController().signal)

			expect(models.map((m) => m.id)).toEqual(["qwen2.5-coder:1.5b-base"])
		})

		it("keeps models that declare no capabilities at all", async () => {
			fetchMock.mockResolvedValue(tagsResponse({ models: [{ name: "legacy-model" }] }))

			expect(await handlerFor().listModels(new AbortController().signal)).toHaveLength(1)
		})

		it("returns an empty list when the payload does not match the schema", async () => {
			fetchMock.mockResolvedValue(tagsResponse({ unexpected: true }))

			expect(await handlerFor().listModels(new AbortController().signal)).toEqual([])
		})

		it("throws when the tags endpoint rejects", async () => {
			fetchMock.mockResolvedValue({ ok: false, status: 500 })

			await expect(handlerFor().listModels(new AbortController().signal)).rejects.toThrow("500")
		})
	})

	describe("validate", () => {
		const handlerFor = (modelId?: string) =>
			new OllamaFimHandler({
				getConfig: () => ({ modelId, baseUrl: "http://localhost:11434" }),
				getApiKey: () => undefined,
			})

		it("succeeds when the configured model is present", async () => {
			fetchMock.mockResolvedValue({ ok: true, json: async () => ({ models: [{ name: "qwen:base" }] }) })

			const result = await handlerFor("qwen:base").validate(new AbortController().signal)

			expect(result.ok).toBe(true)
		})

		it("fails with a clear message when the model is not pulled", async () => {
			fetchMock.mockResolvedValue({ ok: true, json: async () => ({ models: [{ name: "other" }] }) })

			const result = await handlerFor("qwen:base").validate(new AbortController().signal)

			expect(result).toEqual({ ok: false, error: expect.stringContaining("was not found") })
		})

		it("reports a transport failure as the validation error", async () => {
			// An unreachable server is the most common misconfiguration; surfacing the
			// message is the difference between "broken" and "not running".
			fetchMock.mockRejectedValue(new Error("ECONNREFUSED"))

			const result = await handlerFor("qwen:base").validate(new AbortController().signal)

			expect(result).toEqual({ ok: false, error: "ECONNREFUSED" })
		})
	})
})
