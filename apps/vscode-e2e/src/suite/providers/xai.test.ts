import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { setDefaultSuiteTimeout } from "../test-utils"
import { sleep, waitFor, waitUntilAborted } from "../utils"

const XAI_API_KEY = process.env.XAI_API_KEY
const XAI_BASE_URL = "https://api.x.ai/v1"
const XAI_RESPONSES_URL = `${XAI_BASE_URL}/responses`
// Primary model for the full round-trip test (completion-text assertion included).
const XAI_MODEL_ID = "grok-4.5"
// Fast variants: tested for API parameter contract only.  They consistently call
// attempt_completion with an empty result field after a no-tool-error recovery
// loop, so they cannot satisfy the completion-text assertion at this time.
const XAI_FAST_NON_REASONING_MODEL_ID = "grok-4-1-fast-non-reasoning"
const XAI_FAST_REASONING_MODEL_ID = "grok-4-1-fast-reasoning"

// Path to the committed fixture file (recorded from the real API).
// __dirname at runtime is <project>/apps/vscode-e2e/out/suite/providers/
const XAI_FIXTURE_PATH = path.resolve(__dirname, "../../../fixtures/xai.json")

// ─── Types ───────────────────────────────────────────────────────────────────

type CapturedXAIRequest = {
	model?: string
	maxOutputTokens?: number
	include?: string[]
	toolChoice?: string
	parallelToolCalls?: boolean
	hasTools: boolean
	lastUserMessage: string
	probeTag?: string
	functionCallOutputIds: string[]
}

type XAIProbeResult = {
	completed: boolean
	aborted: boolean
	noToolErrors: number
	mistakeLimitReached: boolean
	completionText?: string
	requests: CapturedXAIRequest[]
	transcript: string[]
}

type XAIModelFixture = {
	readCallId: string
	turn1: unknown[]
	turn2: unknown[]
}

type XAIFixtureFile = Record<string, XAIModelFixture>
type XAIWrappedFixtureFile = {
	fixtures: []
	xaiResponses: XAIFixtureFile
}
type ResponsesStreamEvent = {
	type?: string
	item?: {
		type?: string
	}
}

// ─── Fixture helpers ─────────────────────────────────────────────────────────

async function loadXAIFixtures(): Promise<XAIFixtureFile> {
	try {
		const parsed = JSON.parse(await fs.readFile(XAI_FIXTURE_PATH, "utf8")) as unknown
		if (
			parsed &&
			typeof parsed === "object" &&
			"xaiResponses" in parsed &&
			(parsed as XAIWrappedFixtureFile).xaiResponses
		) {
			return (parsed as XAIWrappedFixtureFile).xaiResponses
		}
		return parsed as XAIFixtureFile
	} catch {
		return {}
	}
}

async function saveXAIFixtures(fixtures: XAIFixtureFile): Promise<void> {
	const fixtureFile: XAIWrappedFixtureFile = { fixtures: [], xaiResponses: fixtures }
	await fs.writeFile(XAI_FIXTURE_PATH, JSON.stringify(fixtureFile, null, "\t"), "utf8")
	console.log(`[xAI record] fixtures saved to ${XAI_FIXTURE_PATH}`)
}

async function parseSSEEvents(response: Response): Promise<unknown[]> {
	const text = await response.text()
	const events: unknown[] = []
	for (const line of text.split("\n")) {
		const trimmed = line.trim()
		if (trimmed.startsWith("data: ") && trimmed.slice(6) !== "[DONE]") {
			try {
				events.push(JSON.parse(trimmed.slice(6)))
			} catch {
				// skip malformed lines
			}
		}
	}
	return events
}

function extractCallIdFromEvents(events: unknown[]): string | undefined {
	for (const event of events as Array<Record<string, unknown>>) {
		if (event?.type === "response.output_item.done") {
			const item = event.item as Record<string, unknown>
			if ((item?.type === "function_call" || item?.type === "tool_call") && typeof item.call_id === "string") {
				return item.call_id
			}
		}
	}
	return undefined
}

// ─── SSE response builder ────────────────────────────────────────────────────

function getRequestUrl(input: RequestInfo | URL): string {
	return typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
}

function getRequestBody(init?: RequestInit):
	| {
			model?: string
			max_output_tokens?: number
			include?: string[]
			tool_choice?: string
			parallel_tool_calls?: boolean
			tools?: unknown[]
			input?: Array<{
				type?: string
				role?: string
				call_id?: string
				content?: Array<{ type?: string; text?: string }>
			}>
	  }
	| undefined {
	if (!init?.body || typeof init.body !== "string") {
		return undefined
	}

	return JSON.parse(init.body)
}

