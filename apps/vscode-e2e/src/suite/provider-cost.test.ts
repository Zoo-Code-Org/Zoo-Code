import * as assert from "assert"
import { createServer, type IncomingMessage, type ServerResponse } from "http"

import { RooCodeEventName, mimoModels, type ClineMessage } from "@roo-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"

/**
 * E2E coverage for the B17 provider cost metric calculation.
 *
 * The MiMo provider (src/api/providers/mimo.ts) computes `totalCost` from
 * streamed `usage` chunks via `calculateApiCostOpenAI` and yields it as a
 * `usage` stream item. Task.ts then persists it on the `api_req_started`
 * cline message (`cost` field of ClineApiReqInfo) and forwards it to
 * `TelemetryService.captureLlmCompletion`. This suite drives the built
 * extension against a local OpenAI-compatible stub that returns a fixed
 * usage payload and asserts the persisted cost matches the model's
 * published pricing (inputPrice/outputPrice of mimo-v2.5-pro).
 */

type CapturedMimoRequest = {
	model?: string
	stream?: boolean
	includeUsage?: boolean
}

const MIMO_MODEL_ID = "mimo-v2.5-pro"
// Deterministic usage payload served by the stub. Cost expectation:
//   input:  1000 / 1e6 * $1.00 = $0.001
//   output:  500 / 1e6 * $3.00 = $0.0015
//   total                      = $0.0025
const STUB_INPUT_TOKENS = 1000
const STUB_OUTPUT_TOKENS = 500
const EXPECTED_TOTAL_COST = 0.0025

function readRequestBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = []
		req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
		req.on("error", reject)
	})
}

function buildSsePayload(modelId: string): string {
	const textChunk = {
		id: "chatcmpl-stub",
		object: "chat.completion.chunk",
		created: 0,
		model: modelId,
		choices: [{ index: 0, delta: { role: "assistant", content: "4" }, finish_reason: null }],
	}

	const finalChunk = {
		id: "chatcmpl-stub",
		object: "chat.completion.chunk",
		created: 0,
		model: modelId,
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		usage: {
			prompt_tokens: STUB_INPUT_TOKENS,
			completion_tokens: STUB_OUTPUT_TOKENS,
			total_tokens: STUB_INPUT_TOKENS + STUB_OUTPUT_TOKENS,
		},
	}

	return `data: ${JSON.stringify(textChunk)}\n\ndata: ${JSON.stringify(finalChunk)}\n\ndata: [DONE]\n\n`
}

function isChatCompletionsUrl(rawUrl: string): boolean {
	try {
		return new URL(rawUrl, "http://127.0.0.1").pathname.endsWith("/chat/completions")
	} catch {
		return false
	}
}

async function withMimoStub<T>(
	run: (args: { baseUrl: string; requests: CapturedMimoRequest[] }) => Promise<T>,
): Promise<T> {
	const requests: CapturedMimoRequest[] = []
	let serverError: Error | undefined

	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		try {
			const requestUrl = req.url ?? "/"

			if (!isChatCompletionsUrl(requestUrl)) {
				res.writeHead(404)
				res.end("Not found")
				return
			}

			const bodyText = await readRequestBody(req)
			const body = JSON.parse(bodyText) as {
				model?: string
				stream?: boolean
				stream_options?: { include_usage?: boolean }
			}

			requests.push({
				model: body.model,
				stream: body.stream,
				includeUsage: body.stream_options?.include_usage,
			})

			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			})
			res.end(buildSsePayload(body.model ?? MIMO_MODEL_ID))
		} catch (error) {
			serverError = error instanceof Error ? error : new Error(String(error))
			res.writeHead(500)
			res.end("Stub failure")
		}
	})

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
	const address = server.address()
	if (!address || typeof address === "string") {
		server.close()
		throw new Error("Failed to start MiMo stub server")
	}

	const baseUrl = `http://127.0.0.1:${address.port}/v1`

	try {
		const result = await run({ baseUrl, requests })
		if (serverError) {
			throw serverError
		}
		return result
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
	}
}

