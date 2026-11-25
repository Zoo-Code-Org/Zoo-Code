import type OpenAI from "openai"

import { KIMI_CODE_BASE_URL } from "@roo-code/types"

import { KimiCodeHandler } from "../kimi-code"
import { collectStream, sseResponse } from "../../../test-utils/stream"

const { mockGetAccessToken, mockForceRefreshAccessToken, mockGetModels } = vi.hoisted(() => ({
	mockGetAccessToken: vi.fn<() => Promise<string | null>>(),
	mockForceRefreshAccessToken: vi.fn<() => Promise<string | null>>(),
	mockGetModels: vi.fn<() => Promise<Record<string, never>>>(),
}))

vi.mock("../../../integrations/kimi-code/oauth", () => ({
	kimiCodeOAuthManager: {
		getAccessToken: mockGetAccessToken,
		forceRefreshAccessToken: mockForceRefreshAccessToken,
	},
}))

vi.mock("../fetchers/modelCache", () => ({ getModels: mockGetModels }))

const mockFetch = vi.fn<typeof fetch>()
const finalUsage: OpenAI.CompletionUsage = {
	prompt_tokens: 12,
	completion_tokens: 7,
	total_tokens: 19,
	prompt_tokens_details: { cached_tokens: 4 },
}

// Synthetic OpenAI-compatible chunks, not a recorded Kimi Code response.
// The real SDK decodes SSE and the real handler parses usage.
function streamResponse(usage: OpenAI.CompletionUsage | null = finalUsage) {
	const header = { id: "chatcmpl_test", object: "chat.completion.chunk", created: 1, model: "kimi-for-coding" }
	const chunks = [
		{
			...header,
			choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }],
			...(usage && { usage: { ...usage, completion_tokens: 1, total_tokens: usage.prompt_tokens + 1 } }),
		},
		{ ...header, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		...(usage ? [{ ...header, choices: [], usage }] : []),
	]
	const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"
	return sseResponse(body)
}

function makeHandler(options: ConstructorParameters<typeof KimiCodeHandler>[0] = {}) {
	return new KimiCodeHandler({ kimiCodeAuthMethod: "api-key", kimiCodeApiKey: "test-kimi-key", ...options })
}

function requests() {
	return mockFetch.mock.calls.map(([input, init]) => new Request(input, init))
}

describe("KimiCodeHandler usage through the real SDK", () => {
	beforeEach(() => {
		mockFetch.mockReset()
		mockGetAccessToken.mockReset().mockResolvedValue("oauth-token")
		mockForceRefreshAccessToken.mockReset().mockResolvedValue("refreshed-token")
		mockGetModels.mockReset().mockResolvedValue({})
		vi.stubGlobal("fetch", mockFetch)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it.each([
		{ method: "api-key", authMethod: "api-key", token: "test-kimi-key" },
		{ method: "OAuth", authMethod: "oauth", token: "oauth-token" },
		{ method: "default OAuth", authMethod: undefined, token: "oauth-token" },
	] as const)("reports final totals once with $method authentication", async ({ authMethod, token }) => {
		mockFetch.mockResolvedValueOnce(streamResponse())
		const handler = makeHandler({ kimiCodeAuthMethod: authMethod })
		const chunks = await collectStream(
			handler.createMessage("Answer briefly.", [{ role: "user", content: "Hello" }]),
		)

		expect(chunks).toEqual([
			{ type: "text", text: "Hello" },
			{ type: "usage", inputTokens: 12, outputTokens: 7, cacheReadTokens: 4, cacheWriteTokens: undefined },
		])
		expect(mockFetch).toHaveBeenCalledOnce()
		const request = requests()[0]
		expect(request.url).toBe(`${KIMI_CODE_BASE_URL}/chat/completions`)
		expect(request.headers.get("authorization")).toBe(`Bearer ${token}`)
		await expect(request.json()).resolves.toMatchObject({
			model: "kimi-for-coding",
			stream: true,
			stream_options: { include_usage: true },
		})
		if (authMethod === "api-key") {
			expect(mockGetAccessToken).not.toHaveBeenCalled()
		} else {
			expect(mockGetAccessToken).toHaveBeenCalledOnce()
		}
	})

	it.each([
		{ name: "absent cache details", usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } },
		{ name: "zero cache reads", usage: { ...finalUsage, prompt_tokens_details: { cached_tokens: 0 } } },
		{ name: "zero token totals", usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
	])("preserves usage with $name", async ({ usage }) => {
		mockFetch.mockResolvedValueOnce(streamResponse(usage))
		const chunks = await collectStream(makeHandler().createMessage("", [{ role: "user", content: "Hello" }]))

		expect(chunks.filter((chunk) => chunk.type === "usage")).toEqual([
			{
				type: "usage",
				inputTokens: usage.prompt_tokens,
				outputTokens: usage.completion_tokens,
				cacheReadTokens: undefined,
				cacheWriteTokens: undefined,
			},
		])
	})

	it("does not invent usage when no usage chunk arrives", async () => {
		mockFetch.mockResolvedValueOnce(streamResponse(null))
		const chunks = await collectStream(makeHandler().createMessage("", [{ role: "user", content: "Hello" }]))

		expect(chunks).toEqual([{ type: "text", text: "Hello" }])
	})

	it("reports usage once after refreshing an OAuth token on HTTP 401", async () => {
		mockFetch
			.mockResolvedValueOnce(Response.json({ error: { message: "Unauthorized" } }, { status: 401 }))
			.mockResolvedValueOnce(streamResponse())
		const handler = makeHandler({ kimiCodeAuthMethod: "oauth" })
		const chunks = await collectStream(handler.createMessage("", [{ role: "user", content: "Hello" }]))

		expect(chunks).toEqual([
			{ type: "text", text: "Hello" },
			{ type: "usage", inputTokens: 12, outputTokens: 7, cacheReadTokens: 4, cacheWriteTokens: undefined },
		])
		expect(mockForceRefreshAccessToken).toHaveBeenCalledOnce()
		expect(mockGetModels).toHaveBeenCalledOnce()
		expect(requests().map((request) => request.headers.get("authorization"))).toEqual([
			"Bearer oauth-token",
			"Bearer refreshed-token",
		])
	})
})
