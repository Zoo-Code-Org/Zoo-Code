import * as assert from "assert"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { setDefaultSuiteTimeout } from "../test-utils"
import { waitUntilCompleted } from "../utils"

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
const GEMINI_MODEL_ID = process.env.GEMINI_MODEL_ID ?? "gemini-3-flash-preview"

type FunctionDeclaration = {
	name: string
	parametersJsonSchema?: Record<string, unknown>
}

type GeminiToolConfig = {
	functionCallingConfig?: {
		mode?: string
		allowedFunctionNames?: string[]
	}
}

type CapturedGeminiRequest = {
	model?: string
	lastUserMessage: string
	thinkingConfig?: Record<string, unknown>
	toolConfig?: GeminiToolConfig
	hasTools: boolean
	toolDeclarationCount: number
	functionDeclarations: FunctionDeclaration[]
}

function findInvalidSchemaPatterns(schema: unknown, path = ""): string[] {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		return []
	}

	const obj = schema as Record<string, unknown>
	const violations: string[] = []

	if ("additionalProperties" in obj) {
		violations.push(`${path}.additionalProperties (stripped for Gemini compatibility)`)
	}

	if ("default" in obj) {
		violations.push(`${path}.default (stripped for Gemini compatibility)`)
	}

	if ("$schema" in obj) {
		violations.push(`${path}.$schema (JSON Schema metadata stripped for Gemini compatibility)`)
	}

	if ("type" in obj && Array.isArray(obj.type)) {
		violations.push(`${path}.type is an array ${JSON.stringify(obj.type)} (Gemini requires a single string type)`)
	}

	for (const [key, value] of Object.entries(obj)) {
		if (key === "properties" && value && typeof value === "object") {
			for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
				violations.push(...findInvalidSchemaPatterns(propSchema, `${path}.properties.${propName}`))
			}
		} else if (key === "items") {
			violations.push(...findInvalidSchemaPatterns(value, `${path}.items`))
		} else if (key === "anyOf" || key === "oneOf" || key === "allOf") {
			violations.push(`${path}.${key} (collapsed for Gemini compatibility)`)
			if (Array.isArray(value)) {
				value.forEach((item, i) => violations.push(...findInvalidSchemaPatterns(item, `${path}.${key}[${i}]`)))
			}
		}
	}

	return violations
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
			const functionDeclarations: FunctionDeclaration[] = tools.flatMap(
				(tool: { functionDeclarations?: FunctionDeclaration[] }) =>
					Array.isArray(tool.functionDeclarations) ? tool.functionDeclarations : [],
			)

			capture.push({
				model: extractGeminiModel(url),
				lastUserMessage: extractLastUserMessage(body.contents),
				thinkingConfig:
					body.generationConfig && typeof body.generationConfig === "object"
						? (body.generationConfig.thinkingConfig as Record<string, unknown> | undefined)
						: undefined,
				toolConfig:
					body.toolConfig && typeof body.toolConfig === "object"
						? (body.toolConfig as GeminiToolConfig)
						: undefined,
				hasTools: tools.length > 0,
				toolDeclarationCount: functionDeclarations.length,
				functionDeclarations,
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
		const aimockUrl = process.env.AIMOCK_URL
		const isReplay = aimockUrl && process.env.AIMOCK_RECORD !== "true"
		const isRecordRun = aimockUrl && process.env.AIMOCK_RECORD === "true" && !!GEMINI_API_KEY
		// Live runs without aimock are not supported — GEMINI_MODEL_ID must match the fixture.
		if (!isReplay && !isRecordRun) {
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

	for (const reasoningEffort of ["high", "low", "disable"] as const) {
		test(`Should complete a task end-to-end using ${GEMINI_MODEL_ID} via Gemini provider with reasoning effort "${reasoningEffort}"`, async () => {
			requests.length = 0

			const api = globalThis.api
			const aimockUrl = process.env.AIMOCK_URL
			const isRecord = process.env.AIMOCK_RECORD === "true"
			const promptTag = `gemini-e2e:reasoning-${reasoningEffort}`

			await api.setConfiguration({
				apiProvider: "gemini" as const,
				geminiApiKey: aimockUrl && !isRecord ? "mock-key" : GEMINI_API_KEY!,
				apiModelId: GEMINI_MODEL_ID,
				enableReasoningEffort: reasoningEffort !== "disable",
				reasoningEffort: reasoningEffort,
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
			assert.strictEqual(
				firstRequest.toolConfig?.functionCallingConfig?.allowedFunctionNames,
				undefined,
				"Gemini requests should not send allowedFunctionNames; the Gemini backend returns generic INVALID_ARGUMENT for larger or history-incompatible restriction lists",
			)

			// Verify tool schemas are sanitized for Gemini compatibility. Gemini documents
			// function declaration schemas as a selected OpenAPI-style subset with
			// single-value `type` plus `nullable`; live testing also showed opaque
			// INVALID_ARGUMENT failures from broader third-party MCP schema metadata.
			for (const decl of firstRequest.functionDeclarations) {
				const violations = findInvalidSchemaPatterns(
					decl.parametersJsonSchema,
					`${decl.name}.parametersJsonSchema`,
				)
				assert.strictEqual(
					violations.length,
					0,
					`Tool "${decl.name}" has Gemini-incompatible schema: ${violations.join("; ")}`,
				)
			}

			if (reasoningEffort === "disable") {
				assert.strictEqual(
					firstRequest.thinkingConfig,
					undefined,
					"Reasoning-disabled Gemini requests should omit thinkingConfig",
				)
			} else {
				assert.ok(
					firstRequest.thinkingConfig,
					`Gemini requests with reasoningEffort="${reasoningEffort}" should include thinkingConfig`,
				)
			}

			const completionMessage = messages.find(
				({ say, text }) => (say === "completion_result" || say === "text") && text?.trim() === "4",
			)

			assert.ok(completionMessage, "Task should complete with the expected Gemini provider response")
		})
	}
})
