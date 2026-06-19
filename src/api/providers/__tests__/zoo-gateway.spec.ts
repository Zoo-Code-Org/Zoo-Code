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

import OpenAI from "openai"

import { zooGatewayDefaultModelId, ZOO_GATEWAY_DEFAULT_TEMPERATURE } from "@roo-code/types"

import { ZooGatewayHandler, classifyGatewayApiError, toGatewayStreamError } from "../zoo-gateway"
import { ApiHandlerOptions } from "../../../shared/api"
import { Package } from "../../../shared/package"
import { clearZooCodeToken } from "../../../services/zoo-code-auth"

vitest.mock("openai")
vitest.mock("delay", () => ({
	default: vitest.fn(function () {
		return Promise.resolve()
	}),
}))
vitest.mock("../fetchers/modelCache", () => ({
	getModels: vitest.fn().mockImplementation(function () {
		return Promise.resolve({
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
		})
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

	beforeEach(() => {
		vitest.clearAllMocks()
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
		const stream = handler.createMessage("system", [{ role: "user", content: "hi" }])
		const out: unknown[] = []
		for await (const chunk of stream) {
			out.push(chunk)
		}
		return out
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
			mockCreate.mockImplementation(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield {
						choices: [{ delta: { content: "Test response" }, index: 0 }],
						usage: null,
					}
					yield {
						choices: [{ delta: {}, index: 0 }],
						usage: {
							prompt_tokens: 10,
							completion_tokens: 5,
							total_tokens: 15,
							cache_creation_input_tokens: 2,
							prompt_tokens_details: { cached_tokens: 3 },
							cost: 0.005,
						},
					}
				},
			}))
		})

		it("requires authentication at request time when no session token is available", async () => {
			const handler = new ZooGatewayHandler({})
			const stream = handler.createMessage("You are helpful.", [{ role: "user", content: "Hello" }])

			await expect(async () => {
				for await (const _chunk of stream) {
					// drain
				}
			}).rejects.toThrow("Zoo Gateway requires authentication. Please sign in to Zoo Code first.")
		})

		it("streams text and usage chunks", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			const stream = handler.createMessage("You are helpful.", [{ role: "user", content: "Hello" }])

			const chunks = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

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
			mockCreate.mockImplementation(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield {
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
					}
				},
			}))

			const handler = new ZooGatewayHandler(mockOptions)
			const chunks = []
			for await (const chunk of handler.createMessage("prompt", [])) {
				chunks.push(chunk)
			}

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
			mockCreate.mockImplementation(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield {
						error: {
							message: "Too many requests, please wait before trying again",
							status: 429,
							code: "rate_limited",
						},
					}
				},
			}))

			const handler = new ZooGatewayHandler(mockOptions)

			await expect(drainCreateMessage(handler)).rejects.toThrow(
				"Too many requests, please wait before trying again",
			)
		})

		it("surfaces the add-credits prompt when an in-stream error carries a budget code", async () => {
			mockCreate.mockImplementation(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield {
						error: {
							message: "Monthly budget exceeded",
							status: 429,
							code: "monthly_budget_exceeded",
						},
					}
				},
			}))

			const handler = new ZooGatewayHandler(mockOptions)

			await expect(drainCreateMessage(handler)).rejects.toThrow()
			expect(showErrorMessage).toHaveBeenCalledWith(
				"common:zooAuth.errors.budget_exceeded",
				"common:zooAuth.buttons.add_credits",
			)
		})
	})

	describe("completePrompt", () => {
		beforeEach(() => {
			mockCreate.mockImplementation(async () => ({
				choices: [{ message: { role: "assistant", content: "Test completion response" } }],
			}))
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

		it("returns an empty string when the model returns no content", async () => {
			const handler = new ZooGatewayHandler(mockOptions)
			mockCreate.mockImplementation(async () => ({
				choices: [{ message: { role: "assistant", content: null } }],
			}))

			await expect(handler.completePrompt("Test")).resolves.toBe("")
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
})
