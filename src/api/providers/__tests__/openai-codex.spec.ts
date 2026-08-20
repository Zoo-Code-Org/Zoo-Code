// npx vitest run api/providers/__tests__/openai-codex.spec.ts

vitest.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureException: vitest.fn(),
		},
	},
}))

import { Anthropic } from "@anthropic-ai/sdk"
import { OPEN_AI_CODEX_SERVICE_TIER_KEY, OpenAiCodexServiceTier, SERVICE_TIER_KEY } from "@roo-code/types"
import { OpenAiCodexHandler, transformLunaResponsesLiteBody } from "../openai-codex"
import { openAiCodexOAuthManager } from "../../../integrations/openai-codex/oauth"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"

function createCompletedStream() {
	return asyncStreamFrom([
		{
			type: "response.completed",
			response: {
				id: "response-1",
				status: "completed",
				output: [],
				usage: { input_tokens: 1, output_tokens: 1 },
			},
		},
	])
}

describe("OpenAiCodexHandler.getModel", () => {
	it.each(["gpt-5.1", "gpt-5", "gpt-5.1-codex", "gpt-5-codex", "gpt-5-codex-mini", "gpt-5.3-codex-spark"])(
		"should return specified model when a valid model id is provided: %s",
		(apiModelId) => {
			const handler = new OpenAiCodexHandler({ apiModelId })
			const model = handler.getModel()

			expect(model.id).toBe(apiModelId)
			expect(model.info).toBeDefined()
			// Default reasoning effort for GPT-5 family
			expect(model.info.reasoningEffort).toBe("medium")
		},
	)

	it("should fall back to default model when an invalid model id is provided", () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "not-a-real-model" })
		const model = handler.getModel()

		expect(model.id).toBe("gpt-5.6-sol")
		expect(model.info).toBeDefined()
	})

	it("should use Spark-specific limits and capabilities", () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.3-codex-spark" })
		const model = handler.getModel()

		expect(model.id).toBe("gpt-5.3-codex-spark")
		expect(model.info.contextWindow).toBe(128000)
		expect(model.info.maxTokens).toBe(8192)
		expect(model.info.supportsImages).toBe(false)
	})

	it("should use GPT-5.4 Mini capabilities when selected", () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.4-mini" })
		const model = handler.getModel()

		expect(model.id).toBe("gpt-5.4-mini")
		expect(model.info).toBeDefined()
	})
})

