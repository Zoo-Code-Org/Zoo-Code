import * as assert from "assert"
import { createServer, type IncomingMessage, type ServerResponse } from "http"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitUntilCompleted } from "./utils"

/**
 * DTE addendum: set_thinking_effort mid-task workflow.
 *
 * Exercises the real extension-host boundary end to end with aimock fixtures:
 * the model calls set_thinking_effort mid-task (no approval gate), the
 * SetThinkingEffortTool display say is emitted, and the FOLLOWING API request
 * carries the applied effort in the OpenRouter reasoning envelope.
 *
 * Determinism notes:
 * - Runs against aimock only (replay or record); skips when aimock is absent,
 *   so no API keys are required.
 * - The capture proxy is the local 127.0.0.1 pattern from
 *   anthropic-opus-4-7.test.ts: it intercepts the OpenRouter-compatible
 *   chat/completions POST (so request shapes can be asserted) and forwards it
 *   to aimock for the fixture-driven SSE responses.
 * - The OpenRouter model catalog is resolved by the shared model-cache layer
 *   (fetchers/modelCache.ts) from the public OpenRouter endpoint, exactly like
 *   the other provider suites. openai/gpt-5 advertises "reasoning" in
 *   supported_parameters, so the fetcher resolves supportsReasoningEffort and
 *   the dynamicThinkingEffort gate exposes the tool.
 * - The mid-task tool call is dispatched by name in presentAssistantMessage
 *   (a hard-coded case, not the request-declared tool list), and the tool
 *   executor re-checks the model capability after the first request has loaded
 *   the catalog, so the flow is correct even if the first request's tool list
 *   was built before the catalog fetch resolved.
 * - Fixture matching (apps/vscode-e2e/fixtures/thinking-effort-tool.json): the
 *   post-tool request ends with a role:user message (fresh environment details
 *   are appended after the tool result), so aimock's toolCallId matcher — which
 *   inspects only the LAST message — can never match it. The follow-up request is
 *   scoped by the DTE-only model + hasToolResult instead, with turnIndex 1 as a
 *   tie-break. Note the fixture file is plain JSON: aimock's fixture-loader uses
 *   JSON.parse and SKIPS the whole file on parse errors, so no // comments may be
 *   added to it.
 */

const DTE_MODEL_ID = "openai/gpt-5"
const APPLY_MARKER = "DTE_E2E_EFFORT_APPLY"
const SET_EFFORT_TOOL_CALL_ID = "call_dte_e2e_001"
const COMPLETION_EXPECTED = "42"

type DteReasoningEnvelope = {
	effort?: string
	max_tokens?: number
	exclude?: boolean
}

type CapturedDteRequest = {
	model?: string
	reasoning: DteReasoningEnvelope | undefined
	carriesSetEffortToolResult: boolean
	lastUserMessage: string
}

type OpenRouterChatCompletionBody = {
	model?: string
	reasoning?: DteReasoningEnvelope
	messages?: Array<{ role?: string; content?: unknown }>
}

const ALLOWED_PROXY_HOSTS = new Set(["127.0.0.1", "localhost"])
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions"
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

