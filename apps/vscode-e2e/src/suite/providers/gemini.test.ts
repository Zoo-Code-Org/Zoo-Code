import * as assert from "assert"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { setDefaultSuiteTimeout } from "../test-utils"
import { waitUntilCompleted } from "../utils"

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
const GEMINI_MODEL_ID = "gemini-3.1-pro-preview"

type CapturedGeminiRequest = {
	model?: string
	lastUserMessage: string
	thinkingConfig?: Record<string, unknown>
	hasTools: boolean
	toolDeclarationCount: number
}

function getRequestUrl(input: RequestInfo | URL): string {
	return typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
}

function isUrlWithOrigin(rawUrl: string, expectedOrigin: string): boolean {
	try {
		return new URL(rawUrl).origin === expectedOrigin
	} catch {
		return false
	}
}

function isGeminiGenerateContentUrl(rawUrl: string): boolean {
	try {
		const pathname = new URL(rawUrl).pathname
		return pathname.includes(":streamGenerateContent") || pathname.includes(":generateContent")
	} catch {
		return false
	}
}

function extractGeminiModel(rawUrl: string): string | undefined {
	try {
		const pathname = new URL(rawUrl).pathname
		const match = pathname.match(/\/models\/([^:]+):(streamGenerateContent|generateContent)$/)
		return match?.[1]
	} catch {
		return undefined
	}
}

function extractLastUserMessage(
	contents?: Array<{
		role?: string
		parts?: Array<{ text?: string }>
	}>,
): string {
	const lastUser = [...(contents ?? [])].reverse().find((content) => content.role === "user")

	if (!lastUser?.parts) {
		return ""
	}

	return lastUser.parts
		.map((part) => (typeof part?.text === "string" ? part.text : JSON.stringify(part ?? "")))
		.join("")
}

function installGeminiRequestCapture(capture: CapturedGeminiRequest[], baseUrl: string): () => void {
	const originalFetch = globalThis.fetch
	const targetOrigin = new URL(baseUrl).origin

	globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const url = getRequestUrl(input)

		if (isUrlWithOrigin(url, targetOrigin) && isGeminiGenerateContentUrl(url)) {
			const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : {}
			const tools = Array.isArray(body.tools) ? body.tools : []
			const toolDeclarationCount = tools.reduce((count: number, tool: { functionDeclarations?: unknown[] }) => {
				return count + (Array.isArray(tool.functionDeclarations) ? tool.functionDeclarations.length : 0)
			}, 0)

			capture.push({
				model: extractGeminiModel(url),
				lastUserMessage: extractLastUserMessage(body.contents),
				thinkingConfig:
					body.generationConfig && typeof body.generationConfig === "object"
						? (body.generationConfig.thinkingConfig as Record<string, unknown> | undefined)
						: undefined,
				hasTools: tools.length > 0,
				toolDeclarationCount,
			})
		}

		return originalFetch.call(globalThis, input, init as RequestInit)
	} as typeof globalThis.fetch

	return () => {
		globalThis.fetch = originalFetch
	}
}

suite("Gemini provider", function () {
	setDefaultSuiteTimeout(this)

	let restoreFetch: (() => void) | undefined
	const requests: CapturedGeminiRequest[] = []

	setup(function () {
		if (!process.env.AIMOCK_URL && !GEMINI_API_KEY) {
			this.skip()
		}
	})

	suiteSetup(() => {
		restoreFetch = installGeminiRequestCapture(
			requests,
			process.env.AIMOCK_URL || "https://generativelanguage.googleapis.com",
		)
	})

	suiteTeardown(async () => {
		restoreFetch?.()
		restoreFetch = undefined

		const aimockUrl = process.env.AIMOCK_URL
		const isRecord = process.env.AIMOCK_RECORD === "true"
		await globalThis.api.setConfiguration({
			apiProvider: "openrouter" as const,
			openRouterApiKey: aimockUrl && !isRecord ? "mock-key" : process.env.OPENROUTER_API_KEY!,
			openRouterModelId: "openai/gpt-4.1",
			...(aimockUrl && { openRouterBaseUrl: `${aimockUrl}/v1` }),
		})
	})

	for (const reasoningEnabled of [true, false] as const) {
		test(`Should complete a task end-to-end using ${GEMINI_MODEL_ID} via Gemini provider with reasoning ${
			reasoningEnabled ? "enabled" : "disabled"
		}`, async () => {
			requests.length = 0

			const api = globalThis.api
			const aimockUrl = process.env.AIMOCK_URL
			const isRecord = process.env.AIMOCK_RECORD === "true"
			const promptTag = reasoningEnabled ? "gemini-e2e:reasoning-on" : "gemini-e2e:reasoning-off"

			await api.setConfiguration({
				apiProvider: "gemini" as const,
				geminiApiKey: aimockUrl && !isRecord ? "mock-key" : GEMINI_API_KEY!,
				apiModelId: GEMINI_MODEL_ID,
				enableReasoningEffort: reasoningEnabled,
				reasoningEffort: reasoningEnabled ? ("high" as const) : ("disable" as const),
				...(aimockUrl && { googleGeminiBaseUrl: aimockUrl }),
			})

			const messages: ClineMessage[] = []
			const messageHandler = ({ message }: { message: ClineMessage }) => {
				if (message.type === "say" && message.partial === false) {
					messages.push(message)
				}
			}

			api.on(RooCodeEventName.Message, messageHandler)

			try {
				const taskId = await api.startNewTask({
					configuration: { mode: "ask", alwaysAllowModeSwitch: true, autoApprovalEnabled: true },
					text: `${promptTag}: what is 2+2? Reply with only the number.`,
				})

				await waitUntilCompleted({ api, taskId })
			} finally {
				api.off(RooCodeEventName.Message, messageHandler)
			}

			const firstRequest = requests.find((request) => request.lastUserMessage.includes(promptTag))
			assert.ok(firstRequest, "Gemini provider should issue a generate content request for the task prompt")
			assert.strictEqual(firstRequest.model, GEMINI_MODEL_ID)
			assert.ok(firstRequest.hasTools, "Gemini provider should include tool declarations in the request")
			assert.ok(
				firstRequest.toolDeclarationCount > 0,
				"Gemini provider should declare at least one callable tool",
			)

			if (reasoningEnabled) {
				assert.ok(
					firstRequest.thinkingConfig,
					"Reasoning-enabled Gemini requests should include thinkingConfig",
				)
			} else {
				assert.strictEqual(
					firstRequest.thinkingConfig,
					undefined,
					"Reasoning-disabled Gemini requests should omit thinkingConfig",
				)
			}

			const completionMessage = messages.find(
				({ say, text }) => (say === "completion_result" || say === "text") && text?.trim() === "4",
			)

			assert.ok(completionMessage, "Task should complete with the expected Gemini provider response")
		})
	}
})
