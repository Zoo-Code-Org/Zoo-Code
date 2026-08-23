import * as assert from "assert"
import { createServer, type IncomingMessage, type ServerResponse } from "http"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import {
	DTE_NT_EXPLICIT_CHILD_RESULT,
	DTE_NT_EXPLICIT_PARENT_PROMPT,
	DTE_NT_EXPLICIT_PARENT_RESULT,
	DTE_NT_INHERIT_CHILD_MARKER,
	DTE_NT_INHERIT_CHILD_RESULT,
	DTE_NT_INHERIT_PARENT_MARKER,
	DTE_NT_INHERIT_PARENT_PROMPT,
	DTE_NT_INHERIT_PARENT_RESULT,
	DTE_NT_NEGATIVE_PARENT_MARKER,
	DTE_NT_NEGATIVE_PARENT_PROMPT,
	DTE_NT_NEGATIVE_PARENT_RESULT,
} from "../fixtures/subtasks"
import { setDefaultSuiteTimeout } from "./test-utils"
import { sleep, waitFor, waitUntilCompleted } from "./utils"

// Wire-boundary capture (modeled on anthropic-opus-4-7.test.ts): a local 127.0.0.1
// proxy in front of the Anthropic base URL records every /v1/messages request body
// before forwarding it to the upstream (the aimock server in mock mode). Assertions
// below therefore run against the real request the extension host actually sent.
type CapturedEffortRequest = {
	model?: string
	thinkingType?: string
	outputConfigEffort?: string
	lastUserMessage: string
	// The full request body as sent over the wire. Lets assertions check
	// model-visible content (e.g. tool results) that is not part of the
	// last user message.
	rawBody: string
}

const ANTHROPIC_MESSAGES_PATH = "/v1/messages"
const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"transfer-encoding",
	"te",
	"trailer",
	"upgrade",
	"proxy-connection",
	"proxy-authenticate",
	"proxy-authorization",
	"host",
	"content-length",
])

function isMessagesUrl(rawUrl: string): boolean {
	try {
		return new URL(rawUrl).pathname.endsWith(ANTHROPIC_MESSAGES_PATH)
	} catch {
		return false
	}
}

function readRequestBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = []
		req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
		req.on("error", reject)
	})
}

function writeResponseHeaders(target: ServerResponse, source: Response) {
	const headers: Record<string, string> = {}
	source.headers.forEach((value, key) => {
		const lower = key.toLowerCase()
		// fetch() automatically decompresses the body, so strip content-encoding to
		// prevent the SDK from attempting a second decompression (zlib "incorrect
		// header check"). Also strip content-length since the decoded body length
		// differs from the compressed length.
		if (lower !== "content-length" && lower !== "content-encoding") {
			headers[key] = value
		}
	})
	target.writeHead(source.status, headers)
}

async function pipeFetchResponse(target: ServerResponse, source: Response) {
	writeResponseHeaders(target, source)

	if (!source.body) {
		target.end()
		return
	}

	const reader = source.body.getReader()
	while (true) {
		const { done, value } = await reader.read()
		if (done) {
			break
		}
		target.write(value)
	}

	target.end()
}

function resolveAllowedUpstreamUrl(baseUrl: string): URL {
	const upstreamBase = new URL(baseUrl)
	const isLocalProxy = upstreamBase.hostname === "127.0.0.1" || upstreamBase.hostname === "localhost"

	if (!isLocalProxy || (upstreamBase.protocol !== "http:" && baseUrl !== "https://api.anthropic.com")) {
		throw new Error("Unexpected Anthropic proxy target: " + upstreamBase.origin)
	}

	return new URL(ANTHROPIC_MESSAGES_PATH, upstreamBase)
}

