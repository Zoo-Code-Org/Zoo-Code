import * as assert from "assert"

import { RooCodeEventName, providerIdentifiers, type ClineMessage } from "@roo-code/types"

import { setDefaultSuiteTimeout } from "../test-utils"
import { waitUntilCompleted } from "../utils"

// LM Studio streams Qwen3.x thinking as reasoning_content deltas on the
// OpenAI-compatible endpoint (verified against a live local LM Studio server),
// not as think tags inside content. Regression #1175 made LmStudioHandler
// forward those deltas as reasoning chunks. This suite proves the full path
// through the real extension host: real SSE wire format -> OpenAI SDK parsing
// -> provider reasoning extraction -> Task say("reasoning") -> webview message,
// which is exactly the boundary the provider unit tests (which mock the OpenAI
// client) do not exercise.
const LMSTUDIO_MODEL_ID = "qwen3.8-27b"
const PROMPT_TAG = "LMSTUDIO_E2E_THINK_BLOCK"
const REASONING_PROBE = "LMSTUDIO_E2E_REASONING_PROBE"
const EXPECTED_ANSWER = "Paris"

type CapturedLmStudioRequest = {
	model?: string
	lastUserMessage: string
}

/** Returns the URL string for a fetch request input (string, URL, or Request). */
function getRequestUrl(input: RequestInfo | URL): string {
	return typeof input === "string" ? input : input instanceof URL ? input.href : input.url
}

/** True if the raw URL parses and its origin equals the expected origin. */
function isUrlWithOrigin(rawUrl: string, expectedOrigin: string): boolean {
	try {
		return new URL(rawUrl).origin === expectedOrigin
	} catch {
		return false
	}
}

/** True if the raw URL points at an OpenAI-compatible /chat/completions endpoint. */
function isChatCompletionsUrl(rawUrl: string): boolean {
	try {
		return new URL(rawUrl).pathname.endsWith("/chat/completions")
	} catch {
		return false
	}
}

/**
 * Installs a global fetch capture that records the model and last user message of every
 * chat completions request sent to the given base URL. Returns a function that restores
 * the original fetch.
 */
function installLmStudioRequestCapture(capture: CapturedLmStudioRequest[], baseUrl: string): () => void {
	const originalFetch = globalThis.fetch
	const targetOrigin = new URL(baseUrl).origin

	globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const url = getRequestUrl(input)

		if (isUrlWithOrigin(url, targetOrigin) && isChatCompletionsUrl(url)) {
			const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : {}
			const messages = Array.isArray(body.messages) ? body.messages : []
			const lastUser = [...messages].reverse().find((message: { role?: string }) => message.role === "user")
			const lastUserMessage =
				typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "")

			capture.push({ model: body.model, lastUserMessage })
		}

		return originalFetch.call(globalThis, input, init)
	}

	return () => {
		globalThis.fetch = originalFetch
	}
}

