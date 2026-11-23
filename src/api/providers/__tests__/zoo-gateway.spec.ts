// npx vitest run src/api/providers/__tests__/zoo-gateway.spec.ts

vitest.mock("../utils/timeout-config", () => ({
	getApiRequestTimeout: vitest.fn().mockReturnValue(300_000),
}))

const MOCK_TIMEOUT_MS = 300_000

const { showErrorMessage, openExternal } = vitest.hoisted(() => ({
	showErrorMessage: vitest.fn(async () => undefined as string | undefined),
	openExternal: vitest.fn(async () => true),
}))

vitest.mock("vscode", () => ({
	window: { showErrorMessage },
	env: { openExternal, uriScheme: "vscode", appName: "VS Code" },
	Uri: { parse: (value: string) => ({ toString: () => value }) },
	workspace: {
		getConfiguration: () => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
		}),
	},
}))

vitest.mock("../../../i18n", () => ({
	t: (key: string) => key,
}))

import type { MockInstance } from "vitest"
import OpenAI from "openai"

import { zooGatewayDefaultModelId, ZOO_GATEWAY_DEFAULT_TEMPERATURE } from "@roo-code/types"

import { ZooGatewayHandler, classifyGatewayApiError, toGatewayStreamError } from "../zoo-gateway"
import { ApiHandlerOptions } from "../../../shared/api"
import { Package } from "../../../shared/package"
import { clearZooCodeToken } from "../../../services/zoo-code-auth"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { clearAllMocks } from "../../../test-utils/reset"

vitest.mock("openai")
vitest.mock("delay", () => ({
	default: vitest.fn(function () {
		return Promise.resolve()
	}),
}))
const DEFAULT_MODEL_CATALOG = vitest.hoisted(() => ({
	"anthropic/claude-sonnet-4": {
		maxTokens: 64000,
		contextWindow: 200000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 3,
		outputPrice: 15,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
		description: "Claude Sonnet 4",
	},
	"anthropic/claude-3.5-haiku": {
		maxTokens: 32000,
		contextWindow: 200000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 1,
		outputPrice: 5,
		cacheWritesPrice: 1.25,
		cacheReadsPrice: 0.1,
		description: "Claude 3.5 Haiku",
	},
}))

vitest.mock("../fetchers/modelCache", () => ({
	getModels: vitest.fn().mockImplementation(function () {
		return Promise.resolve(DEFAULT_MODEL_CATALOG)
	}),
	refreshModels: vitest.fn().mockImplementation(function () {
		return Promise.resolve(DEFAULT_MODEL_CATALOG)
	}),
	getModelsFromCache: vitest.fn().mockReturnValue(undefined),
}))

const mockGetCachedZooCodeToken = vitest.hoisted(() => vitest.fn<() => string | undefined>(() => undefined))
const mockSessionCleared = vitest.hoisted(() => ({ value: false }))

vitest.mock("../../../services/zoo-code-auth", () => ({
	getZooCodeBaseUrl: vitest.fn(function () {
		return "https://www.zoocode.dev"
	}),
	getCachedZooCodeToken: () => mockGetCachedZooCodeToken() ?? "",
	resolveZooGatewaySessionToken: (profileToken?: string) => {
		const cached = mockGetCachedZooCodeToken()
		if (cached) return cached
		if (mockSessionCleared.value) return undefined
		return profileToken
	},
	clearZooCodeToken: vitest.fn(async () => {
		mockSessionCleared.value = true
		mockGetCachedZooCodeToken.mockReturnValue(undefined)
	}),
}))

vitest.mock("../../transform/caching/vercel-ai-gateway", () => ({
	addCacheBreakpoints: vitest.fn(),
}))

const mockCreate = vitest.fn()

function mockOpenAIClient() {
	vitest.mocked(OpenAI).mockImplementation(function () {
		return {
			chat: {
				completions: {
					create: mockCreate,
				},
			},
		} as unknown as OpenAI
	})
}

mockOpenAIClient()

