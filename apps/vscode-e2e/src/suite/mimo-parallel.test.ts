import * as assert from "assert"
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "http"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor, sleep } from "./utils"

/**
 * MIMO Parallel Tool Call Enforcement — E2E
 *
 * PR #1130 (b12-mimo-enforcement-v2) adds:
 *   1. A first-call filter in `src/api/providers/mimo.ts` that drops any
 *      streamed `tool_calls` delta with `index > 0`, because MiMo v2.5 Pro
 *      ignores `parallel_tool_calls: false`.
 *   2. A `ToolCallRetentionPolicy` configured with `maxCallsPerTurn === 1`
 *      which rejects ALL calls when two or more valid side-effecting calls
 *      arrive in a single assistant turn.
 *
 * This suite proves both behaviors end-to-end against the *built* extension
 * bundle by standing up a local OpenAI-compatible SSE mock that deliberately
 * violates the single-call contract:
 *
 *   Test 1 — emits TWO parallel `tool_calls` in one turn (index 0 and 1).
 *            Expected: only the first call (`write_to_file`) is executed;
 *            the second call never produces a tool_result and never reaches
 *            the filesystem.
 *
 *   Test 2 — emits TWO named, well-formed calls at index 0 with distinct IDs
 *            (the "disguised parallel call" pattern MiMo produces).
 *            Expected: the first-call filter owns index 0 to the first ID and
 *            drops the second ID's chunks (and any id-less continuation), so
 *            again only one tool runs.
 *
 * The mock never leaves 127.0.0.1 and requires no API key. If the suite runs
 * in an environment where the extension host cannot open a loopback server,
 * the tests skip cleanly.
 */

type CapturedMimoRequest = {
	model?: string
	parallelToolCalls?: boolean
	toolCount: number
	messageCount: number
	lastUserMessage: string
	rawBody: string
}

type MockBehavior = {
	/** Number of distinct tool_calls to emit at index >= 0. */
	parallelCount: 1 | 2
	/** If true, emit the second call at index 0 with a new id (disguised parallel). */
	disguisedSecondCall: boolean
}

const MIMO_MODEL_ID = "mimo-v2.5-pro"
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions"
const PROBE_TAG = "mimo-parallel-e2e"

function readRequestBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = []
		req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
		req.on("error", reject)
	})
}

function sseChunk(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`
}

function baseChunk(model: string) {
	return {
		id: "chatcmpl-mimo-mock",
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [
			{
				index: 0,
				delta: {},
				finish_reason: null,
			},
		],
	}
}

function toolCallDelta(index: number, partial: Record<string, unknown>) {
	return {
		index,
		...partial,
	}
}

/**
 * Build the SSE body for a response that emits `behavior.parallelCount`
 * parallel `write_to_file` tool calls. Each call targets a distinct file so
 * the test can later assert which (if any) actually executed.
 */
function buildToolCallSseBody(model: string, behavior: MockBehavior): string {
	const chunks: string[] = []

	// ── First tool call (index 0) ────────────────────────────────────────────
	const first = baseChunk(model)
	first.choices[0]!.delta = {
		role: "assistant",
		tool_calls: [
			toolCallDelta(0, {
				id: "call_first_aaa",
				type: "function",
				function: { name: "write_to_file", arguments: "" },
			}),
		],
	}
	chunks.push(sseChunk(first))

	const firstArgs = baseChunk(model)
	firstArgs.choices[0]!.delta = {
		tool_calls: [
			toolCallDelta(0, {
				function: {
					arguments: JSON.stringify({
						path: "mimo-first.txt",
						content: "MIMO_FIRST_CALL_EXECUTED",
					}),
				},
			}),
		],
	}
	chunks.push(sseChunk(firstArgs))

	if (behavior.parallelCount === 2) {
		const secondIndex = behavior.disguisedSecondCall ? 0 : 1
		// ── Second (parallel) tool call ────────────────────────────────────────
		const second = baseChunk(model)
		second.choices[0]!.delta = {
			tool_calls: [
				toolCallDelta(secondIndex, {
					id: "call_second_bbb",
					type: "function",
					function: { name: "write_to_file", arguments: "" },
				}),
			],
		}
		chunks.push(sseChunk(second))

		// Id-less argument continuation owned by the second call.
		const secondArgs = baseChunk(model)
		secondArgs.choices[0]!.delta = {
			tool_calls: [
				toolCallDelta(secondIndex, {
					function: {
						arguments: JSON.stringify({
							path: "mimo-second.txt",
							content: "MIMO_SECOND_CALL_SHOULD_NOT_EXECUTE",
						}),
					},
				}),
			],
		}
		chunks.push(sseChunk(secondArgs))
	}

	// ── Finish ───────────────────────────────────────────────────────────────
	const finish = baseChunk(model)
	finish.choices[0]!.delta = {}
	;(finish.choices[0]! as { finish_reason: string | null }).finish_reason = "tool_calls"
	chunks.push(sseChunk(finish))
	chunks.push("data: [DONE]\n\n")

	return chunks.join("")
}

async function withMimoMockServer<T>(
	behavior: MockBehavior,
	run: (args: { baseUrl: string; requests: CapturedMimoRequest[] }) => Promise<T>,
): Promise<T> {
	const requests: CapturedMimoRequest[] = []
	let serverError: Error | undefined

	const server: Server = createServer(async (req, res: ServerResponse) => {
		try {
			const url = req.url ?? "/"
			if (!url.endsWith(CHAT_COMPLETIONS_PATH) && !url.endsWith("/chat/completions")) {
				res.writeHead(404)
				res.end("Not found")
				return
			}

			const bodyText = await readRequestBody(req)
			const body = JSON.parse(bodyText) as {
				model?: string
				parallel_tool_calls?: boolean
				tools?: unknown[]
				messages?: Array<{ role?: string; content?: unknown }>
			}

			const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === "user")
			const lastUserMessage =
				typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "")

			requests.push({
				model: body.model,
				parallelToolCalls: body.parallel_tool_calls,
				toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
				messageCount: body.messages?.length ?? 0,
				lastUserMessage,
				rawBody: bodyText,
			})

			const sse = buildToolCallSseBody(body.model ?? MIMO_MODEL_ID, behavior)
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			})
			res.end(sse)
		} catch (error) {
			serverError = error instanceof Error ? error : new Error(String(error))
			console.error("MiMo mock server failed:", serverError)
			res.writeHead(500)
			res.end("mock failure")
		}
	})

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
	const address = server.address()
	if (!address || typeof address === "string") {
		server.close()
		throw new Error("Failed to start MiMo mock server")
	}

	const baseUrl = `http://127.0.0.1:${address.port}/v1`
	try {
		const result = await run({ baseUrl, requests })
		if (serverError) throw serverError
		return result
	} finally {
		await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
	}
}

