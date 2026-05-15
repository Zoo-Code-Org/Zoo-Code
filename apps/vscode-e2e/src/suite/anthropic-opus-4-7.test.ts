import * as assert from "assert"
import { createServer, type IncomingMessage, type ServerResponse } from "http"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { waitUntilCompleted } from "./utils"
import { setDefaultSuiteTimeout } from "./test-utils"

type CapturedAnthropicRequest = {
	model?: string
	thinkingType?: string
	lastUserMessage: string
}

const ALLOWED_PROXY_HOSTS = new Set(["127.0.0.1", "localhost", "api.anthropic.com"])
const ANTHROPIC_MESSAGES_PATH = "/v1/messages"

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
		if (key.toLowerCase() !== "content-length") {
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

	if (
		!ALLOWED_PROXY_HOSTS.has(upstreamBase.hostname) ||
		(isLocalProxy ? upstreamBase.protocol !== "http:" : baseUrl !== "https://api.anthropic.com")
	) {
		throw new Error(`Unexpected Anthropic proxy target: ${upstreamBase.origin}`)
	}

	return new URL(ANTHROPIC_MESSAGES_PATH, upstreamBase)
}

async function withAnthropicProxy<T>(
	baseUrl: string,
	run: (args: { proxyUrl: string; requests: CapturedAnthropicRequest[] }) => Promise<T>,
): Promise<T> {
	const requests: CapturedAnthropicRequest[] = []
	let proxyError: Error | undefined
	const server = createServer(async (req, res) => {
		try {
			const requestUrl = req.url ?? "/"

			if (!isMessagesUrl(`http://127.0.0.1${requestUrl}`)) {
				res.writeHead(404)
				res.end("Not found")
				return
			}

			const bodyText = await readRequestBody(req)
			const body = JSON.parse(bodyText) as {
				model?: string
				thinking?: { type?: string }
				messages?: Array<{ role?: string; content?: unknown }>
			}

			const lastUser = [...(body.messages ?? [])].reverse().find((message) => message.role === "user")
			const lastUserMessage =
				typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "")

			requests.push({
				model: body.model,
				thinkingType: body.thinking?.type,
				lastUserMessage,
			})

			const forwardHeaders: Record<string, string> = {}
			for (const [key, value] of Object.entries(req.headers)) {
				if (
					key.toLowerCase() !== "host" &&
					key.toLowerCase() !== "content-length" &&
					typeof value === "string"
				) {
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
			console.error("Anthropic proxy request failed:", proxyError)
			res.writeHead(500)
			res.end("Anthropic proxy request failed")
		}
	})

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
	const address = server.address()
	if (!address || typeof address === "string") {
		server.close()
		throw new Error("Failed to start Anthropic proxy server")
	}

	const proxyUrl = `http://127.0.0.1:${address.port}`

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

	for (const reasoningEnabled of [true, false] as const) {
		test(`Should complete a task end-to-end using claude-opus-4-7 via Anthropic provider with reasoning ${
			reasoningEnabled ? "enabled" : "disabled"
		}`, async function () {
			const api = globalThis.api
			const aimockUrl = process.env.AIMOCK_URL
			const isRecord = process.env.AIMOCK_RECORD === "true"

			if (!aimockUrl && !process.env.ANTHROPIC_API_KEY) {
				this.skip()
			}

			const captureBaseUrl = aimockUrl || "https://api.anthropic.com"
			await withAnthropicProxy(captureBaseUrl, async ({ proxyUrl, requests }) => {
				const promptTag = reasoningEnabled ? "opus47-e2e:reasoning-on" : "opus47-e2e:reasoning-off"

				// aimock handles /v1/messages natively and serves Anthropic-format SSE responses.
				// In record mode the real x-api-key is forwarded so aimock can proxy to api.anthropic.com.
				await api.setConfiguration({
					apiProvider: "anthropic" as const,
					apiKey: aimockUrl && !isRecord ? "mock-key" : process.env.ANTHROPIC_API_KEY!,
					apiModelId: "claude-opus-4-7",
					enableReasoningEffort: reasoningEnabled,
					anthropicBaseUrl: proxyUrl,
				})

				const messages: ClineMessage[] = []

				api.on(RooCodeEventName.Message, ({ message }) => {
					if (message.type === "say" && message.partial === false) {
						messages.push(message)
					}
				})

				const taskId = await api.startNewTask({
					configuration: { mode: "ask", alwaysAllowModeSwitch: true, autoApprovalEnabled: true },
					text: `${promptTag}: what is 2+2? Reply with only the number.`,
				})

				await waitUntilCompleted({ api, taskId })

				const firstRequest = requests[0]
				assert.ok(firstRequest, "Anthropic provider should issue at least one /v1/messages request")
				assert.strictEqual(firstRequest.model, "claude-opus-4-7")

				if (reasoningEnabled) {
					assert.strictEqual(firstRequest.thinkingType, "adaptive")
				} else {
					assert.strictEqual(firstRequest.thinkingType, undefined)
				}

				const completionMessage = messages.find(
					({ say, text }) => (say === "completion_result" || say === "text") && text?.trim() === "4",
				)

				assert.ok(completionMessage, "Task should complete with the expected Claude Opus 4.7 response")
			})
		})
	}
})