describe("OpenAiCodexHandler.createMessage", () => {
	afterEach(() => {
		vitest.restoreAllMocks()
		vitest.unstubAllGlobals()
	})

	it("sends the priority service tier in streaming SDK requests when Fast is selected", async () => {
		const handler = new OpenAiCodexHandler({
			apiModelId: "gpt-5.6-sol",
			[OPEN_AI_CODEX_SERVICE_TIER_KEY]: OpenAiCodexServiceTier.Priority,
		})
		vitest.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vitest.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		const mockCreate = vitest.fn().mockResolvedValue(createCompletedStream())
		Reflect.set(handler, "client", { responses: { create: mockCreate } })

		await collectStream(handler.createMessage("System prompt", []))

		const [body] = mockCreate.mock.calls[0]
		expect(body).toMatchObject({
			stream: true,
			[SERVICE_TIER_KEY]: OpenAiCodexServiceTier.Priority,
		})
	})

	it.each([
		["an absent preference", {}],
		[
			"an explicit Standard preference from an older profile",
			{ [OPEN_AI_CODEX_SERVICE_TIER_KEY]: OpenAiCodexServiceTier.Default },
		],
	])("omits the service tier in streaming SDK requests for %s", async (_description, serviceTierOptions) => {
		const handler = new OpenAiCodexHandler({
			apiModelId: "gpt-5.6-sol",
			...serviceTierOptions,
		} as ConstructorParameters<typeof OpenAiCodexHandler>[0])
		vitest.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vitest.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		const mockCreate = vitest.fn().mockResolvedValue(createCompletedStream())
		Reflect.set(handler, "client", { responses: { create: mockCreate } })

		await collectStream(handler.createMessage("System prompt", []))

		expect(mockCreate.mock.calls[0][0]).not.toHaveProperty(SERVICE_TIER_KEY)
	})

	it("preserves the priority service tier in the manual streaming fallback", async () => {
		const handler = new OpenAiCodexHandler({
			apiModelId: "gpt-5.6-sol",
			[OPEN_AI_CODEX_SERVICE_TIER_KEY]: OpenAiCodexServiceTier.Priority,
		})
		vitest.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vitest.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		Reflect.set(handler, "client", {
			responses: { create: vitest.fn().mockRejectedValue(new Error("SDK unavailable")) },
		})
		const mockFetch = vitest.fn().mockResolvedValue({
			ok: true,
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(
						new TextEncoder().encode(
							'data: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
						),
					)
					controller.close()
				},
			}),
		})
		vitest.stubGlobal("fetch", mockFetch)

		await collectStream(handler.createMessage("System prompt", []))

		expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toMatchObject({
			stream: true,
			[SERVICE_TIER_KEY]: OpenAiCodexServiceTier.Priority,
		})
	})

	it("should skip URL-sourced images in formatFullConversation (only base64 emits input_image)", async () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1-codex" })

		vitest.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vitest.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")

		const capturedInput: any[] = []
		;(handler as any).client = {
			responses: {
				create: vitest.fn().mockImplementation(async (body: any) => {
					capturedInput.push(...(body.input ?? []))
					return asyncStreamFrom([
						{
							type: "response.completed",
							response: {
								id: "r1",
								status: "completed",
								output: [],
								usage: { input_tokens: 1, output_tokens: 1 },
							},
						},
					])
				}),
			},
		}

		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "Look at this:" },
					{ type: "image", source: { type: "url", url: "https://example.com/img.png" } as any },
				],
			},
		]

		await collectStream(handler.createMessage("system", messages))

		// URL image is skipped; only the text input_text block should be present
		const userMsg = capturedInput.find((item: any) => item.role === "user")
		expect(userMsg?.content).toEqual([{ type: "input_text", text: "Look at this:" }])
		expect(JSON.stringify(capturedInput)).not.toContain("input_image")
	})

	it("should emit input_image for base64 images in formatFullConversation", async () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1-codex" })

		vitest.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vitest.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")

		const capturedInput: any[] = []
		;(handler as any).client = {
			responses: {
				create: vitest.fn().mockImplementation(async (body: any) => {
					capturedInput.push(...(body.input ?? []))
					return asyncStreamFrom([
						{
							type: "response.completed",
							response: {
								id: "r1",
								status: "completed",
								output: [],
								usage: { input_tokens: 1, output_tokens: 1 },
							},
						},
					])
				}),
			},
		}

		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "Look at this:" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
				],
			},
		]

		await collectStream(handler.createMessage("system", messages))

		const userMsg = capturedInput.find((item: any) => item.role === "user")
		expect(userMsg?.content).toContainEqual({
			type: "input_image",
			image_url: "data:image/png;base64,abc123",
		})
	})
})

describe("OpenAiCodexHandler.completePrompt service tier", () => {
	afterEach(() => {
		vitest.restoreAllMocks()
		vitest.unstubAllGlobals()
	})

	it.each<[string, OpenAiCodexServiceTier | undefined, typeof OpenAiCodexServiceTier.Priority | undefined]>([
		["Fast", OpenAiCodexServiceTier.Priority, OpenAiCodexServiceTier.Priority],
		["Standard", undefined, undefined],
	])("uses the %s preference in completion requests", async (_mode, configuredTier, expectedTier) => {
		const handler = new OpenAiCodexHandler({
			apiModelId: "gpt-5.6-sol",
			...(configuredTier ? { [OPEN_AI_CODEX_SERVICE_TIER_KEY]: configuredTier } : {}),
		})
		vitest.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vitest.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		const create = vitest.fn().mockResolvedValue(
			asyncStreamFrom([
				{ type: "response.output_text.delta", delta: "Complete" },
				{ type: "response.completed", response: { id: "r1", status: "completed", output: [] } },
			]),
		)
		Reflect.set(handler, "client", { responses: { create } })

		await expect(handler.completePrompt("Hello")).resolves.toBe("Complete")

		const body = create.mock.calls[0][0]
		// The Codex subscription endpoint rejects `stream: false` outright.
		expect(body.stream).toBe(true)
		if (expectedTier) {
			expect(body[SERVICE_TIER_KEY]).toBe(expectedTier)
		} else {
			expect(body).not.toHaveProperty(SERVICE_TIER_KEY)
		}
	})
})