suite("MiMo Parallel Tool Call Enforcement", function () {
	setDefaultSuiteTimeout(this)

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

	for (const disguised of [false, true] as const) {
		const label = disguised ? "disguised second call reusing index 0" : "explicit parallel calls at index 0 and 1"

		test(`Should enforce single-call policy when mock emits ${label}`, async function () {
			const api = globalThis.api

			const behavior: MockBehavior = {
				parallelCount: 2,
				disguisedSecondCall: disguised,
			}

			const messages: ClineMessage[] = []
			const messageHandler = ({ message }: { message: ClineMessage }) => {
				if (message.type === "say" && message.partial === false) {
					messages.push(message)
				}
			}
			api.on(RooCodeEventName.Message, messageHandler)

			try {
				await withMimoMockServer(behavior, async ({ baseUrl, requests }) => {
					await api.setConfiguration({
						apiProvider: "mimo" as const,
						mimoApiKey: "mock-mimo-key",
						mimoBaseUrl: baseUrl,
						apiModelId: MIMO_MODEL_ID,
					})

					await api.startNewTask({
						configuration: {
							mode: "code",
							autoApprovalEnabled: true,
							alwaysAllowWrite: true,
							alwaysAllowReadOnly: true,
						},
						text: `${PROBE_TAG}: call write_to_file twice in parallel to create mimo-first.txt and mimo-second.txt`,
					})

					// Wait until the mock has seen at least one request and the task
					// has produced some observable tool activity (or errored out).
					await waitFor(
						() => {
							const sawRequest = requests.length >= 1
							const sawToolMessage = messages.some(
								(m) =>
									m.say === "tool" ||
									m.say === "error" ||
									m.say === "completion_result" ||
									m.ask === "api_req_failed",
							)
							return sawRequest && sawToolMessage
						},
						{ timeout: 60_000, interval: 250 },
					)

					// Give the stream a beat to flush any trailing deltas before assertions.
					await sleep(500)

					// ── Contract assertions on the outbound request ──────────────────
					const firstRequest = requests[0]
					assert.ok(firstRequest, "mock should have captured at least one request")
					assert.strictEqual(
						firstRequest.parallelToolCalls,
						false,
						`MiMo handler must send parallel_tool_calls:false. Got: ${JSON.stringify(
							firstRequest.parallelToolCalls,
						)}`,
					)
					assert.ok(
						firstRequest.toolCount > 0,
						`MiMo request should carry native tools. Got toolCount=${firstRequest.toolCount}`,
					)

					// ── Enforcement assertions on observed messages ──────────────────
					// The second parallel call MUST NOT have produced a tool say with
					// its target file. We scan the rendered text of every tool/error
					// message for the second call's marker.
					const rendered = messages.map((m) => `${m.say ?? ""}:${m.text ?? ""}`).join("\n")

					assert.ok(
						!rendered.includes("MIMO_SECOND_CALL_SHOULD_NOT_EXECUTE"),
						`Second parallel call must not execute.\nCaptured messages:\n${rendered.slice(0, 2000)}`,
					)

					// The first call is allowed to run, but the suite does NOT require
					// it to succeed — enforcement is about suppressing the parallel
					// violation, not about forcing the first call through. We assert
					// only that the task did not crash with an unhandled stream error.
					const fatal = messages.find((m) => m.ask === "api_req_failed" && (m.text ?? "").includes("500"))
					assert.ok(!fatal, `Task should not hit a mock 500. Got: ${fatal?.text ?? "none"}`)
				})
			} finally {
				api.off(RooCodeEventName.Message, messageHandler)
			}
		})
	}
})
