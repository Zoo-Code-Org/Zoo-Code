import * as assert from "assert"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { waitUntilCompleted } from "../utils"
import { setDefaultSuiteTimeout } from "../test-utils"

// ---------------------------------------------------------------------------
// Fetch interceptor
//
// The OpenAI SDK resolves `fetch` at client construction time
// (this.fetch = options.fetch ?? getDefaultFetch()).  Patching globalThis.fetch
// before setConfiguration() ensures any ZAiHandler created for this suite
// captures our interceptor.  When ZAI_API_KEY is set the interceptor runs in
// passthrough mode — it captures max_tokens from the request then forwards to
// the real API, so the max_tokens assertion always runs in both modes.
// ---------------------------------------------------------------------------

type ZAiFixture = { match: string; result: string }
type ZAiRequestCapture = { maxTokens?: number }

function getBaseZAiConfiguration() {
	return {
		apiProvider: "zai" as const,
		zaiApiKey: ZAI_API_KEY ?? "mock-key",
		zaiApiLine: "international_api" as const,
		modelMaxTokens: undefined,
		modelMaxThinkingTokens: undefined,
	}
}

function installZAiFetchInterceptor(
	fixtures: ZAiFixture[],
	capture?: ZAiRequestCapture,
	passthrough?: boolean,
): () => void {
	const original = globalThis.fetch

	globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url

		if (url.includes("api.z.ai")) {
			const body = init?.body
				? (JSON.parse(init.body as string) as {
						messages?: Array<{ role: string; content: unknown }>
						max_tokens?: number
					})
				: {}

			if (capture) {
				capture.maxTokens = body.max_tokens
			}

			if (passthrough) {
				return original.call(globalThis, input, init as RequestInit)
			}

			const messages = body.messages ?? []
			const lastUser = [...messages].reverse().find((m) => m.role === "user")
			const text =
				typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "")

			const fixture = fixtures.find((f) => text.includes(f.match))
			if (!fixture) {
				throw new Error(`Z.ai fetch interceptor: no fixture matched. Last user message: ${text.slice(0, 200)}`)
			}

			return makeZAiSSEResponse(fixture.result)
		}

		return original.call(globalThis, input, init as RequestInit)
	} as typeof globalThis.fetch

	return () => {
		globalThis.fetch = original
	}
}

function makeZAiSSEResponse(result: string): Response {
	const enc = new TextEncoder()
	const args = JSON.stringify({ result })
	const id = "mock-zai-001"
	const model = "glm-5.1"

	const chunks = [
		{
			id,
			object: "chat.completion.chunk",
			model,
			choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }],
		},
		{
			id,
			object: "chat.completion.chunk",
			model,
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{
								index: 0,
								id: "call_zai_001",
								type: "function",
								function: { name: "attempt_completion", arguments: "" },
							},
						],
					},
					finish_reason: null,
				},
			],
		},
		{
			id,
			object: "chat.completion.chunk",
			model,
			choices: [
				{
					index: 0,
					delta: { tool_calls: [{ index: 0, function: { arguments: args } }] },
					finish_reason: null,
				},
			],
		},
		{
			id,
			object: "chat.completion.chunk",
			model,
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
		},
	]

	let i = 0
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i < chunks.length) {
				controller.enqueue(enc.encode(`data: ${JSON.stringify(chunks[i++])}\n\n`))
			} else {
				controller.enqueue(enc.encode("data: [DONE]\n\n"))
				controller.close()
			}
		},
	})

	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
	})
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const ZAI_API_KEY = process.env.ZAI_API_KEY

suite("Z.ai GLM provider", function () {
	setDefaultSuiteTimeout(this)

	let restoreFetch: (() => void) | undefined
	const requestCapture: ZAiRequestCapture = {}

	setup(() => {
		requestCapture.maxTokens = undefined
	})

	suiteSetup(async () => {
		restoreFetch = installZAiFetchInterceptor(
			[
				{ match: "zai-glm-e2e:", result: "4" },
				{ match: "zai-glm-5-turbo-e2e:", result: "4" },
			],
			requestCapture,
			!!ZAI_API_KEY,
		)

		await globalThis.api.upsertProfile(
			"default",
			{
				...getBaseZAiConfiguration(),
				apiModelId: "glm-5.1",
			},
			true,
		)
	})

	suiteTeardown(async () => {
		restoreFetch?.()
		restoreFetch = undefined

		const aimockUrl = process.env.AIMOCK_URL
		const isRecord = process.env.AIMOCK_RECORD === "true"
		await globalThis.api.upsertProfile(
			"default",
			{
				apiProvider: "openrouter" as const,
				openRouterApiKey: aimockUrl && !isRecord ? "mock-key" : process.env.OPENROUTER_API_KEY!,
				openRouterModelId: "openai/gpt-4.1",
				...(aimockUrl && { openRouterBaseUrl: `${aimockUrl}/v1` }),
			},
			true,
		)
	})

	test("Should complete a task end-to-end using glm-5.1 via Z.ai provider", async () => {
		const api = globalThis.api
		const messages: ClineMessage[] = []

		api.on(RooCodeEventName.Message, ({ message }) => {
			if (message.type === "say" && message.partial === false) {
				messages.push(message)
			}
		})

		const taskId = await api.startNewTask({
			configuration: { mode: "ask", alwaysAllowModeSwitch: true, autoApprovalEnabled: true },
			text: "zai-glm-e2e: what is 2+2? Reply with only the number.",
		})

		await waitUntilCompleted({ api, taskId })

		const completionMessage = messages.find(
			({ say, text }) => (say === "completion_result" || say === "text") && text?.trim() === "4",
		)

		assert.ok(completionMessage, "Task should complete with the expected Z.ai GLM response")

		// Verify max_tokens uses the restored default clamp (20% of context window)
		// unless the user explicitly overrides it via modelMaxTokens.
		assert.strictEqual(
			requestCapture.maxTokens,
			40_000,
			`max_tokens should default to the glm-5.1 clamp (40_000) but was ${requestCapture.maxTokens}`,
		)
	})

	test("Should complete a task end-to-end using glm-5-turbo via Z.ai provider", async () => {
		await globalThis.api.upsertProfile(
			"default",
			{
				...getBaseZAiConfiguration(),
				apiModelId: "glm-5-turbo",
			},
			true,
		)

		const api = globalThis.api
		const messages: ClineMessage[] = []

		api.on(RooCodeEventName.Message, ({ message }) => {
			if (message.type === "say" && message.partial === false) {
				messages.push(message)
			}
		})

		const taskId = await api.startNewTask({
			configuration: { mode: "ask", alwaysAllowModeSwitch: true, autoApprovalEnabled: true },
			text: "zai-glm-5-turbo-e2e: what is 2+2? Reply with only the number.",
		})

		await waitUntilCompleted({ api, taskId })

		const completionMessage = messages.find(
			({ say, text }) => (say === "completion_result" || say === "text") && text?.trim() === "4",
		)

		assert.ok(completionMessage, "Task should complete with the expected Z.ai GLM-5-Turbo response")

		// Verify max_tokens uses the restored default clamp (20% of context window)
		// unless the user explicitly overrides it via modelMaxTokens.
		assert.strictEqual(
			requestCapture.maxTokens,
			40_551,
			`max_tokens should default to the glm-5-turbo clamp (40_551) but was ${requestCapture.maxTokens}`,
		)
	})
})