describe("OpenAiCodexHandler.completePrompt streaming", () => {
	function createHandler() {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.6-sol" })
		vitest.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vitest.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		return handler
	}

	function injectStream(handler: OpenAiCodexHandler, events: unknown[]) {
		const create = vitest.fn().mockResolvedValue(asyncStreamFrom(events))
		Reflect.set(handler, "client", { responses: { create } })
		return create
	}

	afterEach(() => {
		vitest.restoreAllMocks()
		vitest.unstubAllGlobals()
	})

	it("joins consecutive text deltas into one string", async () => {
		const handler = createHandler()
		injectStream(handler, [
			{ type: "response.output_text.delta", delta: "feat: " },
			{ type: "response.output_text.delta", delta: "add commit messages" },
			{ type: "response.completed", response: { id: "r1", status: "completed", output: [] } },
		])

		await expect(handler.completePrompt("Hello")).resolves.toBe("feat: add commit messages")
	})

	// The enhanced prompt is written straight into the input box, so reasoning must never become
	// part of it.
	it("omits reasoning from the completion", async () => {
		const handler = createHandler()
		injectStream(handler, [
			{ type: "response.reasoning_summary_text.delta", delta: "Thinking about the diff" },
			{ type: "response.output_text.delta", delta: "fix: correct the parser" },
			{ type: "response.completed", response: { id: "r1", status: "completed", output: [] } },
		])

		const result = await handler.completePrompt("Hello")

		expect(result).toBe("fix: correct the parser")
		expect(result).not.toContain("Thinking")
	})

	it("omits usage and tool calls from the completion", async () => {
		const handler = createHandler()
		injectStream(handler, [
			{ type: "response.output_text.delta", delta: "chore: tidy" },
			{
				type: "response.output_item.done",
				item: { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{}" },
			},
			{
				type: "response.completed",
				response: {
					id: "r1",
					status: "completed",
					output: [],
					usage: { input_tokens: 10, output_tokens: 5 },
				},
			},
		])

		await expect(handler.completePrompt("Hello")).resolves.toBe("chore: tidy")
	})

	// A refusal is streamed as text so the chat can show it, but the non-streaming request this
	// replaced read `output_text`, which never carries refusals. Keeping them would paste
	// "[Refusal] ..." into the prompt enhancer's input box as if the model had answered.
	it("omits refusals from the completion", async () => {
		const handler = createHandler()
		injectStream(handler, [
			{ type: "response.refusal.delta", delta: "I cannot help " },
			{ type: "response.refusal.delta", delta: "with that request." },
			{ type: "response.completed", response: { id: "r1", status: "completed", output: [] } },
		])

		await expect(handler.completePrompt("Hello")).resolves.toBe("")
	})

	it("keeps the answer when a refusal arrives alongside output text", async () => {
		const handler = createHandler()
		injectStream(handler, [
			{ type: "response.output_text.delta", delta: "docs: update the readme" },
			{ type: "response.refusal.delta", delta: "I cannot help with the rest." },
			{ type: "response.completed", response: { id: "r1", status: "completed", output: [] } },
		])

		await expect(handler.completePrompt("Hello")).resolves.toBe("docs: update the readme")
	})

	// The SSE transport parses its own events, so it has a second refusal branch to keep aligned.
	it("omits refusals streamed over the SSE fallback", async () => {
		const handler = createHandler()
		Reflect.set(handler, "client", {
			responses: { create: vitest.fn().mockRejectedValue(new Error("SDK unavailable")) },
		})
		vitest.stubGlobal(
			"fetch",
			vitest.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.refusal.delta","delta":"I cannot help with that."}\n\n',
							),
						)
						controller.close()
					},
				}),
			}),
		)

		await expect(handler.completePrompt("Hello")).resolves.toBe("")
	})

	// Dropping the refusal is specific to the one-shot completion: a chat still has to show it.
	it("still surfaces refusals to the chat stream", async () => {
		const handler = createHandler()
		injectStream(handler, [
			{ type: "response.refusal.delta", delta: "I cannot help with that." },
			{ type: "response.completed", response: { id: "r1", status: "completed", output: [] } },
		])

		const chunks = await collectStream(handler.createMessage("system", [{ role: "user", content: "Hello" }]))

		expect(chunks).toContainEqual({ type: "text", text: "[Refusal] I cannot help with that." })
	})

	// The SDK path swallows its own errors into the SSE fallback, so an auth failure only reaches
	// the retry loop from the fallback - the same shape the streaming Luna retry test relies on.
	it("retries once with a refreshed token when the first attempt is unauthorized", async () => {
		const handler = createHandler()
		const refresh = vitest
			.spyOn(openAiCodexOAuthManager, "forceRefreshAccessToken")
			.mockResolvedValue("fresh-token")
		Reflect.set(handler, "client", {
			responses: { create: vitest.fn().mockRejectedValue(new Error("SDK unavailable")) },
		})
		const mockFetch = vitest
			.fn()
			.mockResolvedValueOnce({
				ok: false,
				status: 401,
				text: vitest.fn().mockResolvedValue('{"error":{"message":"Codex API invalid token"}}'),
			})
			.mockResolvedValueOnce({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.output_text.delta","delta":"docs: update"}\n\n',
							),
						)
						controller.close()
					},
				}),
			})
		vitest.stubGlobal("fetch", mockFetch)

		await expect(handler.completePrompt("Hello")).resolves.toBe("docs: update")
		expect(refresh).toHaveBeenCalled()
		expect(mockFetch).toHaveBeenCalledTimes(2)
	})

	// The caller's signal is linked to the internal controller rather than passed through, so what
	// matters is that aborting the caller's one aborts the signal the request is actually using.
	// The stream then ends quietly, so rejecting is the only thing that tells the caller apart a
	// cancelled generation from a finished one.
	it("rejects and stops the request when cancelled mid-stream", async () => {
		const handler = createHandler()
		const controller = new AbortController()
		let signalDuringRequest: AbortSignal | undefined

		const create = vitest.fn().mockImplementation((_body: unknown, options: { signal: AbortSignal }) => {
			signalDuringRequest = options.signal
			// Abort mid-flight, while `executeRequest`'s listener is still attached.
			controller.abort()
			return Promise.resolve(
				asyncStreamFrom([
					{ type: "response.output_text.delta", delta: "feat: half a" },
					{ type: "response.completed", response: { id: "r1", status: "completed", output: [] } },
				]),
			)
		})
		Reflect.set(handler, "client", { responses: { create } })

		await expect(handler.completePrompt("Hello", { abortSignal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		})

		expect(signalDuringRequest).toBeInstanceOf(AbortSignal)
		expect(signalDuringRequest!.aborted).toBe(true)
	})

	it("rejects when the caller's signal is already aborted", async () => {
		const handler = createHandler()
		const create = injectStream(handler, [
			{ type: "response.completed", response: { id: "r1", status: "completed", output: [] } },
		])

		await expect(handler.completePrompt("Hello", { abortSignal: AbortSignal.abort() })).rejects.toMatchObject({
			name: "AbortError",
		})

		expect(create.mock.calls[0][1].signal.aborted).toBe(true)
	})

	// The SSE fallback is for an SDK that could not be used at all. Replaying the request after the
	// SDK has already produced output would append a second generation to the first.
	it("does not replay over SSE when the SDK fails after emitting", async () => {
		const handler = createHandler()
		const create = vitest.fn().mockResolvedValue(
			(async function* () {
				yield { type: "response.output_text.delta", delta: "feat: add" }
				throw new Error("stream broke")
			})(),
		)
		Reflect.set(handler, "client", { responses: { create } })
		const mockFetch = vitest.fn()
		vitest.stubGlobal("fetch", mockFetch)

		await expect(handler.completePrompt("Hello")).rejects.toThrow(/completionError|stream broke/)
		expect(mockFetch).not.toHaveBeenCalled()
	})

	// The service has accepted the request by the time it emits, so refreshing the token and
	// sending it again would bill a second generation and hand the caller both.
	it("does not retry with a refreshed token when the SDK fails after emitting", async () => {
		const handler = createHandler()
		const refresh = vitest.spyOn(openAiCodexOAuthManager, "forceRefreshAccessToken")
		const create = vitest.fn().mockResolvedValue(
			(async function* () {
				yield { type: "response.output_text.delta", delta: "feat: add" }
				throw new Error("Codex API invalid token")
			})(),
		)
		Reflect.set(handler, "client", { responses: { create } })
		const mockFetch = vitest.fn()
		vitest.stubGlobal("fetch", mockFetch)

		await expect(handler.completePrompt("Hello")).rejects.toThrow(/completionError|invalid token/)
		expect(refresh).not.toHaveBeenCalled()
		expect(create).toHaveBeenCalledTimes(1)
		expect(mockFetch).not.toHaveBeenCalled()
	})

	// An abort is not a transport failure, so spending a second request on an already-aborted
	// signal only turns the cancellation into a connection error.
	it("does not fall back to SSE when the SDK fails because the caller aborted", async () => {
		const handler = createHandler()
		const create = vitest.fn().mockRejectedValue(new Error("Request was aborted"))
		Reflect.set(handler, "client", { responses: { create } })
		const mockFetch = vitest.fn()
		vitest.stubGlobal("fetch", mockFetch)

		await expect(handler.completePrompt("Hello", { abortSignal: AbortSignal.abort() })).rejects.toMatchObject({
			name: "AbortError",
		})
		expect(mockFetch).not.toHaveBeenCalled()
	})

	// The abort arrives while the request is still in flight, before any event, which is the case
	// that only works if the caller's signal is genuinely linked to the internal controller. A
	// broken link would leave the request hanging on a signal that never fires.
	it("aborts the in-flight request when the caller cancels before any event", async () => {
		const handler = createHandler()
		const controller = new AbortController()
		let signalDuringRequest: AbortSignal | undefined

		const create = vitest.fn().mockImplementation(
			(_body: unknown, options: { signal: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					signalDuringRequest = options.signal
					// Reject the way the SDK does once the signal it was handed aborts.
					options.signal.addEventListener("abort", () => reject(new Error("Request was aborted")), {
						once: true,
					})
				}),
		)
		Reflect.set(handler, "client", { responses: { create } })
		const mockFetch = vitest.fn()
		vitest.stubGlobal("fetch", mockFetch)

		const completion = handler.completePrompt("Hello", { abortSignal: controller.signal })
		// The token lookup and the listener that links the two signals are both async, so aborting
		// synchronously here would fire before anything is listening.
		await vitest.waitFor(() => expect(create).toHaveBeenCalled())
		controller.abort()

		await expect(completion).rejects.toMatchObject({ name: "AbortError" })
		expect(signalDuringRequest!.aborted).toBe(true)
		expect(mockFetch).not.toHaveBeenCalled()
	})

	it("wraps failures from both transports as a completion error", async () => {
		const handler = createHandler()
		const create = vitest.fn().mockRejectedValue(new Error("sdk down"))
		Reflect.set(handler, "client", { responses: { create } })
		vitest.stubGlobal("fetch", vitest.fn().mockRejectedValue(new Error("network down")))

		await expect(handler.completePrompt("Hello")).rejects.toThrow(/completionError|network down/)
	})
})

