import { providerIdentifiers, RooCodeEventName, type ClineMessage } from "@roo-code/types"
import * as assert from "assert"

import { setDefaultSuiteTimeout } from "./test-utils"
import { isCompletedAsk, waitFor } from "./utils"

const PROBE = "mid-stream-retry-e2e:"

function installMidStreamFailureInterceptor(requests: { count: number }): () => void {
	const originalFetch = globalThis.fetch

	globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const body = typeof init?.body === "string" ? init.body : ""
		if (body.includes(PROBE)) {
			requests.count++
			return makePartialFailureResponse()
		}
		return originalFetch.call(globalThis, input, init as RequestInit)
	} as typeof globalThis.fetch

	return () => {
		globalThis.fetch = originalFetch
	}
}

function makePartialFailureResponse(): Response {
	const encoder = new TextEncoder()
	let emitted = false
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (!emitted) {
				emitted = true
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({
							id: "mid-stream-failure",
							object: "chat.completion.chunk",
							model: "openai/gpt-4.1",
							choices: [
								{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null },
							],
						})}\n\n`,
					),
				)
				return
			}
			controller.error(new Error("mid-stream provider failure"))
		},
	})

	return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
}

suite("Mid-stream retry", function () {
	setDefaultSuiteTimeout(this)

	let restoreFetch: (() => void) | undefined
	const requests = { count: 0 }

	suiteSetup(async () => {
		restoreFetch = installMidStreamFailureInterceptor(requests)
		const aimockUrl = process.env.AIMOCK_URL
		await globalThis.api.setConfiguration({
			apiProvider: providerIdentifiers.openrouter,
			openRouterApiKey: "mock-key",
			openRouterModelId: "openai/gpt-4.1",
			requestDelaySeconds: 1,
			...(aimockUrl && { openRouterBaseUrl: `${aimockUrl}/v1` }),
		})
	})

	suiteTeardown(async () => {
		restoreFetch?.()
		restoreFetch = undefined
		await globalThis.api.clearCurrentTask()
	})

	test("bounds partial-stream retries and surfaces the failure prompt", async () => {
		requests.count = 0
		const messages: ClineMessage[] = []
		const handler = ({ message }: { message: ClineMessage }) => messages.push(message)
		globalThis.api.on(RooCodeEventName.Message, handler)

		try {
			await globalThis.api.startNewTask({
				configuration: { mode: "ask", autoApprovalEnabled: false },
				text: `${PROBE} fail after a partial provider response`,
			})

			await waitFor(
				() => messages.some((message) => isCompletedAsk(message) && message.ask === "api_req_failed"),
				{ timeout: 60_000 },
			)
			assert.strictEqual(requests.count, 4, "Should make one initial request and three automatic retries")
			assert.ok(
				messages.some((message) => message.type === "say" && message.say === "api_req_retry_delayed"),
				"Should expose automatic retry backoff to the user",
			)

			await new Promise((resolve) => setTimeout(resolve, 250))
			assert.strictEqual(requests.count, 4, "Waiting at the retry prompt must not issue another billed request")
		} finally {
			globalThis.api.off(RooCodeEventName.Message, handler)
		}
	})
})