async function withEffortProxy<T>(
	baseUrl: string,
	run: (args: { proxyUrl: string; requests: CapturedEffortRequest[] }) => Promise<T>,
): Promise<T> {
	const requests: CapturedEffortRequest[] = []
	let proxyError: Error | undefined
	const server = createServer(async (req, res) => {
		try {
			const requestUrl = req.url ?? "/"

			if (!isMessagesUrl("http://127.0.0.1" + requestUrl)) {
				res.writeHead(404)
				res.end("Not found")
				return
			}

			const bodyText = await readRequestBody(req)
			const body = JSON.parse(bodyText) as {
				model?: string
				thinking?: { type?: string }
				output_config?: { effort?: string }
				messages?: Array<{ role?: string; content?: unknown }>
			}

			const lastUser = [...(body.messages ?? [])].reverse().find((message) => message.role === "user")
			const lastUserMessage =
				typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "")

			requests.push({
				model: body.model,
				thinkingType: body.thinking?.type,
				outputConfigEffort: body.output_config?.effort,
				lastUserMessage,
				rawBody: bodyText,
			})

			const forwardHeaders: Record<string, string> = {}
			for (const [key, value] of Object.entries(req.headers)) {
				if (!HOP_BY_HOP.has(key.toLowerCase()) && typeof value === "string") {
					forwardHeaders[key] = value
				}
			}

			const upstreamUrl = resolveAllowedUpstreamUrl(baseUrl)
			const upstream = await fetch(upstreamUrl, {
				method: req.method,
				headers: forwardHeaders,
				body: bodyText,
			})

			await pipeFetchResponse(res, upstream)
		} catch (error) {
			proxyError = error instanceof Error ? error : new Error(String(error))
			console.error("Effort proxy request failed:", proxyError)
			res.writeHead(500)
			res.end("Effort proxy request failed")
		}
	})

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
	const address = server.address()
	if (!address || typeof address === "string") {
		server.close()
		throw new Error("Failed to start effort proxy server")
	}

	const proxyUrl = "http://127.0.0.1:" + address.port

	try {
		const result = await run({ proxyUrl, requests })
		if (proxyError) {
			throw proxyError
		}
		return result
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
	}
}

// Restore the OpenRouter default config after this suite so other suites are unaffected.
const restoreOpenRouterConfig = async () => {
	const aimockUrl = process.env.AIMOCK_URL
	const isRecord = process.env.AIMOCK_RECORD === "true"
	await globalThis.api.setConfiguration({
		apiProvider: "openrouter" as const,
		openRouterApiKey: aimockUrl && !isRecord ? "mock-key" : process.env.OPENROUTER_API_KEY!,
		openRouterModelId: "openai/gpt-4.1",
		...(aimockUrl && { openRouterBaseUrl: aimockUrl + "/v1" }),
	})
}