describe("transformLunaResponsesLiteBody", () => {
	it("creates the exact Responses Lite body while preserving unrelated fields and reasoning", () => {
		const tools = [{ type: "function", name: "read_file", parameters: { type: "object" } }]
		const input = [
			{
				role: "user",
				content: [
					{ type: "input_text", text: "Inspect the image", detail: "keep-text-detail" },
					{
						type: "input_image",
						image_url: "data:image/png;base64,abc",
						detail: "high",
						metadata: { detail: "keep-nested-detail" },
					},
				],
				detail: "keep-message-detail",
			},
			{
				type: "wrapper",
				detail: "keep-wrapper-detail",
				items: [{ type: "input_image", image_url: "nested", detail: "low", extra: true }],
			},
		]
		const body = {
			model: "gpt-5.6-luna",
			input,
			stream: true,
			store: false,
			instructions: "Follow these exact instructions.",
			tools,
			tool_choice: { type: "function", name: "read_file" },
			parallel_tool_calls: true,
			reasoning: { effort: "high", summary: "auto" },
			include: ["reasoning.encrypted_content"],
			custom_field: { preserved: true },
		}

		expect(transformLunaResponsesLiteBody(body, "task-123")).toEqual({
			model: "gpt-5.6-luna",
			input: [
				{ type: "additional_tools", role: "developer", tools },
				{
					type: "message",
					role: "developer",
					content: [{ type: "input_text", text: "Follow these exact instructions." }],
				},
				{
					role: "user",
					content: [
						{ type: "input_text", text: "Inspect the image", detail: "keep-text-detail" },
						{
							type: "input_image",
							image_url: "data:image/png;base64,abc",
							metadata: { detail: "keep-nested-detail" },
						},
					],
					detail: "keep-message-detail",
				},
				{
					type: "wrapper",
					detail: "keep-wrapper-detail",
					items: [{ type: "input_image", image_url: "nested", extra: true }],
				},
			],
			stream: true,
			store: false,
			tool_choice: "auto",
			parallel_tool_calls: false,
			prompt_cache_key: "task-123",
			reasoning: { effort: "high", summary: "auto", context: "all_turns" },
			include: ["reasoning.encrypted_content"],
			custom_field: { preserved: true },
		})
	})

	it("uses empty additional tools, omits an empty instruction message, and creates reasoning context", () => {
		const input = [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }]

		expect(
			transformLunaResponsesLiteBody(
				{
					model: "gpt-5.6-luna",
					input,
					instructions: "",
					stream: false,
				},
				"session-fallback",
			),
		).toEqual({
			model: "gpt-5.6-luna",
			input: [{ type: "additional_tools", role: "developer", tools: [] }, ...input],
			stream: false,
			tool_choice: "auto",
			parallel_tool_calls: false,
			prompt_cache_key: "session-fallback",
			reasoning: { context: "all_turns" },
		})
	})

	it("overwrites a pre-existing reasoning context with all_turns", () => {
		const result = transformLunaResponsesLiteBody(
			{
				model: "gpt-5.6-luna",
				input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
				reasoning: { effort: "high", context: "current_turn" },
			},
			"session-1",
		)

		expect(result.reasoning).toEqual({ effort: "high", context: "all_turns" })
	})

	it.each([
		["input", { input: "invalid" }, "input must be an array"],
		["tools", { input: [], tools: {} }, "tools must be an array when provided"],
		["instructions", { input: [], instructions: [] }, "instructions must be a string when provided"],
	])("rejects malformed %s locally", (_field, body, expectedMessage) => {
		expect(() => transformLunaResponsesLiteBody(body, "session-1")).toThrow(expectedMessage)
	})
})

