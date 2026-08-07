import type { FimRequest } from "../providers/FimCompletionHandler"
import { OpenAiCompatibleFimHandler } from "../providers/OpenAiCompatibleFimHandler"

vi.mock("vscode", async () => {
	const actual = await vi.importActual<typeof import("vscode")>("vscode")
	return { ...actual, InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 } }
})

const openaiMocks = vi.hoisted(() => ({
	create: vi.fn(),
	chatCreate: vi.fn(),
	list: vi.fn(),
	ctor: vi.fn(),
}))

vi.mock("openai", () => ({
	default: class {
		baseURL: string
		apiKey: string
		maxRetries: number
		completions: { create: typeof openaiMocks.create }
		chat: { completions: { create: typeof openaiMocks.chatCreate } }
		models: { list: typeof openaiMocks.list }

		constructor(options: { baseURL: string; apiKey: string; maxRetries: number }) {
			openaiMocks.ctor(options)
			this.baseURL = options.baseURL
			this.apiKey = options.apiKey
			this.maxRetries = options.maxRetries
			this.completions = { create: openaiMocks.create }
			this.chat = { completions: { create: openaiMocks.chatCreate } }
			this.models = { list: openaiMocks.list }
		}
	},
}))

function makeRequest(overrides: Partial<FimRequest> = {}): FimRequest {
	return {
		modelId: "qwen2.5-coder-1.5b-instruct",
		baseUrl: "http://localhost:1234",
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

function streamOf(chunks: string[]) {
	return {
		[Symbol.asyncIterator]: async function* () {
			for (const chunk of chunks) {
				yield { choices: [{ text: chunk }] }
			}
		},
	}
}

describe("OpenAiCompatibleFimHandler", () => {
	let handler: OpenAiCompatibleFimHandler

	beforeEach(() => {
		vi.clearAllMocks()
		handler = new OpenAiCompatibleFimHandler({
			getConfig: () => ({ modelId: "qwen2.5-coder-1.5b-instruct", baseUrl: "http://localhost:1234" }),
			getApiKey: () => undefined,
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("sends a native FIM request with prefix and suffix", async () => {
		openaiMocks.create.mockResolvedValueOnce(streamOf(["b", "()"]))

		const chunks: string[] = []
		for await (const chunk of handler.streamFim(makeRequest())) {
			chunks.push(chunk)
		}
		expect(chunks.join("")).toBe("b()")

		const [params, options] = openaiMocks.create.mock.calls[0]
		expect(params.model).toBe("qwen2.5-coder-1.5b-instruct")
		expect(params.prompt).toBe("function fi")
		expect(params.suffix).toBe(") { return a + b }")
		expect(params.stream).toBe(true)
		expect(params.max_tokens).toBe(256)
		expect(options.signal).toBeDefined()
	})

	it("constructs the client with the noop key and /v1 base URL", async () => {
		openaiMocks.create.mockResolvedValueOnce(streamOf(["x"]))

		for await (const _chunk of handler.streamFim(makeRequest())) {
			// consume
		}

		expect(openaiMocks.ctor).toHaveBeenCalledWith(
			expect.objectContaining({
				baseURL: "http://localhost:1234/v1",
				apiKey: "noop",
				maxRetries: 0,
			}),
		)
	})

	it("retries with the rendered prompt on a 400 suffix rejection", async () => {
		const rejection = Object.assign(new Error("suffix not supported"), { status: 400 })
		openaiMocks.create.mockRejectedValueOnce(rejection).mockResolvedValueOnce(streamOf(["completion"]))

		const chunks: string[] = []
		for await (const chunk of handler.streamFim(makeRequest())) {
			chunks.push(chunk)
		}
		expect(chunks.join("")).toBe("completion")

		// Second call uses the rendered prompt and no suffix
		const retryParams = openaiMocks.create.mock.calls[1][0]
		expect(retryParams.prompt).toBe("function fi) { return a + b }")
		expect(retryParams.suffix).toBeUndefined()
	})

	it("memoises the degraded mode per baseUrl", async () => {
		const rejection = Object.assign(new Error("suffix not supported"), { status: 422 })
		openaiMocks.create
			.mockRejectedValueOnce(rejection)
			.mockResolvedValueOnce(streamOf(["x"]))
			.mockResolvedValueOnce(streamOf(["y"]))

		// First request: 422 → retry with rendered prompt
		for await (const _chunk of handler.streamFim(makeRequest())) {
			// consume
		}

		// Second request: straight to rendered prompt, no retry
		for await (const _chunk of handler.streamFim(makeRequest())) {
			// consume
		}

		expect(openaiMocks.create).toHaveBeenCalledTimes(3)
		expect(openaiMocks.create.mock.calls[2][0].prompt).toBe("function fi) { return a + b }")
	})

	it("swallows AbortError", async () => {
		openaiMocks.create.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"))

		const chunks: string[] = []
		for await (const chunk of handler.streamFim(makeRequest())) {
			chunks.push(chunk)
		}
		expect(chunks).toHaveLength(0)
	})

	it("rethrows non-abort, non-suffix errors", async () => {
		openaiMocks.create.mockRejectedValueOnce(new Error("network down"))

		await expect(async () => {
			for await (const _chunk of handler.streamFim(makeRequest())) {
				// should throw
			}
		}).rejects.toThrow("network down")
	})

	it("lists models from the /v1/models endpoint", async () => {
		openaiMocks.list.mockResolvedValueOnce({
			data: [{ id: "qwen2.5-coder-1.5b-instruct" }, { id: "llama-3.2-3b" }],
		})

		const models = await handler.listModels(new AbortController().signal)
		expect(models.map((m) => m.id)).toEqual(["qwen2.5-coder-1.5b-instruct", "llama-3.2-3b"])
	})

	it("validates a known model", async () => {
		openaiMocks.list.mockResolvedValueOnce({
			data: [{ id: "qwen2.5-coder-1.5b-instruct" }],
		})

		const result = await handler.validate(new AbortController().signal)
		expect(result.ok).toBe(true)
	})

	it("fails validation for an unknown model", async () => {
		openaiMocks.list.mockResolvedValueOnce({
			data: [{ id: "other-model" }],
		})

		const result = await handler.validate(new AbortController().signal)
		expect(result.ok).toBe(false)
	})

	describe("chat endpoint path", () => {
		async function drain(gen: AsyncGenerator<string, void, undefined>): Promise<string> {
			let out = ""
			for await (const chunk of gen) {
				out += chunk
			}
			return out
		}

		function chatStream(deltas: string[]) {
			return {
				async *[Symbol.asyncIterator]() {
					for (const content of deltas) {
						yield { choices: [{ delta: { content } }] }
					}
				},
			}
		}

		it("routes an instruction-tuned model through chat completions", async () => {
			openaiMocks.chatCreate.mockResolvedValueOnce(chatStream(["a + b"]))

			const text = await drain(
				handler.streamFim(makeRequest({ useChatEndpoint: true, systemPrompt: "be terse", supportsFim: false })),
			)

			expect(text).toBe("a + b")
			expect(openaiMocks.create).not.toHaveBeenCalled()
		})

		it("sends the system prompt as its own message", async () => {
			// In a raw completions prompt the model simply continues the instruction
			// text; only a system message is structurally out of band.
			openaiMocks.chatCreate.mockResolvedValueOnce(chatStream([""]))

			await drain(
				handler.streamFim(makeRequest({ useChatEndpoint: true, systemPrompt: "be terse", supportsFim: false })),
			)

			const payload = openaiMocks.chatCreate.mock.calls[0][0]
			expect(payload.messages[0]).toEqual({ role: "system", content: "be terse" })
			expect(payload.messages[1].role).toBe("user")
		})

		it("omits the system message when there is no system prompt", async () => {
			openaiMocks.chatCreate.mockResolvedValueOnce(chatStream([""]))

			await drain(handler.streamFim(makeRequest({ useChatEndpoint: true, supportsFim: false })))

			expect(openaiMocks.chatCreate.mock.calls[0][0].messages).toHaveLength(1)
		})

		it("drops the code-fence stop so a fenced reply is not truncated to nothing", async () => {
			openaiMocks.chatCreate.mockResolvedValueOnce(chatStream([""]))

			await drain(
				handler.streamFim(
					makeRequest({ useChatEndpoint: true, supportsFim: false, stopSequences: ["```", "<|im_end|>"] }),
				),
			)

			expect(openaiMocks.chatCreate.mock.calls[0][0].stop).not.toContain("```")
		})

		it("swallows an abort on the chat path", async () => {
			const error = new Error("aborted")
			error.name = "AbortError"
			openaiMocks.chatCreate.mockRejectedValueOnce(error)

			const text = await drain(handler.streamFim(makeRequest({ useChatEndpoint: true, supportsFim: false })))

			expect(text).toBe("")
		})

		it("surfaces an auth rejection with an actionable message", async () => {
			// Hosted endpoints serve their model catalogue publicly but reject
			// completions, so this looks configured while producing nothing.
			const error = Object.assign(new Error("unauthorized"), { status: 401 })
			openaiMocks.chatCreate.mockRejectedValueOnce(error)

			await expect(
				drain(handler.streamFim(makeRequest({ useChatEndpoint: true, supportsFim: false }))),
			).rejects.toThrow("API key")
		})
	})

	describe("base URL normalization", () => {
		it("does not double up a /v1 the user already typed", async () => {
			openaiMocks.create.mockResolvedValueOnce({
				async *[Symbol.asyncIterator]() {
					yield { choices: [{ text: "" }] }
				},
			})

			const gen = handler.streamFim(makeRequest({ baseUrl: "http://localhost:1234/v1" }))
			for await (const _ of gen) {
				// drain
			}

			expect(openaiMocks.ctor.mock.calls.at(-1)?.[0].baseURL).toBe("http://localhost:1234/v1")
		})

		it("adds a scheme to a bare host", async () => {
			openaiMocks.create.mockResolvedValueOnce({
				async *[Symbol.asyncIterator]() {
					yield { choices: [{ text: "" }] }
				},
			})

			const gen = handler.streamFim(makeRequest({ baseUrl: "localhost:1234" }))
			for await (const _ of gen) {
				// drain
			}

			expect(openaiMocks.ctor.mock.calls.at(-1)?.[0].baseURL).toBe("http://localhost:1234/v1")
		})
	})
})