function isChatCompletionsUrl(rawUrl: string): boolean {
	try {
		return new URL(rawUrl).pathname.endsWith(CHAT_COMPLETIONS_PATH)
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
		// prevent the SDK from attempting a second decompression. Also strip
		// content-length since the decoded body length differs from the compressed one.
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

	if (!ALLOWED_PROXY_HOSTS.has(upstreamBase.hostname) || upstreamBase.protocol !== "http:") {
		throw new Error("Unexpected OpenRouter proxy target: " + upstreamBase.origin)
	}

	return new URL(CHAT_COMPLETIONS_PATH, upstreamBase)
}

/**
 * Serves a loopback capture proxy for the OpenRouter-compatible
 * chat/completions endpoint: captures each request body for assertions and
 * forwards it unchanged to the upstream (aimock in replay/record mode).
 */
async function withOpenRouterCaptureProxy<T>(
	upstreamUrl: string,
	run: (args: { proxyUrl: string; requests: CapturedDteRequest[] }) => Promise<T>,
): Promise<T> {
	const requests: CapturedDteRequest[] = []
	const upstreamTarget = resolveAllowedUpstreamUrl(upstreamUrl)
	let proxyError: Error | undefined

	const server = createServer(async (req, res) => {
		try {
			const requestUrl = req.url ?? "/"

			if (!isChatCompletionsUrl("http://127.0.0.1" + requestUrl)) {
				res.writeHead(404)
				res.end("Not found")
				return
			}

			const bodyText = await readRequestBody(req)
			const body = JSON.parse(bodyText) as OpenRouterChatCompletionBody
			const lastUser = [...(body.messages ?? [])].reverse().find((message) => message.role === "user")
			const lastUserMessage =
				typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "")

			requests.push({
				model: body.model,
				reasoning: body.reasoning,
				carriesSetEffortToolResult: JSON.stringify(body.messages ?? []).includes(SET_EFFORT_TOOL_CALL_ID),
				lastUserMessage,
			})

			const forwardHeaders: Record<string, string> = {}
			for (const [key, value] of Object.entries(req.headers)) {
				if (!HOP_BY_HOP.has(key.toLowerCase()) && value !== undefined) {
					forwardHeaders[key] = Array.isArray(value) ? value.join(", ") : value
				}
			}

			const upstream = await fetch(upstreamTarget, {
				method: req.method,
				headers: forwardHeaders,
				body: bodyText,
			})

			await pipeFetchResponse(res, upstream)
		} catch (error) {
			proxyError = error instanceof Error ? error : new Error(String(error))
			console.error("OpenRouter proxy request failed:", proxyError)
			if (!res.headersSent) {
				res.writeHead(502)
				res.end("Capture proxy error")
			} else if (!res.writableEnded) {
				res.destroy()
			}
		}
	})

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve())
	})

	const address = server.address()
	if (address === null || typeof address === "string") {
		server.close()
		throw new Error("Capture proxy failed to bind a loopback port")
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

suite("set_thinking_effort mid-task workflow (DTE addendum)", function () {
	setDefaultSuiteTimeout(this)

	// Restore the default OpenRouter configuration (and switch the experiment off)
	// so subsequent suites are unaffected.
	suiteTeardown(async () => {
		const aimockUrl = process.env.AIMOCK_URL
		const isRecord = process.env.AIMOCK_RECORD === "true"
		await globalThis.api.setConfiguration({
			apiProvider: "openrouter" as const,
			openRouterApiKey: aimockUrl && !isRecord ? "mock-key" : process.env.OPENROUTER_API_KEY!,
			openRouterModelId: "openai/gpt-4.1",
			...(aimockUrl && { openRouterBaseUrl: `${aimockUrl}/v1` }),
			experiments: { dynamicThinkingEffort: false },
		})
	})

	test("Should apply set_thinking_effort mid-task, emit the display say, and send the applied effort on the next request", async function () {
		const api = globalThis.api
		const aimockUrl = process.env.AIMOCK_URL

		// Deterministic, key-free: aimock replay/record only. A live run would need
		// a real model that deterministically emits the tool call.
		if (!aimockUrl) {
			this.skip()
		}

		await withOpenRouterCaptureProxy(aimockUrl, async ({ proxyUrl, requests }) => {
			// OpenRouter provider, a model that advertises per-request reasoning
			// effort, and the dynamicThinkingEffort experiment enabled.
			await api.setConfiguration({
				apiProvider: "openrouter" as const,
				openRouterApiKey: "mock-key",
				openRouterModelId: DTE_MODEL_ID,
				openRouterBaseUrl: `${proxyUrl}/v1`,
				enableReasoningEffort: true,
				experiments: { dynamicThinkingEffort: true },
			})

			const messages: ClineMessage[] = []
			const onMessage = ({ message }: { message: ClineMessage }) => {
				if (message.type === "say" && message.partial === false) {
					messages.push(message)
				}
			}
			api.on(RooCodeEventName.Message, onMessage)

			const taskId = await api.startNewTask({
				configuration: { mode: "ask", alwaysAllowModeSwitch: true, autoApprovalEnabled: true },
				text: APPLY_MARKER + ": answer the math question",
			})

			await waitUntilCompleted({ api, taskId })
			api.off(RooCodeEventName.Message, onMessage)

			// (a) Real boundary: the task completes with the math answer after the
			// mid-task tool round trip.
			const completion = messages.find(
				({ say, text }) =>
					(say === "completion_result" || say === "text") && text?.trim() === COMPLETION_EXPECTED,
			)
			assert.ok(completion, "Task should complete with '" + COMPLETION_EXPECTED + "' after set_thinking_effort")

			// (b) Real boundary: the SetThinkingEffortTool display say carries the
			// applied effort (not a refusal).
			const effortSays = messages.filter(
				({ say, text }) => say === "tool" && typeof text === "string" && text.includes("thinkingEffort"),
			)
			const appliedSay = effortSays.find(({ text }) => text?.includes('"high"'))
			assert.ok(appliedSay, "SetThinkingEffortTool should emit a 'tool' say carrying the applied effort")
			const effortPayload = JSON.parse(appliedSay.text ?? "") as {
				tool?: string
				effort?: string
				reason?: string
				refusal?: string
			}
			assert.strictEqual(
				effortPayload.tool,
				"thinkingEffort",
				"display say should identify the thinkingEffort event",
			)
			assert.strictEqual(effortPayload.effort, "high", "display say should carry the applied 'high' effort")
			assert.strictEqual(effortPayload.reason, "multi-step math", "display say should carry the model's reason")
			assert.strictEqual(
				effortPayload.refusal,
				undefined,
				"the effort change should have been applied, not refused",
			)

			// (c) Real boundary: the request AFTER the tool round trip carries the
			// applied effort in the OpenRouter reasoning envelope.
			const preToolRequest = requests.find(
				(request) => !request.carriesSetEffortToolResult && request.lastUserMessage.includes(APPLY_MARKER),
			)
			assert.ok(preToolRequest, "Should have captured the pre-tool request containing the task prompt")
			assert.strictEqual(preToolRequest.model, DTE_MODEL_ID)
			assert.notStrictEqual(
				preToolRequest.reasoning?.effort,
				"high",
				"the baseline request should not already carry the 'high' effort",
			)

			const postToolRequest = requests.find((request) => request.carriesSetEffortToolResult)
			assert.ok(postToolRequest, "The follow-up request should carry the set_thinking_effort tool result")
			assert.strictEqual(postToolRequest.model, DTE_MODEL_ID)
			assert.ok(postToolRequest.reasoning, "Post-tool request should carry a reasoning envelope")
			assert.strictEqual(
				postToolRequest.reasoning.effort,
				"high",
				"Post-tool request should send the applied 'high' effort",
			)
		})
	})
})