describe("OpenAiCodexHandler Luna Responses Lite requests", () => {
	afterEach(() => {
		vitest.restoreAllMocks()
		vitest.unstubAllGlobals()
	})

	it("uses a single task session ID in the Luna SDK body and headers", async () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.6-luna", reasoningEffort: "high" })
		vitest.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vitest.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		const mockCreate = vitest.fn().mockResolvedValue(createCompletedStream())
		;(handler as any).client = { responses: { create: mockCreate } }

		await collectStream(
			handler.createMessage("Luna instructions", [{ role: "user", content: "Hello" }], {
				taskId: "task-luna",
				tools: [
					{
						type: "function",
						function: {
							name: "read_file",
							description: "Read a file",
							parameters: { type: "object", properties: { path: { type: "string" } } },
						},
					},
				],
				tool_choice: { type: "function", function: { name: "read_file" } },
				parallelToolCalls: true,
			}),
		)

		const [body, options] = mockCreate.mock.calls[0]
		expect(body).toMatchObject({
			model: "gpt-5.6-luna",
			prompt_cache_key: "task-luna",
			tool_choice: "auto",
			parallel_tool_calls: false,
			reasoning: { effort: "high", summary: "auto", context: "all_turns" },
		})
		expect(body).not.toHaveProperty("tools")
		expect(body).not.toHaveProperty("instructions")
		expect(body.input).toHaveLength(3)
		expect(body.input[0]).toMatchObject({ type: "additional_tools", role: "developer" })
		expect(body.input[1]).toEqual({
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text: "Luna instructions" }],
		})
		expect(body.input[2]).toEqual({
			role: "user",
			content: [{ type: "input_text", text: "Hello" }],
		})
		expect(options.headers).toMatchObject({
			originator: "zoo-code",
			session_id: "task-luna",
			"session-id": "task-luna",
			"x-session-affinity": "task-luna",
			version: "0.144.0",
			"x-openai-internal-codex-responses-lite": "true",
			"ChatGPT-Account-Id": "acct_test",
		})
	})

	it("reuses the unchanged Luna body and headers in the manual SSE fallback", async () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.6-luna" })
		vitest.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vitest.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		let sdkBody: any
		const mockCreate = vitest.fn().mockImplementation((body: any) => {
			sdkBody = body
			throw new Error("SDK unavailable")
		})
		;(handler as any).client = { responses: { create: mockCreate } }
		const mockFetch = vitest.fn().mockResolvedValue({
			ok: true,
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(
						new TextEncoder().encode(
							'data: {"type":"response.completed","response":{"id":"response-1","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
						),
					)
					controller.close()
				},
			}),
		})
		vitest.stubGlobal("fetch", mockFetch)

		await collectStream(
			handler.createMessage("Instructions", [{ role: "user", content: "Fallback" }], {
				taskId: "task-fallback",
				tools: [],
			}),
		)

		const fetchOptions = mockFetch.mock.calls[0][1]
		expect(JSON.parse(fetchOptions.body)).toEqual(sdkBody)
		expect(fetchOptions.headers).toMatchObject({
			Authorization: "Bearer test-token",
			session_id: "task-fallback",
			"session-id": "task-fallback",
			"x-session-affinity": "task-fallback",
			version: "0.144.0",
			"x-openai-internal-codex-responses-lite": "true",
		})
		expect(sdkBody.prompt_cache_key).toBe("task-fallback")
	})

	it("preserves Luna session affinity while retrying with refreshed authentication", async () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.6-luna" })
		const transformSpy = vitest.spyOn(handler as any, "buildLunaRequestBody")
		vitest.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("expired-token")
		vitest.spyOn(openAiCodexOAuthManager, "forceRefreshAccessToken").mockResolvedValue("refreshed-token")
		vitest.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		;(handler as any).client = {
			responses: { create: vitest.fn().mockRejectedValue(new Error("SDK unavailable")) },
		}
		const mockFetch = vitest
			.fn()
			.mockResolvedValueOnce({
				ok: false,
				status: 401,
				text: vitest.fn().mockResolvedValue('{"error":{"message":"Codex API invalid token"}}'),
			})
			.mockResolvedValueOnce({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.completed","response":{"id":"response-1","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
							),
						)
						controller.close()
					},
				}),
			})
		vitest.stubGlobal("fetch", mockFetch)

		await collectStream(
			handler.createMessage("Instructions", [{ role: "user", content: "Retry" }], {
				taskId: "task-retry",
				tools: [],
			}),
		)

		expect(openAiCodexOAuthManager.forceRefreshAccessToken).toHaveBeenCalledOnce()
		expect(mockFetch).toHaveBeenCalledTimes(2)
		const firstOptions = mockFetch.mock.calls[0][1]
		const retryOptions = mockFetch.mock.calls[1][1]
		const firstBody = JSON.parse(firstOptions.body)
		const retryBody = JSON.parse(retryOptions.body)

		expect(retryBody).toEqual(firstBody)
		expect(transformSpy).toHaveBeenCalledTimes(1)
		expect(firstBody.prompt_cache_key).toBe("task-retry")
		expect(firstOptions.headers).toMatchObject({
			Authorization: "Bearer expired-token",
			"session-id": "task-retry",
			"x-session-affinity": "task-retry",
			version: "0.144.0",
			"x-openai-internal-codex-responses-lite": "true",
		})
		expect(retryOptions.headers).toMatchObject({
			Authorization: "Bearer refreshed-token",
			"session-id": "task-retry",
			"x-session-affinity": "task-retry",
			version: "0.144.0",
			"x-openai-internal-codex-responses-lite": "true",
		})
	})

	it.each(["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna-alias"])(
		"does not apply Luna behavior to %s",
		async (apiModelId) => {
			const handler = new OpenAiCodexHandler({ apiModelId })
			vitest.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
			vitest.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
			const mockCreate = vitest.fn().mockResolvedValue(createCompletedStream())
			;(handler as any).client = { responses: { create: mockCreate } }

			await collectStream(
				handler.createMessage("Normal instructions", [{ role: "user", content: "Hello" }], {
					taskId: "task-normal",
					tools: [],
					tool_choice: "required",
					parallelToolCalls: true,
				}),
			)

			const [body, options] = mockCreate.mock.calls[0]
			expect(body.instructions).toBe("Normal instructions")
			expect(body.tools).toEqual([])
			expect(body.tool_choice).toBe("required")
			expect(body.parallel_tool_calls).toBe(true)
			expect(body).not.toHaveProperty("prompt_cache_key")
			expect(body.reasoning?.context).toBeUndefined()
			expect(options.headers).not.toHaveProperty("session-id")
			expect(options.headers).not.toHaveProperty("x-session-affinity")
			expect(options.headers).not.toHaveProperty("version")
			expect(options.headers).not.toHaveProperty("x-openai-internal-codex-responses-lite")
		},
	)

	it("uses the handler session for reasoning-disabled Luna completePrompt requests", async () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.6-luna", reasoningEffort: "disable" })
		vitest.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vitest.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		// Forcing the SDK path to fail exercises the SSE fallback, which is where the request body
		// and the Codex-specific headers are assembled by hand.
		Reflect.set(handler, "client", {
			responses: { create: vitest.fn().mockRejectedValue(new Error("SDK unavailable")) },
		})
		const mockFetch = vitest.fn().mockResolvedValue({
			ok: true,
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(
						new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"Complete"}\n\n'),
					)
					controller.close()
				},
			}),
		})
		vitest.stubGlobal("fetch", mockFetch)

		await expect(handler.completePrompt("Hello Luna")).resolves.toBe("Complete")

		const fetchOptions = mockFetch.mock.calls[0][1]
		const body = JSON.parse(fetchOptions.body)
		const sessionId = body.prompt_cache_key
		expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
		expect(body).toMatchObject({
			model: "gpt-5.6-luna",
			stream: true,
			tool_choice: "auto",
			parallel_tool_calls: false,
			reasoning: { context: "all_turns" },
		})
		expect(body).not.toHaveProperty("include")
		expect(body.input).toEqual([
			{ type: "additional_tools", role: "developer", tools: [] },
			{ role: "user", content: [{ type: "input_text", text: "Hello Luna" }] },
		])
		expect(fetchOptions.headers).toMatchObject({
			session_id: sessionId,
			"session-id": sessionId,
			"x-session-affinity": sessionId,
			version: "0.144.0",
			"x-openai-internal-codex-responses-lite": "true",
		})
	})
})