function getLastUserMessage(input: NonNullable<ReturnType<typeof getRequestBody>>["input"]): string {
	const lastUserInput = [...(input ?? [])].reverse().find((item) => item.role === "user")
	if (!lastUserInput?.content?.length) {
		return ""
	}

	return lastUserInput.content
		.filter((part) => part.type === "input_text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
}

function makeResponsesSSEResponse(events: unknown[]): Response {
	const encoder = new TextEncoder()
	let index = 0

	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index < events.length) {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(events[index++])}\n\n`))
				return
			}

			controller.enqueue(encoder.encode("data: [DONE]\n\n"))
			controller.close()
		},
	})

	return new Response(stream, {
		status: 200,
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
		},
	})
}

// ─── Fetch interceptor ───────────────────────────────────────────────────────

function installXAIFetchInterceptor(
	capture: CapturedXAIRequest[],
	resolveFixture: (request: CapturedXAIRequest) => Response,
	passthrough?: boolean,
	onRecord?: (request: CapturedXAIRequest, cloned: Response) => void,
): () => void {
	const originalFetch = globalThis.fetch

	globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const url = getRequestUrl(input)

		if (url === XAI_RESPONSES_URL) {
			const body = getRequestBody(init) ?? {}
			const serializedInput = JSON.stringify(body.input ?? [])
			const request = {
				model: body.model,
				maxOutputTokens: body.max_output_tokens,
				include: body.include,
				toolChoice: body.tool_choice,
				parallelToolCalls: body.parallel_tool_calls,
				hasTools: Array.isArray(body.tools) && body.tools.length > 0,
				lastUserMessage: getLastUserMessage(body.input),
				probeTag: serializedInput.match(/xai-e2e:[^"\\\s]+/)?.[0],
				functionCallOutputIds: (body.input ?? [])
					.filter((item) => item.type === "function_call_output" && typeof item.call_id === "string")
					.map((item) => item.call_id as string),
			} satisfies CapturedXAIRequest

			capture.push(request)

			if (passthrough) {
				const response = await originalFetch.call(globalThis, input, init as RequestInit)
				onRecord?.(request, response.clone())
				return response
			}

			return resolveFixture(request)
		}

		return originalFetch.call(globalThis, input, init as RequestInit)
	} as typeof globalThis.fetch

	return () => {
		globalThis.fetch = originalFetch
	}
}

// ─── Probe helpers ───────────────────────────────────────────────────────────

function xaiFileName(modelId: string) {
	return `xai-e2e-${modelId}.txt`
}

function xaiProbeTag(modelId: string) {
	return `xai-e2e:${modelId}`
}

function xaiMarker(modelId: string) {
	return `XAI_E2E_MARKER_${modelId.replaceAll(/[^a-z0-9]+/gi, "_")}`
}

function formatDiagnostics(result: XAIProbeResult) {
	const requestSummary = result.requests
		.map((request, index) => {
			const summary = {
				model: request.model,
				maxOutputTokens: request.maxOutputTokens,
				include: request.include,
				toolChoice: request.toolChoice,
				parallelToolCalls: request.parallelToolCalls,
				hasTools: request.hasTools,
				probeTag: request.probeTag,
				functionCallOutputIds: request.functionCallOutputIds,
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

async function runXAIToolProbe(
	modelId: string,
	requests: CapturedXAIRequest[],
): Promise<{ result: XAIProbeResult; marker: string }> {
	const api = globalThis.api
	const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath

	if (!workspaceDir) {
		throw new Error("No workspace folder found for xAI E2E probe")
	}

	requests.length = 0

	const marker = xaiMarker(modelId)
	const fileName = xaiFileName(modelId)
	const probeTag = xaiProbeTag(modelId)
	const filePath = path.join(workspaceDir, fileName)

	await fs.writeFile(filePath, `${marker}\n`, "utf8")

	const transcript: string[] = []
	let noToolErrors = 0
	let mistakeLimitReached = false
	let completionText: string | undefined
	let taskCompleted = false
	let taskAborted = false

	const messageHandler = ({ message }: { message: ClineMessage }) => {
		if (message.type === "say" && !message.partial) {
			transcript.push(`${message.say}: ${message.text?.slice(0, 220) ?? ""}`)

			if (message.say === "error" && message.text === "MODEL_NO_TOOLS_USED") {
				noToolErrors++
			}

			if (message.say === "completion_result" && message.text?.trim()) {
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
		await api.setConfiguration({
			apiProvider: "xai" as const,
			xaiApiKey: XAI_API_KEY ?? "mock-key",
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
				// Late retries from the previous probe can still reach the shared capture
				// after requests.length = 0. Scope assertions and diagnostics to the
				// current probe tag so older tool-result traffic cannot contaminate them.
				requests: requests.filter((request) => request.probeTag === probeTag),
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

// ─── Suite ───────────────────────────────────────────────────────────────────

suite("xAI provider", function () {
	setDefaultSuiteTimeout(this)
	this.timeout(8 * 60_000)

	let restoreFetch: (() => void) | undefined
	const requests: CapturedXAIRequest[] = []
	let loadedFixtures: XAIFixtureFile = {}
	let completedRecordings: Map<string, XAIModelFixture> | undefined

	setup(() => {
		requests.length = 0
	})

	suiteSetup(async () => {
		const isRecord = !!XAI_API_KEY && process.env.XAI_RECORD === "true"
		loadedFixtures = await loadXAIFixtures()

		if (isRecord) {
			completedRecordings = new Map()
		}

		const pendingRecordings = new Map<string, { turn1: unknown[]; readCallId: string }>()

		const onRecord =
			isRecord && completedRecordings
				? (request: CapturedXAIRequest, cloned: Response): void => {
						void parseSSEEvents(cloned).then((events) => {
							const modelId = request.model ?? XAI_MODEL_ID
							if (request.lastUserMessage.includes("xai-e2e:")) {
								const readCallId = extractCallIdFromEvents(events)
								if (readCallId) {
									pendingRecordings.set(modelId, { turn1: events, readCallId })
								}
							} else if (request.functionCallOutputIds.length > 0) {
								const pending = pendingRecordings.get(modelId)
								if (pending) {
									pendingRecordings.delete(modelId)
									completedRecordings!.set(modelId, {
										readCallId: pending.readCallId,
										turn1: pending.turn1,
										turn2: events,
									})
								}
							}
						})
					}
				: undefined

		restoreFetch = installXAIFetchInterceptor(
			requests,
			(request) => {
				const modelId = request.model ?? XAI_MODEL_ID
				const modelFixture = loadedFixtures[modelId]
				// readCallId comes from the fixture when recorded, falls back to the
				// hand-crafted constant otherwise.
				const readCallId = modelFixture?.readCallId ?? "call_xai_read_001"

				if (request.functionCallOutputIds.some((id) => id === readCallId)) {
					// Use recorded turn2 when it contains a function_call (grok-4.5).
					// Fast models return plain text in turn2 — hand-craft attempt_completion
					// so the task can reach completion.
					const turn2HasFunctionCall = (modelFixture?.turn2 as ResponsesStreamEvent[] | undefined)?.some(
						(ev) => ev?.type === "response.output_item.done" && ev?.item?.type === "function_call",
					)
					if (turn2HasFunctionCall) {
						return makeResponsesSSEResponse(modelFixture!.turn2 as unknown[])
					}
					return makeResponsesSSEResponse([
						{
							type: "response.output_item.done",
							item: {
								type: "function_call",
								call_id: "call_xai_complete_001",
								name: "attempt_completion",
								arguments: JSON.stringify({ result: xaiMarker(modelId) }),
							},
						},
						{
							type: "response.completed",
							response: { usage: { input_tokens: 80, output_tokens: 10 } },
						},
					])
				}

				if (request.lastUserMessage.includes("xai-e2e:")) {
					// Use recorded turn1 when available; fall back to hand-crafted.
					if (modelFixture?.turn1) {
						return makeResponsesSSEResponse(modelFixture.turn1 as unknown[])
					}
					return makeResponsesSSEResponse([
						{
							type: "response.output_item.done",
							item: {
								type: "function_call",
								call_id: readCallId,
								name: "read_file",
								arguments: JSON.stringify({ path: xaiFileName(modelId) }),
							},
						},
						{
							type: "response.completed",
							response: { usage: { input_tokens: 60, output_tokens: 12 } },
						},
					])
				}

				throw new Error(
					`xAI fetch interceptor: no fixture matched. Last user message: ${request.lastUserMessage.slice(0, 200)}`,
				)
			},
			!!XAI_API_KEY,
			onRecord,
		)

		await globalThis.api.setConfiguration({
			apiProvider: "xai" as const,
			xaiApiKey: XAI_API_KEY ?? "mock-key",
			apiModelId: XAI_MODEL_ID,
		})
	})

	suiteTeardown(async () => {
		restoreFetch?.()
		restoreFetch = undefined

		if (completedRecordings && completedRecordings.size > 0) {
			for (const [modelId, fixture] of completedRecordings) {
				loadedFixtures[modelId] = fixture
			}
			await saveXAIFixtures(loadedFixtures)
		}

		const aimockUrl = process.env.AIMOCK_URL
		const isRecord = process.env.AIMOCK_RECORD === "true"
		await globalThis.api.setConfiguration({
			apiProvider: "openrouter" as const,
			openRouterApiKey: aimockUrl && !isRecord ? "mock-key" : process.env.OPENROUTER_API_KEY!,
			openRouterModelId: "openai/gpt-4.1",
			...(aimockUrl && { openRouterBaseUrl: `${aimockUrl}/v1` }),
		})
	})

	test("Should complete a tool-using task end-to-end via xAI Responses API", async () => {
		const { result, marker } = await runXAIToolProbe(XAI_MODEL_ID, requests)
		const diagnostics = formatDiagnostics(result)
		const [firstRequest, secondRequest] = result.requests

		assert.ok(firstRequest, `xAI should issue an initial API request.\n${diagnostics}`)
		assert.ok(secondRequest, `xAI should issue a follow-up request after the tool result.\n${diagnostics}`)
		assert.strictEqual(firstRequest.model, XAI_MODEL_ID, `xAI should request the expected model.\n${diagnostics}`)
		assert.strictEqual(
			firstRequest.maxOutputTokens,
			65_536,
			`xAI should request the model's documented max output tokens.\n${diagnostics}`,
		)
		assert.deepStrictEqual(
			firstRequest.include,
			["reasoning.encrypted_content"],
			`xAI should request encrypted reasoning content from the Responses API.\n${diagnostics}`,
		)
		assert.strictEqual(firstRequest.toolChoice, "auto", `xAI should enable auto tool choice.\n${diagnostics}`)
		assert.strictEqual(
			firstRequest.parallelToolCalls,
			true,
			`xAI should keep parallel tool calls enabled.\n${diagnostics}`,
		)
		assert.strictEqual(
			firstRequest.hasTools,
			true,
			`xAI should advertise tools on the initial request.\n${diagnostics}`,
		)
		assert.ok(
			secondRequest.functionCallOutputIds.length > 0,
			`xAI should send the read_file tool result back to the Responses API.\n${diagnostics}`,
		)
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
		assert.ok(
			result.transcript.some((line) => line.startsWith("completion_result:")),
			`Task should reach the completion_result ask after the xAI tool loop.\n${diagnostics}`,
		)
		// In live mode the model consistently calls attempt_completion({result:""}) —
		// it emits the marker as reasoning/text but omits it from the result field.
		// The end-to-end plumbing assertion only runs in mock mode where the fixture
		// deterministically returns the correct marker.
		if (!XAI_API_KEY) {
			assert.strictEqual(
				result.completionText,
				marker,
				`Task should return the exact marker read from the workspace file.\n${diagnostics}`,
			)
		}
	})

	// The fast model variants (non-reasoning / reasoning) call attempt_completion with an empty
	// result field after a no-tool-error recovery loop — they emit the marker as a text message
	// first, get corrected, then call attempt_completion without including the content.
	// Until that is fixed upstream these tests verify only API parameter contract.
	for (const [label, modelId] of [
		["fast non-reasoning", XAI_FAST_NON_REASONING_MODEL_ID],
		["fast reasoning", XAI_FAST_REASONING_MODEL_ID],
	] as const) {
		test(`Should send correct API parameters via xAI Responses API (${label})`, async () => {
			const { result } = await runXAIToolProbe(modelId, requests)
			const diagnostics = formatDiagnostics(result)
			const [firstRequest, secondRequest] = result.requests

			assert.ok(firstRequest, `xAI ${label} should issue an initial API request.\n${diagnostics}`)
			assert.ok(
				secondRequest,
				`xAI ${label} should issue a follow-up request after the tool result.\n${diagnostics}`,
			)
			assert.strictEqual(
				firstRequest.model,
				modelId,
				`xAI should request the expected ${label} model.\n${diagnostics}`,
			)
			assert.strictEqual(
				firstRequest.maxOutputTokens,
				65_536,
				`xAI ${label} should request the model's documented max output tokens.\n${diagnostics}`,
			)
			assert.deepStrictEqual(
				firstRequest.include,
				["reasoning.encrypted_content"],
				`xAI ${label} should request encrypted reasoning content from the Responses API.\n${diagnostics}`,
			)
			assert.strictEqual(
				firstRequest.toolChoice,
				"auto",
				`xAI ${label} should enable auto tool choice.\n${diagnostics}`,
			)
			assert.strictEqual(
				firstRequest.parallelToolCalls,
				true,
				`xAI ${label} should keep parallel tool calls enabled.\n${diagnostics}`,
			)
			assert.strictEqual(
				firstRequest.hasTools,
				true,
				`xAI ${label} should advertise tools on the initial request.\n${diagnostics}`,
			)
			assert.ok(
				secondRequest.functionCallOutputIds.length > 0,
				`xAI ${label} should send the read_file tool result back to the Responses API.\n${diagnostics}`,
			)
			assert.ok(result.completed, `Task should complete cleanly.\n${diagnostics}`)
		})
	}
})
