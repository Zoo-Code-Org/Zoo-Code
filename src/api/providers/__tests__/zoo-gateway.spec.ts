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
import OpenAI, { APIConnectionTimeoutError, APIUserAbortError } from "openai"

import { zooGatewayDefaultModelId, ZOO_GATEWAY_DEFAULT_TEMPERATURE } from "@roo-code/types"

import { ZooGatewayHandler, classifyGatewayApiError, toGatewayStreamError } from "../zoo-gateway"
import { getModels } from "../fetchers/modelCache"
import { ApiHandlerOptions } from "../../../shared/api"
import { Package } from "../../../shared/package"
import { clearZooCodeToken } from "../../../services/zoo-code-auth"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { clearAllMocks } from "../../../test-utils/reset"
import { makeCreateMessageMetadata } from "../../../test-utils/api"

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

// A bounded observation window built on vi.waitFor: it polls while its callback throws, so a
// callback that always throws keeps it polling for the whole window (measured on vitest 4.1.12:
// a callback that only returns a value settles immediately instead of waiting). It also doubles
// as the "still pending" sentinel in the cancel races below, which is what pins the race itself.
async function observeWindow(ms: number): Promise<"pending"> {
	return vi
		.waitFor(() => expect(false).toBe(true), { timeout: ms, interval: 10 })
		.then(
			() => "pending",
			() => "pending",
		)
}

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
					signal: expect.any(AbortSignal),
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

		it("should pass abort signal through to client", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			const controller = new AbortController()
			mockCreate.mockImplementation(async () => ({
				choices: [{ message: { role: "assistant", content: "response" } }],
			}))

			await handler.completePrompt("test prompt", { abortSignal: controller.signal })
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ model: expect.any(String) }),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
			// The handler hands the SDK a per-request signal bridged from the caller's, so the
			// forwarded object is a fresh AbortSignal rather than the caller's own instance.
			// The linkage itself is asserted by the abort-during-request test below.
			const call = mockCreate.mock.calls[mockCreate.mock.calls.length - 1]
			const forwarded = (call[1] as { signal?: AbortSignal } | undefined)?.signal
			expect(forwarded).toBeInstanceOf(AbortSignal)
			expect(forwarded?.aborted).toBe(false)
		})

		it("should pass timeout through to client", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			mockCreate.mockImplementation(async () => ({
				choices: [{ message: { role: "assistant", content: "response" } }],
			}))

			await handler.completePrompt("test prompt", { timeoutMs: 5000 })
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ model: expect.any(String) }),
				expect.objectContaining({ timeout: 5000 }),
			)
		})

		it("should omit the timeout option when timeoutMs is 0", async () => {
			// The OpenAI SDK treats timeout: 0 as an immediate abort, so the
			// "disabled" value must never be forwarded — assert the absence of
			// the option (a forwarded timeout: 0 would fail this assertion).
			const handler = new ZooGatewayHandler(mockOptions)
			mockCreate.mockImplementation(async () => ({
				choices: [{ message: { role: "assistant", content: "response" } }],
			}))

			await handler.completePrompt("test prompt", { timeoutMs: 0 })
			const call = mockCreate.mock.calls[mockCreate.mock.calls.length - 1]
			const requestOptions = call[1] as { timeout?: number } | undefined
			expect(requestOptions).not.toHaveProperty("timeout")
		})

		it("should omit the timeout option for a negative timeoutMs and keep the bridged signal", async () => {
			// -5 is a disabled budget, not a five-second one: hasUsableTimeout rejects every
			// non-positive value, so nothing may reach the SDK — and dropping the budget must not
			// drop the cancel, so the bridged per-request signal still has to be forwarded.
			const handler = new ZooGatewayHandler(mockOptions)
			mockCreate.mockImplementation(async () => ({
				choices: [{ message: { role: "assistant", content: "response" } }],
			}))
			const controller = new AbortController()

			await handler.completePrompt("test prompt", { abortSignal: controller.signal, timeoutMs: -5 })
			const call = mockCreate.mock.calls[mockCreate.mock.calls.length - 1]
			const requestOptions = call[1] as { timeout?: number; signal?: AbortSignal } | undefined
			expect(requestOptions).not.toHaveProperty("timeout")
			expect(requestOptions?.signal).toBeInstanceOf(AbortSignal)
		})

		it("should preserve abort identity when the caller aborts during the request", async () => {
			// Emulate the OpenAI SDK: an aborted request signal rejects with
			// APIUserAbortError ("Request was aborted." — the trailing period would
			// fail task-level abort detection, so the provider must normalize it).
			// The abort fires inside the mock so the SDK abort branch is actually reached:
			// a pre-aborted signal settles in the cancellation scope before the mock
			// runs, which would leave this catch untested. The pre-abort entry guard
			// is covered by its own test below.
			const controller = new AbortController()
			let sdkSignal: AbortSignal | undefined
			let abortedAtEntry = true
			mockCreate.mockImplementationOnce(async (_params: unknown, options: { signal?: AbortSignal }) => {
				// The bridged per-request signal is what the SDK receives; the caller's abort must reach it
				// while the request is in flight. The state is recorded here and asserted below: an assertion
				// raised inside this mock would itself be normalized into the AbortError this test expects.
				sdkSignal = options.signal
				abortedAtEntry = sdkSignal?.aborted === true
				controller.abort()
				throw new APIUserAbortError()
			})

			const handler = new ZooGatewayHandler(mockOptions)

			const error = await handler.completePrompt("test prompt", { abortSignal: controller.signal }).then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(mockCreate).toHaveBeenCalledTimes(1)
			expect(sdkSignal).toBeInstanceOf(AbortSignal)
			expect(sdkSignal).not.toBe(controller.signal) // the bridge, not the caller's own signal
			expect(abortedAtEntry).toBe(false)
			expect(sdkSignal?.aborted).toBe(true) // the bridge forwarded the cancel to the SDK signal
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Zoo Gateway request was aborted")
		})

		it("should classify the SDK's own timeout error while the request signal is live", async () => {
			// The neighbouring timeout test aborts the signal before the SDK raises its error, so the
			// aborted-signal disjunct alone could satisfy it. Reject with APIConnectionTimeoutError while
			// nothing has been aborted: only the error-class disjunct can classify that as AbortError.
			const controller = new AbortController()
			mockCreate.mockImplementationOnce(() => {
				throw new APIConnectionTimeoutError()
			})

			const handler = new ZooGatewayHandler(mockOptions)

			const error = await handler.completePrompt("test prompt", { abortSignal: controller.signal }).then(
				() => undefined,
				(e: unknown) => e,
			)

			expect(controller.signal.aborted).toBe(false)
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Zoo Gateway request was aborted")
		})

		it("should surface request timeouts as an AbortError", async () => {
			// Emulate the OpenAI SDK: when the request timeout fires, the SDK
			// surfaces APIConnectionTimeoutError ("Request timed out.") once retries
			// are exhausted — verified against openai v5.23.2 against a hung server.
			mockCreate.mockImplementationOnce(
				async (_params: unknown, options: { timeout?: number; signal?: AbortSignal }) => {
					// The SDK surfaces its timeout error only once the client's patience runs out: wait on
					// the per-request signal the handler passed instead of guessing at a duration.
					const sdkSignal = options?.signal
					if (!sdkSignal) {
						// Without a per-request signal there is no deadline to wait for, so this mock would throw
						// immediately and the test would pass even if the provider stopped forwarding the budget.
						throw new Error("the provider forwarded no deadline signal")
					}
					if (!sdkSignal.aborted) {
						await new Promise<void>((resolve) => {
							sdkSignal.addEventListener("abort", () => resolve(), { once: true })
						})
					}
					throw new APIConnectionTimeoutError()
				},
			)

			const handler = new ZooGatewayHandler(mockOptions)

			const error = await handler.completePrompt("test prompt", { timeoutMs: 50 }).then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Zoo Gateway request was aborted")
		})

		it("should preserve abort identity when the signal aborts during the request with a plain error", async () => {
			// The aborted-signal disjunct alone must normalize a plain
			// rejection (not just SDK abort classes) to the DOM-standard
			// AbortError. The abort fires inside the request so the cancellation
			// scope still lets the model lookup finish and the catch observes an
			// aborted signal.
			const controller = new AbortController()
			mockCreate.mockImplementationOnce(async (_params: unknown, _options: { signal?: AbortSignal }) => {
				controller.abort()
				throw new Error("boom")
			})
			const handler = new ZooGatewayHandler(mockOptions)

			const error = await handler.completePrompt("test prompt", { abortSignal: controller.signal }).then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Zoo Gateway request was aborted")
		})

		it("should preserve abort identity for a name-based AbortError rejection", async () => {
			// No aborted signal and no SDK abort class: only the DOM-standard
			// name === "AbortError" check marks a cancelled request.
			mockCreate.mockRejectedValueOnce(Object.assign(new Error("raw"), { name: "AbortError" }))
			const handler = new ZooGatewayHandler(mockOptions)

			const error = await handler.completePrompt("test prompt").then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Zoo Gateway request was aborted")
		})
		it("should work without options (backward compatible)", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			mockCreate.mockImplementation(async () => ({
				choices: [{ message: { role: "assistant", content: "response" } }],
			}))

			const result = await handler.completePrompt("test prompt")
			expect(result).toBe("response")
		})
	})

	it("completePrompt settles on the abort before the auth check when the signal is already aborted", async () => {
		// The entry guard must win over the fallible auth step, exactly as in
		// createMessage: a cancelled task does not run auth or the catalog lookup.
		const handler = new ZooGatewayHandler(mockOptions)
		const controller = new AbortController()
		controller.abort()

		const error = await handler.completePrompt("test prompt", { abortSignal: controller.signal }).then(
			() => undefined,
			(caught: unknown) => caught,
		)

		expect(error).toMatchObject({ name: "AbortError" })
		expect((error as Error).message).toBe("The Zoo Gateway request was aborted")
		expect(vitest.mocked(getModels)).not.toHaveBeenCalled()
	})

	it("completePrompt keeps the guard ahead of the auth check when the session is unauthenticated", async () => {
		// The guard is not equivalent to the helper's own aborted check: with no
		// session token the auth step runs first and would raise its own error,
		// so the fast-fail must win before ensureAuthenticated.
		const handler = new ZooGatewayHandler({ ...mockOptions, zooSessionToken: undefined })
		const controller = new AbortController()
		controller.abort()

		const error = await handler.completePrompt("test prompt", { abortSignal: controller.signal }).then(
			() => undefined,
			(caught: unknown) => caught,
		)

		expect(error).toMatchObject({ name: "AbortError" })
		expect((error as Error).message).toBe("The Zoo Gateway request was aborted")
		expect(mockCreate).not.toHaveBeenCalled()
		expect(vitest.mocked(getModels)).not.toHaveBeenCalled()
	})

	it("completePrompt settles on the abort while model resolution is pending", async () => {
		// The catalog lookup parks forever, so the prompt can only settle through
		// the cancellation scope around the lookup; without it the handler waits
		// for the catalog and then issues the SDK request.
		let releaseGate!: () => void
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve
		})
		let markLookupParked!: () => void
		const lookupParked = new Promise<void>((resolve) => {
			markLookupParked = resolve
		})
		vitest.mocked(getModels).mockImplementationOnce(async () => {
			markLookupParked()
			await gate
			return {}
		})

		const handler = new ZooGatewayHandler(mockOptions)
		const controller = new AbortController()

		const completion = handler.completePrompt("test prompt", { abortSignal: controller.signal })
		await lookupParked
		controller.abort()

		const error = await completion.then(
			() => undefined,
			(caught: unknown) => caught,
		)
		// Release the parked lookup so the disposable mock does not leak into the
		// next test in the file.
		releaseGate()
		expect(mockCreate).not.toHaveBeenCalled()
		expect(error).toMatchObject({ name: "AbortError" })
		expect((error as Error).message).toBe("The Zoo Gateway request was aborted")
	})
	describe("createMessage abort signal bridging", () => {
		it("rejects with the standardized AbortError before any request work when the external signal is already aborted", async () => {
			// A pre-aborted request must fail fast before any model-catalog or
			// SDK work starts: the standardized AbortError wins over any
			// resolution failure, and the request itself never begins.
			let capturedSignal: AbortSignal | undefined
			mockCreate.mockImplementation(async (_params: unknown, options: { signal?: AbortSignal }) => {
				capturedSignal = options?.signal
				throw new Error("boom")
			})

			const handler = new ZooGatewayHandler(mockOptions)
			const controller = new AbortController()
			controller.abort()

			const stream = handler.createMessage(
				"prompt",
				[{ role: "user", content: "hello" }],
				makeCreateMessageMetadata({ abortSignal: controller.signal }),
			)

			const error = await collectStream(stream).then(
				() => undefined,
				(e: unknown) => e,
			)
			// The fast-fail guard rejects before the request starts.
			expect(mockCreate).not.toHaveBeenCalled()
			// Pre-flight cancellation must skip the model catalog entirely:
			// the getModels mock must remain uncalled, not just the SDK create.
			expect(getModels).not.toHaveBeenCalled()
			expect(capturedSignal).toBeUndefined()
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Zoo Gateway request was aborted")
		})

		it("rejects with the standardized AbortError before the auth check when the external signal is already aborted and the session is unauthenticated", async () => {
			// The entry fast-fail must win over the auth failure: with no
			// session token a pre-aborted request surfaces the standardized
			// AbortError, not the auth error the unauthenticated fall-through
			// would raise.
			let capturedSignal: AbortSignal | undefined
			mockCreate.mockImplementation(async (_params: unknown, options: { signal?: AbortSignal }) => {
				capturedSignal = options?.signal
				throw new Error("boom")
			})

			const handler = new ZooGatewayHandler({ ...mockOptions, zooSessionToken: undefined })
			const controller = new AbortController()
			controller.abort()

			const stream = handler.createMessage(
				"prompt",
				[{ role: "user", content: "hello" }],
				makeCreateMessageMetadata({ abortSignal: controller.signal }),
			)

			const error = await collectStream(stream).then(
				() => undefined,
				(e: unknown) => e,
			)
			// The fast-fail guard rejects before the auth check and the request.
			expect(mockCreate).not.toHaveBeenCalled()
			expect(getModels).not.toHaveBeenCalled()
			expect(capturedSignal).toBeUndefined()
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Zoo Gateway request was aborted")
		})

		it("rejects with the standardized AbortError when the external signal aborts while model resolution is pending", async () => {
			// The model catalog stays pending while the external signal aborts:
			// the resolution race must settle with the standardized AbortError
			// before the lookup is released, and the request itself must never
			// start. A bridge-only fix would let the lookup finish and abort the
			// internal controller after the fact; this gate proves the prompt
			// settles on the abort itself.
			let releaseResolution!: () => void
			const resolutionGate = new Promise<void>((resolve) => {
				releaseResolution = resolve
			})
			let markLookupParked!: () => void
			const lookupParked = new Promise<void>((resolve) => {
				markLookupParked = resolve
			})
			vitest.mocked(getModels).mockImplementationOnce(async () => {
				markLookupParked()
				await resolutionGate
				return DEFAULT_MODEL_CATALOG
			})

			const handler = new ZooGatewayHandler(mockOptions)
			const controller = new AbortController()

			const consumed = collectStream(
				handler.createMessage(
					"prompt",
					[{ role: "user", content: "hello" }],
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				),
			)

			// Let the lookup park on the gate, then abort while it is still pending.
			await lookupParked
			controller.abort()

			const error = await consumed.then(
				() => undefined,
				(e: unknown) => e,
			)
			// The catalog lookup was attempted but the prompt must have settled
			// on the abort itself, before the lookup was released: no SDK call.
			expect(getModels).toHaveBeenCalledTimes(1)
			expect(mockCreate).not.toHaveBeenCalled()
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Zoo Gateway request was aborted")

			// Releasing the lookup afterwards must not start a late request.
			releaseResolution()
			// A late request is an absence, so give the released continuation a real observation window.
			// vi.waitFor resolves as soon as its callback stops throwing, and a callback that only returns a
			// falsy value never throws at all (measured on vitest 4.1.12: it settled well inside the timeout),
			// so polling the call count here would not wait. The assertion below is what fails when a late
			// request appears.
			await observeWindow(50)
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("aborts the in-flight request when the external signal fires mid-stream", async () => {
			// The mock polls the INTERNAL controller signal (bounded 40x5ms)
			// instead of waiting for an "abort" event, so the test can never
			// hang if the bridge stops forwarding aborts.
			let capturedSignal: AbortSignal | undefined
			mockCreate.mockImplementation(async (_params: unknown, options: { signal?: AbortSignal }) => {
				capturedSignal = options?.signal
				return (async function* () {
					yield { choices: [{ delta: { content: "partial" }, index: 0 }], index: 0 }
					// Reached only when the consumer asks for the next chunk, i.e. the first chunk is
					// delivered: fire the caller's abort here so the abort is mid-stream by construction.
					controller.abort()
					if (capturedSignal?.aborted) {
						throw new DOMException("The operation was aborted.", "AbortError")
					}
				})()
			})

			const handler = new ZooGatewayHandler(mockOptions)
			const controller = new AbortController()

			const consumed = collectStream(
				handler.createMessage(
					"prompt",
					[{ role: "user", content: "hello" }],
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				),
			)

			// Let the request start and the first chunk be yielded before aborting.
			// The mock calls controller.abort() the moment the first chunk has been consumed,

			const error = await consumed.then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(capturedSignal?.aborted).toBe(true)
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Zoo Gateway request was aborted")
		})

		it("surfaces a cancel when the SDK closes the stream without throwing", async () => {
			// The SDK consumes the body-read abort itself and can end the iterator normally, so the
			// provider must inspect the caller signal rather than read that quiet end as a completed turn.
			const controller = new AbortController()
			let lateChunkReads = 0
			mockCreate.mockImplementationOnce(async () =>
				(async function* () {
					yield { choices: [{ delta: { content: "a" } }], index: 0 }
					controller.abort()
					// A frame still queued behind the cancel: pulling it is fine, reading it is not.
					yield {
						get choices() {
							lateChunkReads += 1
							return [{ delta: { content: "late" }, index: 0 }]
						},
						index: 0,
					}
				})(),
			)
			const handler = new ZooGatewayHandler(mockOptions)
			const error = await collectStream(
				handler.createMessage(
					"system",
					[{ role: "user", content: "hi" }],
					makeCreateMessageMetadata({
						abortSignal: controller.signal,
					}),
				),
			).then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Zoo Gateway request was aborted")
			expect(lateChunkReads).toBe(0) // the cancelled stream is not read again
		})

		it("does not emit the usage item of a frame whose text was already taken", async () => {
			// The usage item is the last thing this iteration can hand over, so a cancel between the text and
			// the usage must reject rather than bill a turn the caller already cancelled.
			// Observable condition below: the text reaches the consumer first, then the cancel lands.
			const frame = {
				choices: [{ delta: { content: "answer" } }],
				usage: { prompt_tokens: 1, completion_tokens: 2, cost: 0.01 },
				index: 0,
			}
			mockCreate.mockImplementationOnce(async () => asyncStreamFrom([frame]))
			const controller = new AbortController()
			const handler = new ZooGatewayHandler(mockOptions)
			const iterator = handler
				.createMessage(
					"system",
					[{ role: "user", content: "hi" }],
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				)
				[Symbol.asyncIterator]()

			const first = await iterator.next()
			expect(first.value).toMatchObject({ type: "text", text: "answer" })
			// Observable condition: this item reached the consumer; the frame still owes its next item.
			controller.abort()

			const settled = await iterator.next().then(
				(result) => result.value,
				(error: unknown) => error,
			)
			expect(settled).toMatchObject({ name: "AbortError" })
			expect((settled as Error).message).toBe("The Zoo Gateway request was aborted")

			// The same frame with a live caller signal still delivers both items.
			mockCreate.mockImplementationOnce(async () => asyncStreamFrom([frame]))
			const live = new AbortController()
			const chunks = await collectStream(
				handler.createMessage(
					"system",
					[{ role: "user", content: "hi" }],
					makeCreateMessageMetadata({ abortSignal: live.signal }),
				),
			)
			expect(chunks.map((chunk: { type: string }) => chunk.type)).toEqual(["text", "usage"])
		})

		it("does not emit the rest of a tool-call chunk once the caller cancels", async () => {
			// Consumer-driven: take the first partial, cancel, then require the next call to reject without
			// building the second one. The getter variant aborted before either partial existed, so it could
			// not tell a per-partial check apart from a check in front of the whole frame.
			const controller = new AbortController()
			let laterToolCallReads = 0
			const toolCalls = [
				{
					index: 0,
					id: "call_1",
					type: "function",
					function: { name: "get_weather", arguments: '{"city":"NYC"}' },
				},
				{
					get index() {
						laterToolCallReads += 1
						return 0
					},
					id: "call_2",
					type: "function",
					function: { name: "get_time", arguments: '{"tz":"UTC"}' },
				},
			]
			mockCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([{ choices: [{ delta: { tool_calls: toolCalls } }], index: 0 }]),
			)
			const handler = new ZooGatewayHandler(mockOptions)
			const iterator = handler
				.createMessage(
					"system",
					[{ role: "user", content: "hi" }],
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				)
				[Symbol.asyncIterator]()

			const first = await iterator.next()
			expect(first.value).toMatchObject({ type: "tool_call_partial", id: "call_1" })
			// Observable condition: the first partial reached the consumer, so the cancel lands between partials.
			controller.abort()

			const settled = await iterator.next().then(
				(result) => result.value,
				(error: unknown) => error,
			)
			expect(settled).toMatchObject({ name: "AbortError" })
			expect((settled as Error).message).toBe("The Zoo Gateway request was aborted")
			expect(laterToolCallReads).toBe(0) // the second partial is never built
		})

		it("settles the stream at once when the caller cancels while create() is pending", async () => {
			// The SDK waits out a Retry-After backoff without observing the signal, so an in-flight create
			// can outlive the cancel; a never-settling create reproduces that wait.
			mockCreate.mockImplementation(() => new Promise<never>(() => {}))
			const controller = new AbortController()
			const handler = new ZooGatewayHandler(mockOptions)
			const collecting = collectStream(
				handler.createMessage(
					"system",
					[{ role: "user", content: "hi" }],
					makeCreateMessageMetadata({
						abortSignal: controller.signal,
					}),
				),
			).then(
				() => "resolved",
				(e: unknown) => e,
			)
			// Cancel only once the lookup has settled and the SDK call is in flight: an earlier abort would
			// be answered by the model-lookup race rather than this one.
			await vi.waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
			controller.abort()
			const settled = await Promise.race([collecting, observeWindow(200)])
			expect(settled).not.toBe("pending") // an in-flight create must not outlive the cancel
			expect(settled).not.toBe("resolved")
			expect(settled).toMatchObject({ name: "AbortError" })
			expect((settled as Error).message).toBe("The Zoo Gateway request was aborted")
		})

		it("settles at once when the caller cancels while the add-credits prompt is open", async () => {
			// The 402 notification waits for the user: unless it is raced like the completion is, the
			// iterator stays parked on the original 402 and the cancel never settles the stream.
			const controller = new AbortController()
			const consoleError = vitest.spyOn(console, "error").mockImplementation(() => {})
			try {
				mockCreate.mockImplementationOnce(function () {
					throw makeApiError(402)
				})
				showErrorMessage.mockImplementationOnce(() => new Promise<never>(() => {}))
				const handler = new ZooGatewayHandler(mockOptions)
				const draining = collectStream(
					handler.createMessage(
						"system",
						[{ role: "user", content: "hi" }],
						makeCreateMessageMetadata({
							abortSignal: controller.signal,
						}),
					),
				).then(
					() => "resolved",
					(e: unknown) => e,
				)
				await vi.waitFor(() => expect(showErrorMessage).toHaveBeenCalledTimes(1))
				controller.abort()
				const settled = await Promise.race([draining, observeWindow(200)])
				expect(settled).not.toBe("pending") // the open prompt must not outlive the cancel
				expect(settled).not.toBe("resolved")
				expect(settled).toMatchObject({ name: "AbortError" })
				expect((settled as Error).message).toBe("The Zoo Gateway request was aborted")
				// A cancelled prompt is not a surfacing failure, so it must not log like one (as completePrompt
				// already avoids on its own abort path).
				expect(consoleError).not.toHaveBeenCalled()
			} finally {
				consoleError.mockRestore()
			}
		})

		it("logs a failed add-credits notification on the streaming path and still rethrows the gateway error", async () => {
			// The streaming catch reaches the same surfacing failure completePrompt does. With the caller's
			// signal live the log is the only evidence that the notification itself failed: the guard in
			// front of the console call must not swallow it, and the original 402 must still reach the
			// caller instead of an AbortError.
			const controller = new AbortController()
			const consoleError = vitest.spyOn(console, "error").mockImplementation(() => {})
			try {
				mockCreate.mockImplementationOnce(function () {
					throw makeApiError(402, { message: "out of credits" })
				})
				showErrorMessage.mockImplementationOnce(() => Promise.reject(new Error("notification failed")))
				const handler = new ZooGatewayHandler(mockOptions)

				const settled = await collectStream(
					handler.createMessage(
						"system",
						[{ role: "user", content: "hi" }],
						makeCreateMessageMetadata({ abortSignal: controller.signal }),
					),
				).then(
					() => "resolved",
					(e: unknown) => e,
				)
				expect(consoleError).toHaveBeenCalledWith("Failed to surface Zoo Gateway error:", "notification failed")
				expect((settled as Error).message).toContain("out of credits")
				expect((settled as Error).name).not.toBe("AbortError")
				expect(controller.signal.aborted).toBe(false)
			} finally {
				consoleError.mockRestore()
			}
		})

		it("normalizes a name-based AbortError on the streaming path without running the gateway notification", async () => {
			// No aborted signal and no SDK abort class: only the DOM-standard name marks a cancelled
			// request. Without the classification in front of the notification path this rejection falls
			// through into the add-credits surfacing and the raw error reaches the caller instead of the
			// contract identity, which is what the two assertions below discriminate.
			const controller = new AbortController()
			const consoleError = vitest.spyOn(console, "error").mockImplementation(() => {})
			try {
				const rawAbort = Object.assign(new Error("raw"), { name: "AbortError" })
				mockCreate.mockImplementationOnce(function () {
					throw rawAbort
				})
				const handler = new ZooGatewayHandler(mockOptions)

				const settled = await collectStream(
					handler.createMessage(
						"system",
						[{ role: "user", content: "hi" }],
						makeCreateMessageMetadata({ abortSignal: controller.signal }),
					),
				).then(
					() => "resolved",
					(e: unknown) => e,
				)
				expect(settled).toMatchObject({ name: "AbortError", message: "The Zoo Gateway request was aborted" })
				expect(showErrorMessage).not.toHaveBeenCalled()
				expect(consoleError).not.toHaveBeenCalled()
			} finally {
				consoleError.mockRestore()
			}
		})

		it.each(["mid-stream throw", "rejected create()", "early gen.return()"] as const)(
			"detaches the bridged abort listener on %s",
			async (mode) => {
				const controller = new AbortController()
				const addEventListenerSpy = vi.spyOn(controller.signal, "addEventListener")
				const removeListenerSpy = vi.spyOn(controller.signal, "removeEventListener")

				if (mode === "rejected create()") {
					mockCreate.mockRejectedValueOnce(new Error("boom"))
				} else if (mode === "mid-stream throw") {
					mockCreate.mockImplementationOnce(async () =>
						(async function* () {
							yield { choices: [{ delta: { content: "p" }, index: 0 }], index: 0 }
							throw new Error("boom")
						})(),
					)
				} else {
					mockCreate.mockImplementationOnce(async () =>
						(async function* () {
							yield { choices: [{ delta: { content: "p" }, index: 0 }], index: 0 }
							await new Promise<void>(() => {})
						})(),
					)
				}

				const handler = new ZooGatewayHandler(mockOptions)
				const iterator = handler
					.createMessage(
						"prompt",
						[{ role: "user", content: "hello" }],
						makeCreateMessageMetadata({ abortSignal: controller.signal }),
					)
					[Symbol.asyncIterator]()

				if (mode === "early gen.return()") {
					await iterator.next()
					await iterator.return?.(undefined)
				} else {
					await iterator.next().catch(() => undefined)
					await iterator.next().catch(() => undefined)
					await iterator.return?.(undefined)
				}

				const abortAddCalls = addEventListenerSpy.mock.calls.filter(([event]) => event === "abort")
				const abortRemoveCalls = removeListenerSpy.mock.calls.filter(([event]) => event === "abort")
				const bridgeListener = abortAddCalls.at(-1)?.[1]
				expect(abortAddCalls.length).toBeGreaterThan(0)
				expect(abortRemoveCalls.some(([, listener]) => listener === bridgeListener)).toBe(true)
			},
		)

		it("detaches the bridged abort listener when the request completes normally", async () => {
			// The listener is added with { once: true }, so it only detaches on
			// abort. A task-scoped signal spanning many requests must not
			// accumulate a listener per request: assert explicit removal after a
			// normal (non-aborted) completion.
			mockCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{
						choices: [{ delta: { content: "ok" }, index: 0 }],
						index: 0,
					},
					{
						choices: [{ delta: {}, index: 0 }],
						index: 0,
						usage: { prompt_tokens: 2, completion_tokens: 3 },
					},
				]),
			)

			const handler = new ZooGatewayHandler(mockOptions)
			const controller = new AbortController()
			const removeListenerSpy = vi.spyOn(controller.signal, "removeEventListener")
			const addEventListenerSpy = vi.spyOn(controller.signal, "addEventListener")

			const stream = handler.createMessage(
				"prompt",
				[{ role: "user", content: "hello" }],
				makeCreateMessageMetadata({ abortSignal: controller.signal }),
			)

			const chunks = await collectStream(stream)
			expect(chunks).toContainEqual({ type: "text", text: "ok" })
			// Assert the exact listener reference so a bridge that removes a
			// different callback than the one it registered cannot pass.
			// The rejectOnAbort race registers its own "abort" listener on the
			// same external signal during model resolution, so the first "abort"
			// registration is the race's, not the bridge's. Target the last
			// registration so the options/removal assertions below cannot be
			// satisfied by the race's listener.
			const abortAddCalls = addEventListenerSpy.mock.calls.filter(([event]) => event === "abort")
			const addedListener = abortAddCalls[abortAddCalls.length - 1]?.[1]
			expect(typeof addedListener).toBe("function")
			// The listener is registered with { once: true } — assert the exact
			// options so a bridge that drops them (and relies on the finally
			// block alone for single-shot semantics) is caught.
			expect(addEventListenerSpy).toHaveBeenCalledWith("abort", addedListener, { once: true })
			expect(removeListenerSpy).toHaveBeenCalledWith("abort", addedListener)
			expect(controller.signal.aborted).toBe(false)
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