suite("LM Studio provider", function () {
	setDefaultSuiteTimeout(this)

	// Only replay mode can serve the reasoning fixture: record mode has no
	// real LM Studio upstream to proxy to, and live runs have no aimock.
	// Computed once at suite scope so the suite hooks can be guarded as well:
	// a skipped suite must not touch shared fetch or provider configuration.
	const isReplay = !!process.env.AIMOCK_URL && process.env.AIMOCK_RECORD !== "true"

	let restoreFetch: (() => void) | undefined
	const requests: CapturedLmStudioRequest[] = []

	/** Skips the suite when aimock replay mode is not active (no fixture source). */
	setup(function () {
		if (!isReplay) {
			this.skip()
		}

		// Fresh per-test buffer: late requests from prior tasks must not satisfy
		// this test's assertions, which are scoped by PROMPT_TAG.
		requests.length = 0
	})

	/** Captures chat completions requests sent to the aimock origin for later assertions. */
	suiteSetup(() => {
		if (!isReplay) {
			return
		}

		restoreFetch = installLmStudioRequestCapture(requests, process.env.AIMOCK_URL!)
	})

	/** Restores the original fetch and the default OpenRouter provider configuration. */
	suiteTeardown(async () => {
		if (!isReplay) {
			return
		}

		restoreFetch?.()
		restoreFetch = undefined

		// Restore the default OpenRouter config so subsequent suites are unaffected.
		// Explicitly clear the LM Studio fields: setConfiguration only updates
		// supplied keys, so omitting them would leave them set for later suites.
		await globalThis.api.setConfiguration({
			apiProvider: providerIdentifiers.openrouter,
			lmStudioBaseUrl: undefined,
			lmStudioModelId: undefined,
			openRouterApiKey: "mock-key",
			openRouterModelId: "openai/gpt-4.1",
			openRouterBaseUrl: `${process.env.AIMOCK_URL}/v1`,
		})
	})

	/**
	 * Runs an ask-mode task against the aimock LM Studio fixture and asserts the reasoning
	 * stream surfaces as a separate finalized reasoning message ahead of the completion.
	 */
	test("should surface the LM Studio thinking stream as a separate reasoning message", async () => {
		const api = globalThis.api
		const aimockUrl = process.env.AIMOCK_URL!

		// LmStudioHandler appends /v1 itself, so the base URL is aimock's origin only.
		await api.setConfiguration({
			apiProvider: providerIdentifiers.lmstudio,
			lmStudioBaseUrl: aimockUrl,
			lmStudioModelId: LMSTUDIO_MODEL_ID,
		})

		const messages: ClineMessage[] = []
		const messageHandler = ({ message }: { message: ClineMessage }) => {
			if (message.type === "say" && message.partial === false) {
				messages.push(message)
			}
		}

		api.on(RooCodeEventName.Message, messageHandler)

		let taskId: string | undefined
		try {
			taskId = await api.startNewTask({
				configuration: { mode: "ask", autoApprovalEnabled: true, alwaysAllowModeSwitch: true },
				text: `${PROMPT_TAG}: What is the capital of France? Reply with only the city name.`,
			})

			await waitUntilCompleted({ api, taskId, timeout: 120_000 })
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}

		// The request must have gone to aimock carrying the LM Studio model id.
		const request = requests.find((entry) => entry.lastUserMessage.includes(PROMPT_TAG))
		assert.ok(
			request,
			`LM Studio provider should issue a chat completions request for the task prompt (saw ${requests.length} request(s))`,
		)
		assert.strictEqual(request.model, LMSTUDIO_MODEL_ID)

		// The thinking stream must surface as a finalized reasoning message.
		const reasoningMessages = messages.filter((message) => message.say === "reasoning")
		assert.ok(
			reasoningMessages.length > 0,
			`Task should surface the LM Studio thinking stream as a reasoning message. Observed says: ${messages
				.map((message) => message.say)
				.join(", ")}`,
		)

		const reasoningText = reasoningMessages.map((message) => message.text ?? "").join("")
		assert.ok(
			reasoningText.includes(REASONING_PROBE),
			`Reasoning message should contain the streamed thinking text. Got: ${reasoningText.slice(0, 300)}`,
		)

		// The visible answer must be the plain completion result.
		const completionMessage = messages.find(
			({ say, text }) => (say === "completion_result" || say === "text") && text?.trim() === EXPECTED_ANSWER,
		)
		assert.ok(
			completionMessage,
			`Task should complete with the expected answer "${EXPECTED_ANSWER}". Observed: ${messages
				.map((message) => `${message.say}:${message.text?.slice(0, 80)}`)
				.join(" | ")}`,
		)

		// Channel separation: thinking must not leak into the visible answer,
		// and the final answer must not appear inside the reasoning message.
		const visibleText = messages
			.filter(({ say }) => say === "completion_result" || say === "text")
			.map((message) => message.text ?? "")
			.join("")
		assert.ok(!visibleText.includes(REASONING_PROBE), "Thinking text must not leak into the visible answer")
		assert.ok(!reasoningText.includes(EXPECTED_ANSWER), "Final answer must not appear inside the reasoning message")

		// Thinking streams before the answer.
		const reasoningIndex = messages.findIndex((message) => message.say === "reasoning")
		const completionIndex = messages.findIndex(
			({ say, text }) => (say === "completion_result" || say === "text") && text?.trim() === EXPECTED_ANSWER,
		)
		assert.ok(
			reasoningIndex !== -1 && completionIndex !== -1 && reasoningIndex < completionIndex,
			"Reasoning message should precede the completion message",
		)
	})
})
