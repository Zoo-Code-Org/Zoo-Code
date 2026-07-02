import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { setDefaultSuiteTimeout } from "../test-utils"
import { sleep, waitFor, waitUntilAborted } from "../utils"

const NOVITA_API_KEY = process.env.NOVITA_API_KEY
const NOVITA_MODEL_ID = process.env.NOVITA_MODEL_ID || "moonshotai/kimi-k2.7-code"

type CapturedNovitaRequest = {
	model?: string
	maxCompletionTokens?: number
	probeTag?: string
	lastUserMessage: string
}

type NovitaProbeResult = {
	completed: boolean
	aborted: boolean
	noToolErrors: number
	mistakeLimitReached: boolean
	completionText?: string
	usedReadFile: boolean
	requests: CapturedNovitaRequest[]
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
			max_completion_tokens?: number
			messages?: Array<{ role?: string; content?: unknown }>
	  }
	| undefined {
	if (!init?.body || typeof init.body !== "string") {
		return undefined
	}

	return JSON.parse(init.body)
}

function installNovitaRequestCapture(capture: CapturedNovitaRequest[], baseUrl: string): () => void {
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
			const probeTag = allMessagesText.match(/novita-e2e:[^"\s]+/)?.[0]

			capture.push({
				model: body.model,
				maxCompletionTokens: body.max_completion_tokens,
				probeTag,
				lastUserMessage,
			})
		}

		return originalFetch.call(globalThis, input, init as RequestInit)
	} as typeof globalThis.fetch

	return () => {
		globalThis.fetch = originalFetch
	}
}

function formatDiagnostics(result: NovitaProbeResult) {
	const requestSummary = result.requests
		.map((request, index) => {
			const summary = {
				model: request.model,
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
		`usedReadFile=${result.usedReadFile}`,
		requestSummary || "requestSummary=<none>",
		"transcript:",
		...result.transcript.map((line) => `  ${line}`),
	].join("\n")
}

async function runNovitaToolProbe(
	modelId: string,
	requests: CapturedNovitaRequest[],
): Promise<{ result: NovitaProbeResult; marker: string }> {
	const api = globalThis.api
	const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath

	if (!workspaceDir) {
		throw new Error("No workspace folder found for Novita E2E probe")
	}

	requests.length = 0

	const marker = "NOVITA_E2E_MARKER"
	const fileName = "novita-e2e-marker.txt"
	const probeTag = "novita-e2e:tool-use"
	const filePath = path.join(workspaceDir, fileName)
	const aimockUrl = process.env.AIMOCK_URL
	const isRecord = process.env.AIMOCK_RECORD === "true"

	await fs.writeFile(filePath, `${marker}\n`, "utf8")

	const transcript: string[] = []
	let noToolErrors = 0
	let mistakeLimitReached = false
	let completionText: string | undefined
	let usedReadFile = false
	let taskCompleted = false
	let taskAborted = false

	const messageHandler = ({ message }: { message: ClineMessage }) => {
		if (message.type === "say" && message.partial === false) {
			transcript.push(`${message.say}: ${message.text?.slice(0, 220) ?? ""}`)

			if (message.say === "error" && message.text === "MODEL_NO_TOOLS_USED") {
				noToolErrors++
			}

			if (message.say === "tool" && message.text?.includes(fileName)) {
				usedReadFile = true
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

			if (message.ask === "completion_result" && message.text?.trim()) {
				completionText = message.text.trim()
			}
		}
	}

	api.on(RooCodeEventName.Message, messageHandler)
	let taskId: string | undefined

	try {
		const novitaApiKey = aimockUrl && !isRecord ? "mock-key" : NOVITA_API_KEY

		await api.setConfiguration({
			apiProvider: "novita" as const,
			...(novitaApiKey && { novitaApiKey }),
			...(aimockUrl && { novitaBaseUrl: `${aimockUrl}/v1` }),
			apiModelId: modelId,
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

			if (mistakeLimitReached && !taskCompleted && !taskAborted && taskId) {
				await api.cancelCurrentTask()
				await waitUntilAborted({ api, taskId, timeout: 15_000 })
				taskAborted = true
			}
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
				usedReadFile: usedReadFile || transcript.some((line) => line.includes(fileName)),
				requests: requests.filter((request) => request.model === modelId && request.probeTag === probeTag),
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

suite("Novita provider", function () {
	setDefaultSuiteTimeout(this)
	this.timeout(6 * 60_000)

	let restoreFetch: (() => void) | undefined
	const requests: CapturedNovitaRequest[] = []

	setup(function () {
		const needsRealNovitaKey = process.env.AIMOCK_RECORD === "true" || !process.env.AIMOCK_URL

		if (needsRealNovitaKey && !NOVITA_API_KEY) {
			this.skip()
		}
	})

	suiteSetup(() => {
		restoreFetch = installNovitaRequestCapture(
			requests,
			process.env.AIMOCK_URL ? `${process.env.AIMOCK_URL}/v1` : "https://api.novita.ai/openai",
		)
	})

	suiteTeardown(async () => {
		restoreFetch?.()
		restoreFetch = undefined

		const aimockUrl = process.env.AIMOCK_URL
		const isRecord = process.env.AIMOCK_RECORD === "true"
		const openRouterApiKey = aimockUrl
			? isRecord
				? (process.env.OPENROUTER_API_KEY ?? "mock-key")
				: "mock-key"
			: process.env.OPENROUTER_API_KEY

		await globalThis.api.setConfiguration({
			apiProvider: "openrouter" as const,
			...(openRouterApiKey && { openRouterApiKey }),
			openRouterModelId: "openai/gpt-4.1",
			...(aimockUrl && { openRouterBaseUrl: `${aimockUrl}/v1` }),
		})
	})

	test("should complete a tool-using task through the OpenAI-compatible Novita API", async () => {
		const { result, marker } = await runNovitaToolProbe(NOVITA_MODEL_ID, requests)
		const diagnostics = formatDiagnostics(result)
		const [firstRequest, secondRequest] = result.requests

		assert.ok(firstRequest, `Novita should have issued at least one API request.\n${diagnostics}`)
		assert.ok(secondRequest, `Novita should issue a follow-up request after the tool result.\n${diagnostics}`)
		assert.strictEqual(
			firstRequest.model,
			NOVITA_MODEL_ID,
			`Novita should request the expected model.\n${diagnostics}`,
		)
		assert.ok(result.completed, `Novita task should complete.\n${diagnostics}`)
		assert.strictEqual(result.aborted, false, `Novita task should not abort.\n${diagnostics}`)
		assert.strictEqual(result.noToolErrors, 0, `Novita should not hit MODEL_NO_TOOLS_USED.\n${diagnostics}`)
		assert.ok(result.usedReadFile, `Novita should use read_file for the marker file.\n${diagnostics}`)
		assert.ok(
			result.transcript.some((line) => line.startsWith("completion_result:")),
			`Novita should reach completion after the tool loop.\n${diagnostics}`,
		)
		if (result.completionText) {
			assert.strictEqual(result.completionText, marker, `Novita should return the exact marker.\n${diagnostics}`)
		}
	})
})
