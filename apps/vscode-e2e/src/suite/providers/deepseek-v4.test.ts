import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { setDefaultSuiteTimeout } from "../test-utils"
import { sleep, waitFor, waitUntilAborted } from "../utils"

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY

type DeepSeekModelId = "deepseek-v4-flash" | "deepseek-v4-pro"

type CapturedDeepSeekRequest = {
	model?: string
	thinkingType?: "enabled" | "disabled"
	reasoningEffort?: string
	maxCompletionTokens?: number
	probeTag?: string
	lastUserMessage: string
}

type DeepSeekProbeResult = {
	completed: boolean
	aborted: boolean
	noToolErrors: number
	mistakeLimitReached: boolean
	completionText?: string
	requests: CapturedDeepSeekRequest[]
	transcript: string[]
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

function isChatCompletionsUrl(rawUrl: string): boolean {
	try {
		return new URL(rawUrl).pathname.endsWith("/chat/completions")
	} catch {
		return false
	}
}

function getRequestBody(init?: RequestInit):
	| {
			model?: string
			thinking?: { type?: "enabled" | "disabled" }
			reasoning_effort?: string
			max_completion_tokens?: number
			messages?: Array<{ role?: string; content?: unknown }>
	  }
	| undefined {
	if (!init?.body || typeof init.body !== "string") {
		return undefined
	}

	return JSON.parse(init.body)
}

function installDeepSeekRequestCapture(capture: CapturedDeepSeekRequest[], baseUrl: string): () => void {
	const originalFetch = globalThis.fetch
	const targetOrigin = new URL(baseUrl).origin

	globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const url = getRequestUrl(input)

		if (isUrlWithOrigin(url, targetOrigin) && isChatCompletionsUrl(url)) {
			const body = getRequestBody(init) ?? {}

			const lastUser = [...(body.messages ?? [])].reverse().find((message) => message.role === "user")
			const lastUserMessage =
				typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "")
			const allMessagesText = JSON.stringify(body.messages ?? [])
			const probeTag = allMessagesText.match(/deepseek-v4-e2e:[^"\s]+/)?.[0]

			const request = {
				model: body.model,
				thinkingType: body.thinking?.type,
				reasoningEffort: body.reasoning_effort,
				maxCompletionTokens: body.max_completion_tokens,
				probeTag,
				lastUserMessage,
			} satisfies CapturedDeepSeekRequest

			capture.push(request)
		}

		return originalFetch.call(globalThis, input, init as RequestInit)
	} as typeof globalThis.fetch

	return () => {
		globalThis.fetch = originalFetch
	}
}

function deepSeekFileName(modelId: DeepSeekModelId, reasoningEnabled: boolean): string {
	return `deepseek-v4-e2e-${modelId}-${reasoningEnabled ? "reasoning-on" : "reasoning-off"}.txt`
}

function deepSeekProbeTag(modelId: DeepSeekModelId, reasoningEnabled: boolean): string {
	return `deepseek-v4-e2e:${modelId}:${reasoningEnabled ? "reasoning-on" : "reasoning-off"}`
}

function deepSeekMarker(modelId: DeepSeekModelId, reasoningEnabled: boolean): string {
	return `DEEPSEEK_V4_MARKER_${modelId.replaceAll("-", "_")}_${reasoningEnabled ? "reasoning_on" : "reasoning_off"}`
}

function formatDiagnostics(result: DeepSeekProbeResult) {
	const requestSummary = result.requests
		.map((request, index) => {
			const summary = {
				model: request.model,
				thinkingType: request.thinkingType,
				reasoningEffort: request.reasoningEffort,
				maxCompletionTokens: request.maxCompletionTokens,
				probeTag: request.probeTag,
				lastUserMessage: request.lastUserMessage.slice(0, 160),
			}

			return `request[${index}]=${JSON.stringify(summary)}`
		})
		.join("\n")

	return [
		`completed=${result.completed}`,
		`aborted=${result.aborted}`,
		`noToolErrors=${result.noToolErrors}`,
		`mistakeLimitReached=${result.mistakeLimitReached}`,
		`completionText=${JSON.stringify(result.completionText)}`,
		requestSummary || "requestSummary=<none>",
		"transcript:",
		...result.transcript.map((line) => `  ${line}`),
	].join("\n")
}

async function runDeepSeekToolProbe(
	modelId: DeepSeekModelId,
	reasoningEnabled: boolean,
	requests: CapturedDeepSeekRequest[],
): Promise<{ result: DeepSeekProbeResult; marker: string }> {
	const api = globalThis.api
	const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath

	if (!workspaceDir) {
		throw new Error("No workspace folder found for DeepSeek E2E probe")
	}

	requests.length = 0

	const marker = deepSeekMarker(modelId, reasoningEnabled)
	const fileName = deepSeekFileName(modelId, reasoningEnabled)
	const probeTag = deepSeekProbeTag(modelId, reasoningEnabled)
	const filePath = path.join(workspaceDir, fileName)
	const aimockUrl = process.env.AIMOCK_URL
	const isRecord = process.env.AIMOCK_RECORD === "true"

	await fs.writeFile(filePath, `${marker}\n`, "utf8")

	const transcript: string[] = []
	let noToolErrors = 0
	let mistakeLimitReached = false
	let completionText: string | undefined
	let taskCompleted = false
	let taskAborted = false

	const messageHandler = ({ message }: { message: ClineMessage }) => {
		if (message.type === "say" && message.partial === false) {
			transcript.push(`${message.say}: ${message.text?.slice(0, 220) ?? ""}`)

			if (message.say === "error" && message.text === "MODEL_NO_TOOLS_USED") {
				noToolErrors++
			}

			if ((message.say === "completion_result" || message.say === "text") && message.text?.trim()) {
				completionText = message.text.trim()
			}
		}

		if (message.type === "ask") {
			transcript.push(`${message.ask}: ${message.text?.slice(0, 220) ?? ""}`)

			if (message.ask === "mistake_limit_reached") {
				mistakeLimitReached = true
			}
		}
	}

	api.on(RooCodeEventName.Message, messageHandler)
	let taskId: string | undefined

	try {
		await api.setConfiguration({
			apiProvider: "deepseek" as const,
			deepSeekApiKey: aimockUrl && !isRecord ? "mock-key" : DEEPSEEK_API_KEY!,
			...(aimockUrl && { deepSeekBaseUrl: `${aimockUrl}/v1` }),
			apiModelId: modelId,
			enableReasoningEffort: reasoningEnabled,
			reasoningEffort: reasoningEnabled ? ("high" as const) : ("disable" as const),
		})

		taskId = await api.startNewTask({
			configuration: {
				mode: "code",
				autoApprovalEnabled: true,
				alwaysAllowReadOnly: true,
				alwaysAllowReadOnlyOutsideWorkspace: true,
				alwaysAllowExecute: false,
				disabledTools: ["execute_command", "read_command_output"],
			},
			text:
				`${probeTag} ` +
				`Use only the read_file tool to read "${fileName}" from the current workspace. ` +
				`Do not run shell commands, search commands, or terminal commands. ` +
				`Then reply with only the exact marker from that file. Do not guess, and do not add any extra text.`,
		})

		const taskCompletedHandler = (completedTaskId: string) => {
			if (completedTaskId === taskId) {
				taskCompleted = true
			}
		}

		const taskAbortedHandler = (abortedTaskId: string) => {
			if (abortedTaskId === taskId) {
				taskAborted = true
			}
		}

		api.on(RooCodeEventName.TaskCompleted, taskCompletedHandler)
		api.on(RooCodeEventName.TaskAborted, taskAbortedHandler)

		try {
			await waitFor(() => taskCompleted || taskAborted || mistakeLimitReached, {
				timeout: 180_000,
				interval: 500,
			})

			if (mistakeLimitReached && !taskCompleted && !taskAborted) {
				await api.cancelCurrentTask()
				await waitUntilAborted({ api, taskId, timeout: 15_000 })
				taskAborted = true
			}
		} catch (error) {
			if (taskId && !taskCompleted && !taskAborted && !mistakeLimitReached) {
				try {
					await api.cancelCurrentTask()
					await waitUntilAborted({ api, taskId, timeout: 15_000 })
					taskAborted = true
				} catch {
					// Best effort only; keep the original timeout failure.
				}
			}

			throw error
		} finally {
			api.off(RooCodeEventName.TaskCompleted, taskCompletedHandler)
			api.off(RooCodeEventName.TaskAborted, taskAbortedHandler)
		}

		return {
			marker,
			result: {
				completed: taskCompleted,
				aborted: taskAborted,
				noToolErrors,
				mistakeLimitReached,
				completionText,
				requests: requests.filter(
					(request) => request.model === modelId && (!request.probeTag || request.probeTag === probeTag),
				),
				transcript,
			},
		}
	} finally {
		api.off(RooCodeEventName.Message, messageHandler)

		if (taskId && !taskCompleted && !taskAborted) {
			try {
				await api.cancelCurrentTask()
				await waitUntilAborted({ api, taskId, timeout: 15_000 })
			} catch {
				// Task may already be finished or absent.
			}
		}

		await sleep(1_500)
		await fs.rm(filePath, { force: true })
	}
}

suite("DeepSeek V4 provider", function () {
	setDefaultSuiteTimeout(this)
	this.timeout(8 * 60_000)

	let restoreFetch: (() => void) | undefined
	const requests: CapturedDeepSeekRequest[] = []

	setup(function () {
		if (!process.env.AIMOCK_URL && !DEEPSEEK_API_KEY) {
			this.skip()
		}
	})

	suiteSetup(() => {
		restoreFetch = installDeepSeekRequestCapture(
			requests,
			process.env.AIMOCK_URL ? `${process.env.AIMOCK_URL}/v1` : "https://api.deepseek.com",
		)
	})

	suiteTeardown(async () => {
		restoreFetch?.()
		restoreFetch = undefined

		const aimockUrl = process.env.AIMOCK_URL
		const isRecord = process.env.AIMOCK_RECORD === "true"
		await globalThis.api.setConfiguration({
			apiProvider: "openrouter" as const,
			openRouterApiKey: aimockUrl
				? isRecord
					? (process.env.OPENROUTER_API_KEY ?? "mock-key")
					: "mock-key"
				: process.env.OPENROUTER_API_KEY!,
			openRouterModelId: "openai/gpt-4.1",
			...(aimockUrl && { openRouterBaseUrl: `${aimockUrl}/v1` }),
		})
	})

	for (const [modelId, reasoningEnabled] of [
		["deepseek-v4-flash", true],
		["deepseek-v4-flash", false],
		["deepseek-v4-pro", true],
		["deepseek-v4-pro", false],
	] as const) {
		test(`${modelId} should complete a tool-using task with reasoning ${reasoningEnabled ? "enabled" : "disabled"}`, async () => {
			const { result, marker } = await runDeepSeekToolProbe(modelId, reasoningEnabled, requests)
			const diagnostics = formatDiagnostics(result)
			const firstRequest = result.requests[0]

			assert.ok(firstRequest, `DeepSeek should have issued at least one API request.\n${diagnostics}`)
			assert.strictEqual(
				firstRequest.model,
				modelId,
				`DeepSeek should request the expected model.\n${diagnostics}`,
			)
			assert.ok(
				typeof firstRequest.maxCompletionTokens === "number" && firstRequest.maxCompletionTokens > 0,
				`DeepSeek request should include max_completion_tokens.\n${diagnostics}`,
			)

			if (reasoningEnabled) {
				assert.strictEqual(
					firstRequest.thinkingType,
					"enabled",
					`Reasoning-enabled probe should send thinking=enabled.\n${diagnostics}`,
				)
				assert.ok(
					firstRequest.reasoningEffort === "high" || firstRequest.reasoningEffort === "max",
					`Reasoning-enabled probe should send a DeepSeek reasoning_effort.\n${diagnostics}`,
				)
			} else {
				assert.strictEqual(
					firstRequest.thinkingType,
					"disabled",
					`Reasoning-disabled probe should send thinking=disabled.\n${diagnostics}`,
				)
				assert.strictEqual(
					firstRequest.reasoningEffort,
					undefined,
					`Reasoning-disabled probe should omit reasoning_effort.\n${diagnostics}`,
				)
			}

			assert.ok(result.completed, `Task should complete cleanly.\n${diagnostics}`)
			assert.strictEqual(
				result.mistakeLimitReached,
				false,
				`Task should not hit the consecutive mistake limit.\n${diagnostics}`,
			)
			assert.strictEqual(
				result.noToolErrors,
				0,
				`Task should not emit MODEL_NO_TOOLS_USED while handling a tool-using probe.\n${diagnostics}`,
			)
			assert.strictEqual(
				result.completionText,
				marker,
				`Task should return the exact marker from the workspace file.\n${diagnostics}`,
			)
		})
	}
})