describe("ZooGatewayHandler", () => {
	const mockOptions: ApiHandlerOptions = {
		zooSessionToken: "zoo_ext_test_token",
		zooGatewayModelId: "anthropic/claude-sonnet-4",
	}

	beforeEach(async () => {
		clearAllMocks()
		const { getModels, refreshModels, getModelsFromCache } = await import("../fetchers/modelCache")
		vitest
			.mocked(getModels)
			.mockReset()
			.mockImplementation(function () {
				return Promise.resolve(DEFAULT_MODEL_CATALOG)
			})
		vitest
			.mocked(refreshModels)
			.mockReset()
			.mockImplementation(function () {
				return Promise.resolve(DEFAULT_MODEL_CATALOG)
			})
		vitest.mocked(getModelsFromCache).mockReset().mockReturnValue(undefined)
		mockSessionCleared.value = false
		mockGetCachedZooCodeToken.mockReturnValue(undefined)
		mockCreate.mockClear()
		showErrorMessage.mockReset()
		showErrorMessage.mockResolvedValue(undefined)
		openExternal.mockReset()
		openExternal.mockResolvedValue(true)
		mockOpenAIClient()
	})

	function makeApiError(status: number, options: { code?: string; message?: string } = {}) {
		const err = new Error(options.message ?? `HTTP ${status}`) as Error & {
			status: number
			code?: string
		}
		err.status = status
		if (options.code) err.code = options.code
		return err
	}

	async function drainCreateMessage(handler: ZooGatewayHandler) {
		return collectStream(handler.createMessage("system", [{ role: "user", content: "hi" }]))
	}

	describe("constructor", () => {
		it("allows construction without a session token (auth is enforced at request time)", () => {
			expect(() => new ZooGatewayHandler({})).not.toThrow()
			expect(OpenAI).toHaveBeenCalledWith(
				expect.objectContaining({
					apiKey: "not-provided",
				}),
			)
		})

		it("prefers the secret-storage cache over a persisted profile token", () => {
			mockGetCachedZooCodeToken.mockReturnValue("zoo_ext_cached_token")

			new ZooGatewayHandler({
				zooSessionToken: "zoo_ext_stale_profile_token",
				zooGatewayModelId: mockOptions.zooGatewayModelId,
			})

			expect(OpenAI).toHaveBeenCalledWith(
				expect.objectContaining({
					apiKey: "zoo_ext_cached_token",
				}),
			)
		})

		it("initializes OpenAI with Zoo enrichment headers and session token", () => {
			const handler = new ZooGatewayHandler({
				...mockOptions,
				zooGatewayBaseUrl: "https://staging.zoocode.dev/api/gateway/v1",
			})

			expect(handler).toBeInstanceOf(ZooGatewayHandler)
			expect(OpenAI).toHaveBeenCalledWith({
				baseURL: "https://staging.zoocode.dev/api/gateway/v1",
				apiKey: mockOptions.zooSessionToken,
				defaultHeaders: expect.objectContaining({
					"HTTP-Referer": "https://github.com/Zoo-Code-Org/Zoo-Code",
					"X-Title": "Zoo Code",
					"X-Zoo-Editor": "vscode",
					"X-Zoo-Extension-Version": Package.version,
				}),
				timeout: MOCK_TIMEOUT_MS,
			})
		})

		it("defaults the gateway base URL from getZooCodeBaseUrl", () => {
			new ZooGatewayHandler(mockOptions)

			expect(OpenAI).toHaveBeenCalledWith(
				expect.objectContaining({
					baseURL: "https://www.zoocode.dev/api/gateway/v1",
				}),
			)
		})
	})

	describe("fetchModel", () => {
		it("returns configured model info", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			const result = await handler.fetchModel()

			expect(result.id).toBe(mockOptions.zooGatewayModelId)
			expect(result.info.maxTokens).toBe(64000)
			expect(result.info.supportsPromptCache).toBe(true)
		})

		it("falls back to the default model when none is configured", async () => {
			const handler = new ZooGatewayHandler({ zooSessionToken: "zoo_ext_test_token" })
			const result = await handler.fetchModel()

			expect(result.id).toBe(zooGatewayDefaultModelId)
		})
	})

	describe("createMessage", () => {
		it("requires authentication at request time when no session token is available", async () => {
			const handler = new ZooGatewayHandler({})
			await expect(drainCreateMessage(handler)).rejects.toThrow(
				"Zoo Gateway requires authentication. Please sign in to Zoo Code first.",
			)
		})

		beforeEach(() => {
			mockCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{
						choices: [{ delta: { content: "Test response" }, index: 0 }],
						usage: null,
					},
					{
						choices: [{ delta: {}, index: 0 }],
						usage: {
							prompt_tokens: 10,
							completion_tokens: 5,
							total_tokens: 15,
							cache_creation_input_tokens: 2,
							prompt_tokens_details: { cached_tokens: 3 },
							cost: 0.005,
						},
					},
				]),
			)
		})

		it("requires authentication at request time when no session token is available", async () => {
			const handler = new ZooGatewayHandler({})
			const stream = handler.createMessage("You are helpful.", [{ role: "user", content: "Hello" }])

			await expect(collectStream(stream)).rejects.toThrow(
				"Zoo Gateway requires authentication. Please sign in to Zoo Code first.",
			)
		})

		it("streams text and usage chunks", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			const stream = handler.createMessage("You are helpful.", [{ role: "user", content: "Hello" }])

			const chunks = await collectStream(stream)

			expect(chunks).toEqual([
				{ type: "text", text: "Test response" },
				{
					type: "usage",
					inputTokens: 10,
					outputTokens: 5,
					cacheWriteTokens: 2,
					cacheReadTokens: 3,
					totalCost: 0.005,
				},
			])
		})

		it("forwards gateway usage.cost as totalCost so the panel matches billing", async () => {
			mockCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{
						choices: [{ delta: { content: "ok" }, index: 0 }],
						usage: null,
					},
					{
						choices: [{ delta: {}, index: 0 }],
						usage: {
							prompt_tokens: 25694,
							completion_tokens: 829,
							total_tokens: 26523,
							cost: 0.006262,
						},
					},
				]),
			)

			const handler = new ZooGatewayHandler(mockOptions)
			const chunks = await collectStream(
				handler.createMessage("You are helpful.", [{ role: "user", content: "Hello" }]),
			)

			expect(chunks).toContainEqual({
				type: "usage",
				inputTokens: 25694,
				outputTokens: 829,
				cacheWriteTokens: undefined,
				cacheReadTokens: undefined,
				totalCost: 0.006262,
			})
		})

		it("defaults totalCost to 0 when usage omits cost", async () => {
			mockCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{
						choices: [{ delta: { content: "ok" }, index: 0 }],
						usage: null,
					},
					{
						choices: [{ delta: {}, index: 0 }],
						usage: {
							prompt_tokens: 10,
							completion_tokens: 5,
							total_tokens: 15,
						},
					},
				]),
			)

			const handler = new ZooGatewayHandler(mockOptions)
			const chunks = await collectStream(
				handler.createMessage("You are helpful.", [{ role: "user", content: "Hello" }]),
			)

			expect(chunks).toContainEqual({
				type: "usage",
				inputTokens: 10,
				outputTokens: 5,
				cacheWriteTokens: undefined,
				cacheReadTokens: undefined,
				totalCost: 0,
			})
		})

		it("forwards task and mode metadata as request headers", async () => {
			const handler = new ZooGatewayHandler(mockOptions)

			await handler.createMessage("prompt", [], { taskId: "task-123", mode: "code" }).next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.any(Object),
				expect.objectContaining({
					headers: {
						"X-Zoo-Task-ID": "task-123",
						"X-Zoo-Mode": "code",
					},
				}),
			)
		})

		it("uses custom temperature when provided", async () => {
			const handler = new ZooGatewayHandler({
				...mockOptions,
				modelTemperature: 0.5,
			})

			await handler.createMessage("prompt", [{ role: "user", content: "Hi" }]).next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					temperature: 0.5,
				}),
				expect.any(Object),
			)
		})

		it("uses the default temperature when none is provided", async () => {
			const handler = new ZooGatewayHandler(mockOptions)

			await handler.createMessage("prompt", [{ role: "user", content: "Hi" }]).next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					temperature: ZOO_GATEWAY_DEFAULT_TEMPERATURE,
				}),
				expect.any(Object),
			)
		})

		it("adds cache breakpoints for supported models", async () => {
			const { addCacheBreakpoints } = await import("../../transform/caching/vercel-ai-gateway")
			const handler = new ZooGatewayHandler({
				...mockOptions,
				zooGatewayModelId: "anthropic/claude-3.5-haiku",
			})

			await handler.createMessage("prompt", [{ role: "user", content: "Hi" }]).next()

			expect(addCacheBreakpoints).toHaveBeenCalled()
		})

		it("yields tool_call_partial chunks when streaming tool calls", async () => {
			mockCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_123",
											function: { name: "test_tool", arguments: '{"arg1":' },
										},
									],
								},
								index: 0,
							},
						],
					},
				]),
			)

			const handler = new ZooGatewayHandler(mockOptions)
			const chunks = await collectStream(handler.createMessage("prompt", []))

			expect(chunks).toEqual([
				{
					type: "tool_call_partial",
					index: 0,
					id: "call_123",
					name: "test_tool",
					arguments: '{"arg1":',
				},
			])
		})

		it("throws the upstream reason when the gateway sends an in-stream error chunk", async () => {
			mockCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{
						error: {
							message: "Too many requests, please wait before trying again",
							status: 429,
							code: "rate_limited",
						},
					},
				]),
			)

			const handler = new ZooGatewayHandler(mockOptions)

			await expect(drainCreateMessage(handler)).rejects.toThrow(
				"Too many requests, please wait before trying again",
			)
		})

		it("surfaces the add-credits prompt when an in-stream error carries a budget code", async () => {
			mockCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{
						error: {
							message: "Monthly budget exceeded",
							status: 429,
							code: "monthly_budget_exceeded",
						},
					},
				]),
			)

			const handler = new ZooGatewayHandler(mockOptions)

			await expect(drainCreateMessage(handler)).rejects.toThrow()
			expect(showErrorMessage).toHaveBeenCalledWith(
				"common:zooAuth.errors.budget_exceeded",
				"common:zooAuth.buttons.add_credits",
			)
		})
	})

	describe("completePrompt", () => {
		let consoleError: MockInstance<typeof console.error>

		beforeEach(() => {
			mockCreate.mockImplementation(async () => ({
				choices: [{ message: { role: "assistant", content: "Test completion response" } }],
			}))
			consoleError = vitest.spyOn(console, "error").mockImplementation(() => {})
		})

		afterEach(() => {
			consoleError.mockRestore()
		})

		it("returns completion text from the gateway", async () => {
			const handler = new ZooGatewayHandler(mockOptions)

			const result = await handler.completePrompt("Complete this: Hello")

			expect(result).toBe("Test completion response")
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "anthropic/claude-sonnet-4",
					messages: [{ role: "user", content: "Complete this: Hello" }],
					stream: false,
					temperature: ZOO_GATEWAY_DEFAULT_TEMPERATURE,
					max_completion_tokens: 64000,
				}),
				{},
			)
		})

		it("wraps errors with a Zoo Gateway prefix", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			mockCreate.mockImplementation(function () {
				throw new Error("upstream failure")
			})

			await expect(handler.completePrompt("Test")).rejects.toThrow(
				"Zoo Gateway completion error: upstream failure",
			)
		})

		it("forwards a per-request signal and the timeout to the SDK", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			const caller = new AbortController()

			await handler.completePrompt("Test", { abortSignal: caller.signal, timeoutMs: 5_000 })

			const requestOptions = mockCreate.mock.calls[0][1] as { signal?: AbortSignal; timeout?: number }
			expect(requestOptions.signal).toBeInstanceOf(AbortSignal)
			expect(requestOptions.signal).not.toBe(caller.signal)
			expect(requestOptions.timeout).toBe(5_000)
		})

		it("sends no signal when the caller gives none", async () => {
			const handler = new ZooGatewayHandler(mockOptions)

			await handler.completePrompt("Test")

			expect(mockCreate.mock.calls[0][1]).toEqual({})
		})

		it.each([
			["with a session", mockOptions],
			["without a session", { zooGatewayModelId: "anthropic/claude-sonnet-4" }],
		])(
			"rejects a pre-aborted signal with an AbortError, %s, before model lookup",
			async (_label, options: ApiHandlerOptions) => {
				const { getModels } = await import("../fetchers/modelCache")
				const handler = new ZooGatewayHandler(options)
				const caller = new AbortController()
				caller.abort()

				await expect(handler.completePrompt("Test", { abortSignal: caller.signal })).rejects.toMatchObject({
					name: "AbortError",
				})
				expect(getModels).not.toHaveBeenCalled()
				expect(mockCreate).not.toHaveBeenCalled()
			},
		)

		it("keeps an ordinary model lookup failure while the caller signal is live", async () => {
			const { getModels, refreshModels } = await import("../fetchers/modelCache")
			const lookupFailure = new Error("model catalog unavailable")
			vitest.mocked(getModels).mockRejectedValue(lookupFailure)
			vitest.mocked(refreshModels).mockRejectedValue(lookupFailure)
			const handler = new ZooGatewayHandler(mockOptions)

			await expect(handler.completePrompt("Test", { abortSignal: new AbortController().signal })).rejects.toBe(
				lookupFailure,
			)
		})

		it.each([
			["a raw AbortError", Object.assign(new Error("The user aborted a request"), { name: "AbortError" })],
			["the SDK abort error", new Error("Request was aborted.")],
		])(
			"normalizes %s from the model lookup to the provider AbortError while the caller signal is live",
			async (_label, lookupFailure: Error) => {
				const { getModels, refreshModels } = await import("../fetchers/modelCache")
				vitest.mocked(getModels).mockRejectedValue(lookupFailure)
				vitest.mocked(refreshModels).mockRejectedValue(lookupFailure)
				const handler = new ZooGatewayHandler(mockOptions)

				await expect(
					handler.completePrompt("Test", { abortSignal: new AbortController().signal }),
				).rejects.toMatchObject({
					name: "AbortError",
					message: "The Zoo Gateway request was aborted",
				})
				expect(mockCreate).not.toHaveBeenCalled()
			},
		)

		it("rejects with an AbortError when the timeout alone expires during the SDK call", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			let sdkSignal: AbortSignal | undefined
			mockCreate.mockImplementation((_params: unknown, requestOptions: { signal?: AbortSignal }) => {
				sdkSignal = requestOptions.signal
				return new Promise(() => {})
			})

			await expect(handler.completePrompt("Test", { timeoutMs: 20 })).rejects.toMatchObject({
				name: "AbortError",
				message: "The Zoo Gateway request was aborted",
			})
			expect(sdkSignal?.aborted).toBe(true)
			expect(showErrorMessage).not.toHaveBeenCalled()
		})

		it("settles on abort while a gateway error notification waits for the user", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			const caller = new AbortController()
			mockCreate.mockRejectedValue(makeApiError(402))
			showErrorMessage.mockImplementation(() => new Promise(() => {}))

			const pending = handler.completePrompt("Test", { abortSignal: caller.signal })
			await vitest.waitFor(() => expect(showErrorMessage).toHaveBeenCalled())
			caller.abort()

			await expect(pending).rejects.toMatchObject({
				name: "AbortError",
				message: "The Zoo Gateway request was aborted",
			})
			// The abort is not a failure of the notification, so nothing is logged.
			expect(consoleError).not.toHaveBeenCalled()
		})

		it.each([
			["with a live caller signal", true, new Error("notification failed"), "notification failed"],
			["without a caller signal", false, "notification dismissed", "notification dismissed"],
		])(
			"logs a failed gateway error notification and still rejects with the gateway error, %s",
			async (_label, withSignal: boolean, notificationFailure: unknown, logged: string) => {
				const handler = new ZooGatewayHandler(mockOptions)
				mockCreate.mockRejectedValue(makeApiError(402, { message: "out of credits" }))
				showErrorMessage.mockRejectedValue(notificationFailure)
				const options = withSignal ? { abortSignal: new AbortController().signal } : undefined

				await expect(handler.completePrompt("Test", options)).rejects.toThrow(
					"Zoo Gateway completion error: out of credits",
				)
				expect(consoleError).toHaveBeenCalledWith("Failed to surface Zoo Gateway error:", logged)
			},
		)

		it("rethrows an SDK failure that is not an Error unchanged", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			const failure = { reason: "upstream failure" }
			mockCreate.mockRejectedValue(failure)

			await expect(handler.completePrompt("Test", { abortSignal: new AbortController().signal })).rejects.toBe(
				failure,
			)
		})

		it("rejects with an AbortError when the timeout alone expires during model lookup", async () => {
			const { getModels } = await import("../fetchers/modelCache")
			vitest.mocked(getModels).mockImplementation(() => new Promise(() => {}))
			const handler = new ZooGatewayHandler(mockOptions)

			await expect(handler.completePrompt("Test", { timeoutMs: 20 })).rejects.toMatchObject({
				name: "AbortError",
				message: "The Zoo Gateway request was aborted",
			})
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("rejects with an AbortError when the signal aborts during model lookup", async () => {
			const { getModels } = await import("../fetchers/modelCache")
			vitest.mocked(getModels).mockImplementation(() => new Promise(() => {}))
			const handler = new ZooGatewayHandler(mockOptions)
			const caller = new AbortController()

			const pending = handler.completePrompt("Test", { abortSignal: caller.signal })
			caller.abort()

			await expect(pending).rejects.toMatchObject({
				name: "AbortError",
				message: "The Zoo Gateway request was aborted",
			})
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("rejects with an AbortError at once when aborted mid-flight, without a gateway error", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			const caller = new AbortController()
			let sdkSignal: AbortSignal | undefined
			// The SDK call never settles, as when the SDK sleeps between retries.
			mockCreate.mockImplementation((_params: unknown, requestOptions: { signal?: AbortSignal }) => {
				sdkSignal = requestOptions.signal
				return new Promise(() => {})
			})

			const pending = handler.completePrompt("Test", { abortSignal: caller.signal })
			await vitest.waitFor(() => expect(mockCreate).toHaveBeenCalled())
			caller.abort()

			await expect(pending).rejects.toMatchObject({
				name: "AbortError",
				message: "The Zoo Gateway request was aborted",
			})
			expect(sdkSignal?.aborted).toBe(true)
			expect(showErrorMessage).not.toHaveBeenCalled()
		})

		it("reports an SDK abort error after the caller aborts as an AbortError, not a gateway error", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			const caller = new AbortController()
			mockCreate.mockImplementation(async () => {
				caller.abort()
				throw new Error("Request was aborted.")
			})

			await expect(handler.completePrompt("Test", { abortSignal: caller.signal })).rejects.toMatchObject({
				name: "AbortError",
			})
			expect(showErrorMessage).not.toHaveBeenCalled()
		})

		it("shows no gateway error for a 402 that rejects just before the caller aborts", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			const caller = new AbortController()
			let rejectCompletion: (reason: unknown) => void = () => {}
			const completion = new Promise((_resolve, reject) => {
				rejectCompletion = reject
			})
			mockCreate.mockImplementation(() => completion)

			const pending = handler.completePrompt("Test", { abortSignal: caller.signal })
			await vitest.waitFor(() => expect(mockCreate).toHaveBeenCalled())
			// This callback runs after the handler's own race settles with the 402 but before completePrompt
			// resumes, so only the abort check before the notification keeps the 402 notification away.
			completion.catch(() => caller.abort())
			rejectCompletion(makeApiError(402))

			await expect(pending).rejects.toMatchObject({ name: "AbortError" })
			expect(showErrorMessage).not.toHaveBeenCalled()
		})

		it("does not return a completion that resolves just before the caller aborts", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			const caller = new AbortController()
			let resolveCompletion: (value: unknown) => void = () => {}
			const completion = new Promise((resolve) => {
				resolveCompletion = resolve
			})
			mockCreate.mockImplementation(() => completion)

			const pending = handler.completePrompt("Test", { abortSignal: caller.signal })
			await vitest.waitFor(() => expect(mockCreate).toHaveBeenCalled())
			// This callback runs after the handler's own race settles but before completePrompt resumes,
			// so only the check after the await can drop the late result.
			void completion.then(() => caller.abort())
			resolveCompletion({ choices: [{ message: { role: "assistant", content: "late" } }] })

			await expect(pending).rejects.toMatchObject({ name: "AbortError" })
		})

		it.each([
			["a completed request", () => {}],
			["a failed request", () => mockCreate.mockRejectedValue(new Error("upstream failure"))],
			["a request aborted mid-flight", () => mockCreate.mockImplementation(() => new Promise(() => {}))],
		])("removes the same abort listener from the caller's signal after %s", async (_label, setup) => {
			setup()
			const handler = new ZooGatewayHandler(mockOptions)
			const caller = new AbortController()
			const addListener = vitest.spyOn(caller.signal, "addEventListener")
			const removeListener = vitest.spyOn(caller.signal, "removeEventListener")

			const pending = handler.completePrompt("Test", { abortSignal: caller.signal }).catch(() => undefined)
			await vitest.waitFor(() => expect(mockCreate).toHaveBeenCalled())
			caller.abort()
			await pending

			const abortListeners = addListener.mock.calls.filter(([type]) => type === "abort")
			expect(abortListeners).toHaveLength(1)
			expect(removeListener).toHaveBeenCalledWith("abort", abortListeners[0][1])
		})

		it.each([
			["no content", [{ message: { role: "assistant", content: null } }]],
			["no choices", []],
		])("returns an empty string when the model returns %s", async (_label, choices: unknown[]) => {
			const handler = new ZooGatewayHandler(mockOptions)
			mockCreate.mockImplementation(async () => ({ choices }))

			await expect(handler.completePrompt("Test")).resolves.toBe("")
		})

		it.each([
			["with a live caller signal", { abortSignal: new AbortController().signal }],
			["without a caller signal", undefined],
		])("requires a session before the model lookup, %s", async (_label, options) => {
			const { getModels } = await import("../fetchers/modelCache")
			const handler = new ZooGatewayHandler({ zooGatewayModelId: "anthropic/claude-sonnet-4" })

			await expect(handler.completePrompt("Test", options)).rejects.toThrow(
				"Zoo Gateway requires authentication. Please sign in to Zoo Code first.",
			)
			expect(getModels).not.toHaveBeenCalled()
			expect(mockCreate).not.toHaveBeenCalled()
		})
	})

	describe("classifyGatewayApiError", () => {
		it("returns sign_in on 401", () => {
			expect(classifyGatewayApiError(makeApiError(401))).toEqual({ kind: "sign_in" })
		})

		it("returns add_credits (not budget) on 402", () => {
			expect(classifyGatewayApiError(makeApiError(402))).toEqual({ kind: "add_credits", budgetExceeded: false })
		})

		it("returns add_credits with budgetExceeded on 429 budget codes", () => {
			expect(classifyGatewayApiError(makeApiError(429, { code: "monthly_budget_exceeded" }))).toEqual({
				kind: "add_credits",
				budgetExceeded: true,
			})
			expect(classifyGatewayApiError(makeApiError(429, { code: "daily_budget_exceeded" }))).toEqual({
				kind: "add_credits",
				budgetExceeded: true,
			})
		})

		it("returns none on 429 without a budget code", () => {
			expect(classifyGatewayApiError(makeApiError(429, { code: "rate_limited" }))).toEqual({ kind: "none" })
		})

		it("returns contact_support on 403", () => {
			expect(classifyGatewayApiError(makeApiError(403))).toEqual({ kind: "contact_support" })
		})

		it("returns none for errors without an HTTP status", () => {
			expect(classifyGatewayApiError(new Error("network down"))).toEqual({ kind: "none" })
		})
	})

	describe("toGatewayStreamError", () => {
		it("preserves the message, status, and code from the chunk", () => {
			const error = toGatewayStreamError({
				message: "rate limited",
				status: 429,
				code: "rate_limited",
			}) as Error & {
				status?: number
				code?: string
			}

			expect(error).toBeInstanceOf(Error)
			expect(error.message).toBe("rate limited")
			expect(error.status).toBe(429)
			expect(error.code).toBe("rate_limited")
		})

		it("falls back to a default message and leaves status/code undefined", () => {
			const error = toGatewayStreamError({}) as Error & { status?: number; code?: string }

			expect(error.message).toBe("Zoo Gateway stream error")
			expect(error.status).toBeUndefined()
			expect(error.code).toBeUndefined()
		})
	})

	describe("surfaceGatewayApiError", () => {
		it("clears the cached token and offers re-sign-in on 401", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			mockCreate.mockImplementation(function () {
				throw makeApiError(401)
			})
			showErrorMessage.mockResolvedValueOnce("common:zooAuth.buttons.sign_in")

			await expect(drainCreateMessage(handler)).rejects.toThrow()
			expect(clearZooCodeToken).toHaveBeenCalledTimes(1)
			expect(showErrorMessage).toHaveBeenCalledWith(
				"common:zooAuth.errors.session_expired",
				"common:zooAuth.buttons.sign_in",
			)
			expect(openExternal).toHaveBeenCalledTimes(1)
		})

		it("does not open a URL on 401 when the user dismisses the prompt", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			mockCreate.mockImplementation(function () {
				throw makeApiError(401)
			})
			showErrorMessage.mockResolvedValueOnce(undefined)

			await expect(drainCreateMessage(handler)).rejects.toThrow()
			expect(clearZooCodeToken).toHaveBeenCalledTimes(1)
			expect(openExternal).not.toHaveBeenCalled()
		})

		it("prompts to add credits on 402", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			mockCreate.mockImplementation(function () {
				throw makeApiError(402)
			})
			showErrorMessage.mockResolvedValueOnce("common:zooAuth.buttons.add_credits")

			await expect(drainCreateMessage(handler)).rejects.toThrow()
			expect(clearZooCodeToken).not.toHaveBeenCalled()
			expect(showErrorMessage).toHaveBeenCalledWith(
				"common:zooAuth.errors.out_of_credits",
				"common:zooAuth.buttons.add_credits",
			)
			expect(openExternal).toHaveBeenCalledTimes(1)
		})

		it("shows the budget message on 429 with a budget code", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			mockCreate.mockImplementation(function () {
				throw makeApiError(429, { code: "monthly_budget_exceeded" })
			})

			await expect(drainCreateMessage(handler)).rejects.toThrow()
			expect(showErrorMessage).toHaveBeenCalledWith(
				"common:zooAuth.errors.budget_exceeded",
				"common:zooAuth.buttons.add_credits",
			)
		})

		it("does not surface a notification on 429 without a budget code", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			mockCreate.mockImplementation(function () {
				throw makeApiError(429, { code: "rate_limited" })
			})

			await expect(drainCreateMessage(handler)).rejects.toThrow()
			expect(showErrorMessage).not.toHaveBeenCalled()
		})

		it("offers contact support on 403", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			mockCreate.mockImplementation(function () {
				throw makeApiError(403)
			})
			showErrorMessage.mockResolvedValueOnce("common:zooAuth.buttons.contact_support")

			await expect(drainCreateMessage(handler)).rejects.toThrow()
			expect(showErrorMessage).toHaveBeenCalledWith(
				"common:zooAuth.errors.account_unavailable",
				"common:zooAuth.buttons.contact_support",
			)
			expect(openExternal).toHaveBeenCalledTimes(1)
		})

		it("ignores errors without an HTTP status", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			mockCreate.mockImplementation(function () {
				throw new Error("network down")
			})

			await expect(drainCreateMessage(handler)).rejects.toThrow("network down")
			expect(showErrorMessage).not.toHaveBeenCalled()
			expect(clearZooCodeToken).not.toHaveBeenCalled()
		})

		it("surfaces the gateway error then wraps the message in completePrompt", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			mockCreate.mockImplementation(function () {
				throw makeApiError(402, { message: "out of credits" })
			})

			await expect(handler.completePrompt("ping")).rejects.toThrow("Zoo Gateway completion error: out of credits")
			expect(showErrorMessage).toHaveBeenCalledWith(
				"common:zooAuth.errors.out_of_credits",
				"common:zooAuth.buttons.add_credits",
			)
		})
	})

	describe("ensureModelFetched", () => {
		it("fetches models when instance models are empty", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			const { getModels, refreshModels } = await import("../fetchers/modelCache")

			expect(handler.getModel().info.contextWindow).toBe(200000)

			await handler.ensureModelFetched()

			expect(getModels).toHaveBeenCalled()
			expect(refreshModels).not.toHaveBeenCalled()
		})

		it("settles the waiter with a rejection when the signal aborts mid-fetch", async () => {
			// A caller that gives up must not leave a handler-side waiter pending
			// on the (shared) catalog fetch: with an observing signal, the
			// ensureModelFetched promise rejects at abort time, while the
			// underlying fetch continues untouched for any other waiter.
			const { getModels } = await import("../fetchers/modelCache")
			vitest.mocked(getModels).mockImplementationOnce(() => new Promise(() => {}))

			const handler = new ZooGatewayHandler(mockOptions)
			const controller = new AbortController()

			const wait = handler.ensureModelFetched(controller.signal)
			// Let the waiter attach its abort listener before cancelling.
			await Promise.resolve()
			controller.abort()

			await expect(wait).rejects.toThrow()
		})

		it("settles the waiter when the fetch wins against a live signal and detaches the listener", async () => {
			// Fetch-wins branch: resolve() must settle the await (a dropped
			// resolve or a detached .then handler hangs this test), the abort
			// listener must be registered with the real { once: true } options
			// object, and the detach must target the *same* event name/handler
			// pair that was registered — a mutated event name detaches nothing.
			const handler = new ZooGatewayHandler(mockOptions)
			const controller = new AbortController()
			const addEventListenerSpy = vitest.spyOn(controller.signal, "addEventListener")
			const removeEventListenerSpy = vitest.spyOn(controller.signal, "removeEventListener")

			await handler.ensureModelFetched(controller.signal)

			expect(addEventListenerSpy).toHaveBeenCalledWith("abort", expect.any(Function), { once: true })
			const registered = addEventListenerSpy.mock.calls.find(([event]) => event === "abort")
			expect(registered).toBeDefined()
			expect(removeEventListenerSpy).toHaveBeenCalledWith("abort", registered?.[1])
		})

		it("rejects a signal-observing waiter with the fetch error and detaches the listener", async () => {
			// Rejection-branch twin of the fetch-wins test: reject(error) must
			// propagate the catalog failure to the waiter (a dropped reject hangs
			// this test) and the listener must be detached under the right event
			// name. The no-signal reject path cannot attach a listener, so this is the only
			// coverage of the reject-side detach.
			const { getModels } = await import("../fetchers/modelCache")
			vitest.mocked(getModels).mockRejectedValueOnce(new Error("network down"))

			const handler = new ZooGatewayHandler(mockOptions)
			const controller = new AbortController()
			const addEventListenerSpy = vitest.spyOn(controller.signal, "addEventListener")
			const removeEventListenerSpy = vitest.spyOn(controller.signal, "removeEventListener")

			await expect(handler.ensureModelFetched(controller.signal)).rejects.toThrow("network down")
			const registered = addEventListenerSpy.mock.calls.find(([event]) => event === "abort")
			expect(registered).toBeDefined()
			expect(removeEventListenerSpy).toHaveBeenCalledWith("abort", registered?.[1])
		})

		it("never starts a wait when the signal is already aborted", async () => {
			const { getModels } = await import("../fetchers/modelCache")
			const handler = new ZooGatewayHandler(mockOptions)
			const controller = new AbortController()
			controller.abort()

			await expect(handler.ensureModelFetched(controller.signal)).rejects.toThrow()
			// Without the spy, a guard relocated after fetchModel() starts would
			// still reject here and settle identically; zero getModels calls pins
			// that the check runs before the fetch starts.
			expect(vitest.mocked(getModels)).not.toHaveBeenCalled()
		})

		it("skips the fetch when models are already populated", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			const { getModels, refreshModels } = await import("../fetchers/modelCache")

			await handler.ensureModelFetched()
			vitest.mocked(getModels).mockClear()
			vitest.mocked(refreshModels).mockClear()

			await handler.ensureModelFetched()
			expect(getModels).not.toHaveBeenCalled()
			expect(refreshModels).not.toHaveBeenCalled()
		})

		it("short-circuits a subsequent fetchModel call after models are populated", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			const { getModels, refreshModels } = await import("../fetchers/modelCache")

			await handler.ensureModelFetched()
			vitest.mocked(getModels).mockClear()
			vitest.mocked(refreshModels).mockClear()

			await handler.fetchModel()
			expect(getModels).not.toHaveBeenCalled()
			expect(refreshModels).not.toHaveBeenCalled()
		})

		it("refetches when the configured model is missing from a populated map", async () => {
			vitest.useFakeTimers()
			try {
				const { getModels, refreshModels } = await import("../fetchers/modelCache")
				const staleCatalog = {
					"anthropic/claude-sonnet-4": {
						maxTokens: 64000,
						contextWindow: 200000,
						supportsImages: true,
						supportsPromptCache: true,
						inputPrice: 3,
						outputPrice: 15,
					},
				}
				vitest.mocked(getModels).mockResolvedValueOnce(staleCatalog)
				vitest.mocked(refreshModels).mockResolvedValueOnce(staleCatalog)

				const handler = new ZooGatewayHandler({
					...mockOptions,
					zooGatewayModelId: "alibaba/qwen3.8-max",
				})

				await handler.ensureModelFetched()
				expect(handler.getModel().info.inputPrice).toBe(0)

				const freshCatalog = {
					"alibaba/qwen3.8-max": {
						maxTokens: 65536,
						contextWindow: 1_000_000,
						supportsImages: true,
						supportsPromptCache: true,
						inputPrice: 0.222,
						outputPrice: 0.667,
					},
				}
				vitest.mocked(getModels).mockClear()
				vitest.mocked(refreshModels).mockClear()
				vitest.mocked(getModels).mockResolvedValueOnce(freshCatalog)

				vitest.advanceTimersByTime(5 * 60 * 1000 + 1)
				await handler.ensureModelFetched()

				expect(getModels).toHaveBeenCalled()
				expect(refreshModels).not.toHaveBeenCalled()
				expect(handler.getModel().info.inputPrice).toBe(0.222)
				expect(handler.getModel().info.outputPrice).toBe(0.667)
			} finally {
				vitest.useRealTimers()
			}
		})

		it("does not reuse default model prices for an unknown configured model", async () => {
			const { getModels, refreshModels } = await import("../fetchers/modelCache")
			vitest.mocked(getModels).mockResolvedValueOnce({})
			vitest.mocked(refreshModels).mockResolvedValueOnce({})

			const handler = new ZooGatewayHandler({
				...mockOptions,
				zooGatewayModelId: "alibaba/qwen3.8-max",
			})

			await handler.ensureModelFetched()

			const { id, info } = handler.getModel()
			expect(id).toBe("alibaba/qwen3.8-max")
			expect(info.inputPrice).toBe(0)
			expect(info.outputPrice).toBe(0)
			expect(info.cacheWritesPrice).toBe(0)
			expect(info.cacheReadsPrice).toBe(0)
		})

		it("does not refetch an unresolved model on every ensureModelFetched call", async () => {
			const { getModels, refreshModels } = await import("../fetchers/modelCache")
			const catalog = {
				"anthropic/claude-sonnet-4": {
					maxTokens: 64000,
					contextWindow: 200000,
					supportsImages: true,
					supportsPromptCache: true,
					inputPrice: 3,
					outputPrice: 15,
				},
			}
			vitest.mocked(getModels).mockResolvedValue(catalog)
			vitest.mocked(refreshModels).mockResolvedValue(catalog)

			const handler = new ZooGatewayHandler({
				...mockOptions,
				zooGatewayModelId: "alibaba/qwen3.8-max",
			})

			await handler.ensureModelFetched()
			vitest.mocked(getModels).mockClear()
			vitest.mocked(refreshModels).mockClear()

			await handler.ensureModelFetched()
			await handler.ensureModelFetched()

			expect(getModels).not.toHaveBeenCalled()
			expect(refreshModels).not.toHaveBeenCalled()
			expect(handler.getModel().info.inputPrice).toBe(0)
		})

		it("negative-caches an empty catalog response for a missing model", async () => {
			const { getModels, refreshModels } = await import("../fetchers/modelCache")
			vitest.mocked(getModels).mockResolvedValue({})
			vitest.mocked(refreshModels).mockResolvedValue({})

			const handler = new ZooGatewayHandler({
				...mockOptions,
				zooGatewayModelId: "alibaba/qwen3.8-max",
			})

			await handler.ensureModelFetched()
			vitest.mocked(getModels).mockClear()
			vitest.mocked(refreshModels).mockClear()

			await handler.ensureModelFetched()

			expect(getModels).not.toHaveBeenCalled()
			expect(refreshModels).not.toHaveBeenCalled()
			expect(handler.getModel().info.inputPrice).toBe(0)
		})

		it("force-refreshes before negative-caching when shared catalog is stale", async () => {
			const { getModels, refreshModels } = await import("../fetchers/modelCache")
			vitest.mocked(getModels).mockResolvedValueOnce({
				"anthropic/claude-sonnet-4": {
					maxTokens: 64000,
					contextWindow: 200000,
					supportsImages: true,
					supportsPromptCache: true,
					inputPrice: 3,
					outputPrice: 15,
				},
			})
			vitest.mocked(refreshModels).mockResolvedValueOnce({
				"alibaba/qwen3.8-max": {
					maxTokens: 65536,
					contextWindow: 1_000_000,
					supportsImages: true,
					supportsPromptCache: true,
					inputPrice: 0.222,
					outputPrice: 0.667,
				},
			})

			const handler = new ZooGatewayHandler({
				...mockOptions,
				zooGatewayModelId: "alibaba/qwen3.8-max",
			})

			await handler.ensureModelFetched()

			expect(getModels).toHaveBeenCalled()
			expect(refreshModels).toHaveBeenCalled()
			expect(handler.getModel().info.inputPrice).toBe(0.222)
			expect(handler.getModel().info.outputPrice).toBe(0.667)

			vitest.mocked(getModels).mockClear()
			vitest.mocked(refreshModels).mockClear()
			await handler.ensureModelFetched()
			expect(getModels).not.toHaveBeenCalled()
			expect(refreshModels).not.toHaveBeenCalled()
		})

		it("deduplicates concurrent calls into a single fetch", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			const { getModels, refreshModels } = await import("../fetchers/modelCache")
			vitest.mocked(getModels).mockClear()
			vitest.mocked(refreshModels).mockClear()

			await Promise.all([handler.ensureModelFetched(), handler.ensureModelFetched()])

			expect(getModels).toHaveBeenCalledTimes(1)
			expect(refreshModels).not.toHaveBeenCalled()
		})

		it("recovers after a rejected fetch so later calls are not poisoned", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			const { getModels } = await import("../fetchers/modelCache")

			vitest.mocked(getModels).mockRejectedValueOnce(new Error("network down"))
			await expect(handler.ensureModelFetched()).rejects.toThrow("network down")

			vitest.mocked(getModels).mockResolvedValueOnce({
				"anthropic/claude-sonnet-4": {
					maxTokens: 64000,
					contextWindow: 1000000,
					supportsImages: true,
					supportsPromptCache: true,
				},
			})
			await handler.ensureModelFetched()

			expect(handler.getModel().info.contextWindow).toBe(1000000)
		})

		it("makes getModel return the fetched context window instead of the default", async () => {
			const { getModels, refreshModels } = await import("../fetchers/modelCache")
			vitest.mocked(getModels).mockResolvedValueOnce({
				"google/gemini-2.5-pro": {
					maxTokens: 65536,
					contextWindow: 1048576,
					supportsImages: true,
					supportsPromptCache: false,
				},
			})

			const handler = new ZooGatewayHandler({
				...mockOptions,
				zooGatewayModelId: "google/gemini-2.5-pro",
			})

			expect(handler.getModel().info.contextWindow).toBe(200000)

			await handler.ensureModelFetched()

			expect(handler.getModel().info.contextWindow).toBe(1048576)
			expect(refreshModels).not.toHaveBeenCalled()
		})
	})
})
