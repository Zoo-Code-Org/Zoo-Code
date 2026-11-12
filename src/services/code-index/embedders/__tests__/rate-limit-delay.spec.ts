import "../../__tests__/mock-code-index-log"
import { OpenAiEmbedder } from "../openai"
import { OpenAICompatibleEmbedder } from "../openai-compatible"
import { OpenRouterEmbedder } from "../openrouter"
import { GeminiEmbedder } from "../gemini"
import { MistralEmbedder } from "../mistral"
import { VercelAiGatewayEmbedder } from "../vercel-ai-gateway"
import { CodeIndexOllamaEmbedder } from "../ollama"
import { pacedTransportWriter } from "./paced-transport-writer"
import { codeIndexLog } from "../../code-index-log"

vi.mock("../../../../api/providers/openai-native", () => ({
	OpenAiNativeHandler: class {
		constructor(protected options: unknown) {}
	},
}))
vi.mock("../../../../i18n", () => ({ t: (key: string) => key }))

const factories = [
	["OpenAI", () => new OpenAiEmbedder({ openAiNativeApiKey: "test-key" })],
	["compatible SDK", () => new OpenAICompatibleEmbedder("https://example.test/v1", "test-key")],
	["compatible fetch", () => new OpenAICompatibleEmbedder("https://example.test/embeddings", "test-key")],
	["OpenRouter", () => new OpenRouterEmbedder("test-key")],
	["Gemini", () => new GeminiEmbedder("test-key")],
	["Mistral", () => new MistralEmbedder("test-key")],
	["Vercel", () => new VercelAiGatewayEmbedder("test-key")],
	["Ollama", () => new CodeIndexOllamaEmbedder({ ollamaBaseUrl: "https://example.test" })],
] as const

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(new Date("2026-11-11T12:00:00Z"))
	vi.spyOn(Math, "random").mockReturnValue(0)
	vi.mocked(codeIndexLog.info).mockClear()
})
afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

function response(status = 200, headers: Record<string, string> = {}) {
	return new Response(
		JSON.stringify(
			status === 200
				? { data: [{ embedding: [1, 0] }], embeddings: [[1, 0]] }
				: { error: { message: "limited" } },
		),
		{
			status,
			headers: { "content-type": "application/json", ...headers },
		},
	)
}

describe.each(factories)("T25 %s paced transport", (_name, createEmbedder) => {
	it.each(
		[2, 60, 120].flatMap((seconds) => [
			{ header: "retry-after", value: String(seconds), delay: seconds * 1000 },
			{ header: "retry-after-ms", value: String(seconds * 1000), delay: seconds * 1000 },
			{
				header: "retry-after",
				value: new Date(Date.parse("2026-11-11T12:00:00Z") + seconds * 1000).toUTCString(),
				delay: seconds * 1000,
			},
		]),
	)("honors the entire $header: $value", async ({ header, value, delay }) => {
		const request = vi
			.fn()
			.mockImplementationOnce(async () => response(429, { [header]: value }))
			.mockImplementation(async () => response())
		vi.stubGlobal("fetch", request)
		const { replace, failures, cache } = pacedTransportWriter()
		const pending = replace(createEmbedder())
		await vi.advanceTimersByTimeAsync(0)
		expect(request).toHaveBeenCalledOnce()
		expect(failures.list()).toEqual([])
		await vi.advanceTimersByTimeAsync(delay - 1)
		expect(request).toHaveBeenCalledOnce()
		await vi.advanceTimersByTimeAsync(1)
		await pending
		expect(request).toHaveBeenCalledTimes(2)
		expect(failures.list()).toEqual([])
		expect(cache.completeFile).toHaveBeenCalledOnce()
	})

	it.each([undefined, "invalid", "-1", "Tue, 10 Nov 2026 12:00:00 GMT"])(
		"recovers after four limits with growing fallback for %s and no budget charge",
		async (header) => {
			let issued = 0
			const request = vi.fn(async () =>
				++issued <= 4 ? response(429, header === undefined ? {} : { "retry-after": header }) : response(),
			)
			vi.stubGlobal("fetch", request)
			const { replace, failures, cache } = pacedTransportWriter()
			const pending = replace(createEmbedder())
			await vi.advanceTimersByTimeAsync(0)
			for (const [index, delay] of [500, 1000, 2000, 4000].entries()) {
				expect(request).toHaveBeenCalledTimes(index + 1)
				expect(failures.list()).toEqual([])
				expect(cache.completeFile).not.toHaveBeenCalled()
				await vi.advanceTimersByTimeAsync(delay - 1)
				expect(request).toHaveBeenCalledTimes(index + 1)
				await vi.advanceTimersByTimeAsync(1)
			}
			await pending
			expect(request).toHaveBeenCalledTimes(5)
			expect(failures.list()).toEqual([])
			expect(cache.completeFile).toHaveBeenCalledOnce()
			expect(codeIndexLog.info).toHaveBeenCalledTimes(4)
		},
	)

	it("cancels a provider wait without another transport request or failure entry", async () => {
		const request = vi.fn(async () => response(429, { "retry-after": "120" }))
		vi.stubGlobal("fetch", request)
		const controller = new AbortController()
		const { replace, failures, pacers } = pacedTransportWriter()
		const pending = replace(createEmbedder(), controller.signal).catch((error: unknown) => error)
		await vi.advanceTimersByTimeAsync(0)
		expect(request).toHaveBeenCalledOnce()
		expect(pacers.waitingPaths()).toEqual(["test.ts"])
		expect(failures.list()).toEqual([])
		controller.abort()
		expect(await pending).toBe(controller.signal.reason)
		await vi.advanceTimersByTimeAsync(240_000)
		expect(request).toHaveBeenCalledOnce()
		expect(failures.list()).toEqual([])
	})
})