suite("new_task thinking effort (DTE series 5/5)", function () {
	setDefaultSuiteTimeout(this)

	suiteTeardown(restoreOpenRouterConfig)

	// (b) Inheritance: a new_task call without thinking_effort starts the child with the
	// parent's current effective effort (PR-2 resolution: no task-local override is
	// reachable in e2e before DTE series 3/5, so the settings value "medium" is the
	// strongest source). The child's real /v1/messages request must carry that effort.
	test("child started without explicit effort carries the parent's effective effort", async function () {
		const api = globalThis.api
		const aimockUrl = process.env.AIMOCK_URL
		const isRecord = process.env.AIMOCK_RECORD === "true"

		if (!aimockUrl && !process.env.ANTHROPIC_API_KEY) {
			this.skip()
		}

		await withEffortProxy(aimockUrl || "https://api.anthropic.com", async ({ proxyUrl, requests }) => {
			await api.setConfiguration({
				apiProvider: "anthropic" as const,
				apiKey: aimockUrl && !isRecord ? "mock-key" : process.env.ANTHROPIC_API_KEY!,
				apiModelId: "claude-opus-4-7",
				enableReasoningEffort: true,
				reasoningEffort: "medium",
				anthropicBaseUrl: proxyUrl,
			})

			const says: Record<string, ClineMessage[]> = {}

			const messageHandler = ({ taskId, message }: { taskId: string; message: ClineMessage }) => {
				if (message.type === "say" && message.partial === false) {
					says[taskId] = says[taskId] || []
					says[taskId].push(message)
				}
			}

			api.on(RooCodeEventName.Message, messageHandler)

			let parentTaskId: string | undefined

			try {
				parentTaskId = await api.startNewTask({
					configuration: {
						mode: "ask",
						alwaysAllowModeSwitch: true,
						alwaysAllowSubtasks: true,
						autoApprovalEnabled: true,
						enableCheckpoints: false,
					},
					text: DTE_NT_INHERIT_PARENT_PROMPT,
				})

				// Wait for the child's real request to reach the proxy: an immediate child is
				// only observable while its first request is in flight (the parent instance is
				// disposed on delegation and re-instantiated on resume, so the UI task stack is
				// not a reliable child-liveness signal here).
				await waitFor(
					() => requests.some((request) => request.lastUserMessage.includes(DTE_NT_INHERIT_CHILD_MARKER)),
					{ timeout: 45_000 },
				)

				// The parent's completion is the terminal event of the whole flow.
				await waitUntilCompleted({ api, taskId: parentTaskId, timeout: 60_000 })

				assert.ok(
					Object.entries(says).some(
						([taskId, messages]) =>
							taskId !== parentTaskId &&
							messages.some(
								({ say, text }) =>
									say === "completion_result" && text?.trim() === DTE_NT_INHERIT_CHILD_RESULT,
							),
					),
					"Immediately-completing child should emit its expected result",
				)
				assert.strictEqual(
					says[parentTaskId!]?.find(({ say }) => say === "completion_result")?.text?.trim(),
					DTE_NT_INHERIT_PARENT_RESULT,
					"Parent should resume after the child completes",
				)

				// Wire assertion: the child's real request (identified by the child prompt
				// marker in its last user message) carries the parent's effective effort.
				const childRequests = requests.filter((request) =>
					request.lastUserMessage.includes(DTE_NT_INHERIT_CHILD_MARKER),
				)
				assert.ok(childRequests.length > 0, "The child subtask should issue a real API request")
				const firstChildRequest = childRequests[0]
				assert.ok(firstChildRequest, "Child request should be captured by the proxy")
				assert.strictEqual(firstChildRequest.model, "claude-opus-4-7")
				assert.strictEqual(
					firstChildRequest.thinkingType,
					"adaptive",
					"The child request should be an adaptive-thinking request",
				)
				assert.strictEqual(
					firstChildRequest.outputConfigEffort,
					"medium",
					"The child's request should carry the parent's current effective effort (DTE series 5/5 inheritance via PR-2 resolution)",
				)

				// Control: the parent's own first request carries the same settings-derived
				// baseline, confirming the envelope is resolved identically on both sides.
				const parentRequests = requests.filter((request) =>
					request.lastUserMessage.includes(DTE_NT_INHERIT_PARENT_MARKER),
				)
				assert.ok(parentRequests.length > 0, "The parent should issue a real API request")
				const firstParentRequest = parentRequests[0]
				assert.ok(firstParentRequest, "Parent request should be captured by the proxy")
				assert.strictEqual(firstParentRequest.outputConfigEffort, "medium")
			} finally {
				api.off(RooCodeEventName.Message, messageHandler)
				while (api.getCurrentTaskStack().length > 0) {
					await api.clearCurrentTask()
				}
				await sleep(1_500)
			}
		})
	})

	// (a) Explicit effort: a new_task call with thinking_effort "high" on a model whose
	// capability array accepts it (deepseek-v4-pro: ["disable","low","high","max"]). The
	// parameter round-trips schema -> validation -> approval -> delegation and the child
	// subtask runs to completion on the real host.
	//
	// No wire assertion here: the DeepSeek handler resolves the request effort from
	// settings only and does not consume the per-request override — and the only handler
	// that does consume it (Anthropic) serves catalog models without a capability array,
	// so no model today both passes the DTE 5/5 validation and propagates an explicit
	// effort to the wire. Documented in the PR body.
	test("explicit thinking_effort delegates a child subtask that completes", async function () {
		const api = globalThis.api
		const aimockUrl = process.env.AIMOCK_URL
		const isRecord = process.env.AIMOCK_RECORD === "true"

		if (!aimockUrl && !process.env.DEEPSEEK_API_KEY) {
			this.skip()
		}

		await api.setConfiguration({
			apiProvider: "deepseek" as const,
			deepSeekApiKey: aimockUrl && !isRecord ? "mock-key" : process.env.DEEPSEEK_API_KEY!,
			...(aimockUrl && { deepSeekBaseUrl: aimockUrl + "/v1" }),
			apiModelId: "deepseek-v4-pro",
			// Reasoning off for this probe: the test is about the subtask flow carrying
			// the explicit effort parameter, not about the reasoning envelope.
			enableReasoningEffort: false,
		})

		const says: Record<string, ClineMessage[]> = {}

		const messageHandler = ({ taskId, message }: { taskId: string; message: ClineMessage }) => {
			if (message.type === "say" && message.partial === false) {
				says[taskId] = says[taskId] || []
				says[taskId].push(message)
			}
		}

		api.on(RooCodeEventName.Message, messageHandler)

		let parentTaskId: string | undefined

		try {
			parentTaskId = await api.startNewTask({
				configuration: {
					mode: "ask",
					alwaysAllowModeSwitch: true,
					alwaysAllowSubtasks: true,
					autoApprovalEnabled: true,
					enableCheckpoints: false,
				},
				text: DTE_NT_EXPLICIT_PARENT_PROMPT,
			})

			// The parent's completion is the terminal event of the whole flow (the child
			// completes on its first response, so its own lifecycle is covered by the
			// completion_result assertions below — same pattern as the fast-child test).
			await waitUntilCompleted({ api, taskId: parentTaskId, timeout: 75_000 })

			assert.ok(
				Object.entries(says).some(
					([taskId, messages]) =>
						taskId !== parentTaskId &&
						messages.some(
							({ say, text }) =>
								say === "completion_result" && text?.trim() === DTE_NT_EXPLICIT_CHILD_RESULT,
						),
				),
				"Explicit-effort child should emit its expected result",
			)
			assert.strictEqual(
				says[parentTaskId!]?.find(({ say }) => say === "completion_result")?.text?.trim(),
				DTE_NT_EXPLICIT_PARENT_RESULT,
				"Parent should resume after the explicit-effort child completes",
			)
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
			while (api.getCurrentTaskStack().length > 0) {
				await api.clearCurrentTask()
			}
			await sleep(1_500)
		}
	})

	// (a) Negative guard: an explicit effort on a model without a capability array is
	// rejected by the tool before the approval ask — no child is created and the model
	// sees the tool error. claude-opus-4-7 has supportsReasoningBinary (adaptive
	// thinking) but no effort capability array, so "high" must be refused.
	test("explicit thinking_effort on a capability-less model is rejected without creating a child", async function () {
		const api = globalThis.api
		const aimockUrl = process.env.AIMOCK_URL
		const isRecord = process.env.AIMOCK_RECORD === "true"

		if (!aimockUrl && !process.env.ANTHROPIC_API_KEY) {
			this.skip()
		}

		// The rejected tool call's error reaches the model as a tool_result in the
		// parent's follow-up request (the extension emits no user-visible message for
		// tool results), so this flow runs through the capturing proxy and the
		// visibility assertion runs against the captured wire request.
		await withEffortProxy(aimockUrl || "https://api.anthropic.com", async ({ proxyUrl, requests }) => {
			await api.setConfiguration({
				apiProvider: "anthropic" as const,
				apiKey: aimockUrl && !isRecord ? "mock-key" : process.env.ANTHROPIC_API_KEY!,
				apiModelId: "claude-opus-4-7",
				anthropicBaseUrl: proxyUrl,
			})

			const says: Record<string, ClineMessage[]> = {}
			const seenTaskIds = new Set<string>()

			const messageHandler = ({ taskId, message }: { taskId: string; message: ClineMessage }) => {
				seenTaskIds.add(taskId)
				if (message.type === "say" && message.partial === false) {
					says[taskId] = says[taskId] || []
					says[taskId].push(message)
				}
			}

			api.on(RooCodeEventName.Message, messageHandler)

			let parentTaskId: string | undefined

			try {
				parentTaskId = await api.startNewTask({
					configuration: {
						mode: "ask",
						alwaysAllowModeSwitch: true,
						alwaysAllowSubtasks: true,
						autoApprovalEnabled: true,
						enableCheckpoints: false,
					},
					text: DTE_NT_NEGATIVE_PARENT_PROMPT,
				})

				await waitUntilCompleted({ api, taskId: parentTaskId, timeout: 60_000 })

				assert.strictEqual(
					says[parentTaskId!]?.find(({ say }) => say === "completion_result")?.text?.trim(),
					DTE_NT_NEGATIVE_PARENT_RESULT,
					"Parent should complete after the rejected tool call",
				)
				assert.strictEqual(
					seenTaskIds.size,
					1,
					"No child subtask should be created for a rejected thinking_effort (task ids: " +
						[...seenTaskIds].join(", ") +
						")",
				)

				// Wire assertion: the rejection must be visible to the model in the
				// parent's own follow-up request (tool_result content) — a request
				// carrying both the parent marker and the tool-error text.
				const errorRequests = requests.filter(
					(request) =>
						request.rawBody.includes("Invalid thinking_effort") &&
						request.rawBody.includes(DTE_NT_NEGATIVE_PARENT_MARKER),
				)
				assert.ok(
					errorRequests.length > 0,
					"The rejected thinking_effort tool error should be visible to the model on the wire",
				)
			} finally {
				api.off(RooCodeEventName.Message, messageHandler)
				while (api.getCurrentTaskStack().length > 0) {
					await api.clearCurrentTask()
				}
				await sleep(1_500)
			}
		})
	})
})