function extractCost(message: ClineMessage): number | undefined {
	if (message.type !== "say" || message.say !== "api_req_started" || !message.text) {
		return undefined
	}
	try {
		const info = JSON.parse(message.text) as { cost?: number }
		return typeof info.cost === "number" ? info.cost : undefined
	} catch {
		return undefined
	}
}

suite("Provider Cost Metrics (B17)", function () {
	setDefaultSuiteTimeout(this)

	// Restore the default OpenRouter config so subsequent suites are unaffected.
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

	test("MiMo provider streams usage, calculates cost, and persists it on api_req_started", async function () {
		const api = globalThis.api

		await withMimoStub(async ({ baseUrl, requests }) => {
			await api.setConfiguration({
				apiProvider: "mimo" as const,
				mimoApiKey: "stub-key",
				mimoBaseUrl: baseUrl,
				apiModelId: MIMO_MODEL_ID,
			})

			const apiReqMessages: ClineMessage[] = []
			const onMessage = ({ message }: { message: ClineMessage }) => {
				if (message.type === "say" && message.say === "api_req_started" && message.partial === false) {
					apiReqMessages.push(message)
				}
			}
			api.on(RooCodeEventName.Message, onMessage)

			let taskId: string
			try {
				taskId = await api.startNewTask({
					configuration: { mode: "ask", alwaysAllowModeSwitch: true, autoApprovalEnabled: true },
					text: "provider-cost-e2e: what is 2+2? Reply with only the number.",
				})

				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(() => {
						cleanup()
						reject(new Error("Timeout after 60s"))
					}, 60_000)

					const cleanup = () => {
						clearTimeout(timer)
						api.off(RooCodeEventName.TaskCompleted, onCompleted)
						api.off(RooCodeEventName.TaskAborted, onAborted)
					}

					const onCompleted = (completedId: string) => {
						if (completedId === taskId) {
							cleanup()
							resolve()
						}
					}

					const onAborted = (abortedId: string) => {
						if (abortedId === taskId) {
							cleanup()
							reject(new Error("Task was aborted - MiMo stub request failed"))
						}
					}

					api.on(RooCodeEventName.TaskCompleted, onCompleted)
					api.on(RooCodeEventName.TaskAborted, onAborted)
				})
			} finally {
				api.off(RooCodeEventName.Message, onMessage)
			}

			// The provider must have issued at least one streaming request asking for usage.
			const firstRequest = requests[0]
			assert.ok(firstRequest, "MiMo provider should issue at least one /chat/completions request")
			assert.strictEqual(firstRequest.model, MIMO_MODEL_ID)
			assert.strictEqual(firstRequest.stream, true)
			assert.strictEqual(
				firstRequest.includeUsage,
				true,
				"MiMo provider must request usage via stream_options.include_usage",
			)

			// Cost data flows into usage stats: the final api_req_started message
			// must carry the cost computed by calculateApiCostOpenAI for the stubbed
			// token counts and mimo-v2.5-pro pricing.
			const costs = apiReqMessages.map(extractCost).filter((c): c is number => typeof c === "number")
			assert.ok(costs.length > 0, "At least one api_req_started message should contain a cost value")

			const finalCost = costs[costs.length - 1]
			assert.ok(
				finalCost !== undefined && Math.abs(finalCost - EXPECTED_TOTAL_COST) < 1e-9,
				`Expected total cost ${EXPECTED_TOTAL_COST} but got ${finalCost}`,
			)

			// Sanity: the pricing inputs come from the mimoModels registry.
			assert.strictEqual(mimoModels[MIMO_MODEL_ID].inputPrice, 1.0)
			assert.strictEqual(mimoModels[MIMO_MODEL_ID].outputPrice, 3.0)
		})
	})
})
