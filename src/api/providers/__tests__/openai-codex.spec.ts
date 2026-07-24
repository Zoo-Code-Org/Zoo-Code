// npx vitest run api/providers/__tests__/openai-codex.spec.ts

vitest.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureException: vitest.fn(),
		},
	},
}))

import { Anthropic } from "@anthropic-ai/sdk"
import { OpenAiCodexHandler, transformLunaResponsesLiteBody } from "../openai-codex"
import { openAiCodexOAuthManager } from "../../../integrations/openai-codex/oauth"

function createCompletedStream() {
	return {
		async *[Symbol.asyncIterator]() {
			yield {
				type: "response.completed",
				response: {
					id: "response-1",
					status: "completed",
					output: [],
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			}
		},
	}
}

async function drainStream(stream: AsyncIterable<unknown>) {
	for await (const _chunk of stream) {
		// Drain the response stream.
	}
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
	it("should skip URL-sourced images in formatFullConversation (only base64 emits input_image)", async () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1-codex" })

		vitest.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vitest.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")

		const capturedInput: any[] = []
		;(handler as any).client = {
			responses: {
				create: vitest.fn().mockImplementation(async (body: any) => {
					capturedInput.push(...(body.input ?? []))
					return {
						async *[Symbol.asyncIterator]() {
							yield {
								type: "response.completed",
								response: {
									id: "r1",
									status: "completed",
									output: [],
									usage: { input_tokens: 1, output_tokens: 1 },
								},
							}
						},
					}
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

		const stream = handler.createMessage("system", messages)
		for await (const _ of stream) {
			// consume
		}

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
					return {
						async *[Symbol.asyncIterator]() {
							yield {
								type: "response.completed",
								response: {
									id: "r1",
									status: "completed",
									output: [],
									usage: { input_tokens: 1, output_tokens: 1 },
								},
							}
						},
					}
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

		const stream = handler.createMessage("system", messages)
		for await (const _ of stream) {
			// consume
		}

		const userMsg = capturedInput.find((item: any) => item.role === "user")
		expect(userMsg?.content).toContainEqual({
			type: "input_image",
			image_url: "data:image/png;base64,abc123",
		})
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

		await drainStream(
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

		await drainStream(
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

		await drainStream(
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

			await drainStream(
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
		const mockFetch = vitest.fn().mockResolvedValue({
			ok: true,
			json: vitest.fn().mockResolvedValue({
				output: [
					{
						type: "message",
						content: [{ type: "output_text", text: "Complete" }],
					},
				],
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
			stream: false,
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
