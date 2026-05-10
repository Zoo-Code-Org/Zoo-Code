import * as assert from "assert"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { waitUntilCompleted } from "./utils"
import { setDefaultSuiteTimeout } from "./test-utils"

suite("Claude Opus 4.7 (Anthropic)", function () {
	setDefaultSuiteTimeout(this)

	// Restore OpenRouter default config after this suite so other tests are unaffected.
	suiteTeardown(async () => {
		const aimockUrl = process.env.AIMOCK_URL
		const isRecord = process.env.AIMOCK_RECORD === "true"
		await globalThis.api.setConfiguration({
			apiProvider: "openrouter" as const,
			openRouterApiKey: aimockUrl && !isRecord ? "mock-key" : process.env.OPENROUTER_API_KEY!,
			openRouterModelId: "openai/gpt-4.1",
			...(aimockUrl && { openRouterBaseUrl: `${aimockUrl}/v1` }),
		})
	})

	test("Should complete a task end-to-end using claude-opus-4-7 via Anthropic provider", async function () {
		const api = globalThis.api
		const aimockUrl = process.env.AIMOCK_URL
		const isRecord = process.env.AIMOCK_RECORD === "true"

		if (!aimockUrl && !process.env.ANTHROPIC_API_KEY) {
			this.skip()
		}

		// aimock handles /v1/messages natively and serves Anthropic-format SSE responses.
		// In record mode the real x-api-key is forwarded so aimock can proxy to api.anthropic.com.
		await api.setConfiguration({
			apiProvider: "anthropic" as const,
			apiKey: aimockUrl && !isRecord ? "mock-key" : process.env.ANTHROPIC_API_KEY!,
			apiModelId: "claude-opus-4-7",
			...(aimockUrl && { anthropicBaseUrl: aimockUrl }),
		})

		const messages: ClineMessage[] = []

		api.on(RooCodeEventName.Message, ({ message }) => {
			if (message.type === "say" && message.partial === false) {
				messages.push(message)
			}
		})

		const taskId = await api.startNewTask({
			configuration: { mode: "ask", alwaysAllowModeSwitch: true, autoApprovalEnabled: true },
			text: "opus47-e2e: what is 2+2? Reply with only the number.",
		})

		await waitUntilCompleted({ api, taskId })

		const completionMessage = messages.find(
			({ say, text }) => (say === "completion_result" || say === "text") && text?.trim() === "4",
		)

		assert.ok(completionMessage, "Task should complete with the expected Claude Opus 4.7 response")
	})
})
