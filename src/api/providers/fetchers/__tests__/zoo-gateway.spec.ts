// npx vitest run src/api/providers/fetchers/__tests__/zoo-gateway.spec.ts

import axios from "axios"

import type { ApiHandlerOptions } from "../../../../shared/api"
import type { VercelAiGatewayModel } from "../vercel-ai-gateway"
import { getZooGatewayModels, parseZooGatewayModel } from "../zoo-gateway"

vitest.mock("axios")
vitest.mock("../../../../services/zoo-code-auth", () => ({
	getCachedZooCodeToken: vitest.fn(function () {
		return ""
	}),
	getZooCodeBaseUrl: vitest.fn(function () {
		return "https://example.test"
	}),
	resolveZooGatewaySessionToken: vitest.fn(function (profileToken?: string) {
		return profileToken || undefined
	}),
}))

const mockAxiosGet = vi.mocked(axios.get)

function modelsFromResult(result: Awaited<ReturnType<typeof getZooGatewayModels>>) {
	return result.kind === "ok" ? result.models : {}
}

function gatewayOptions(
	overrides: Partial<ApiHandlerOptions & { ifNoneMatch?: string }> = {},
): ApiHandlerOptions & { ifNoneMatch?: string } {
	return {
		zooGatewayBaseUrl: "https://example.test/api/gateway/v1",
		zooSessionToken: "zoo_ext_test_token",
		...overrides,
	}
}

describe("Zoo Gateway Fetchers", () => {
	beforeEach(() => {
		vitest.clearAllMocks()
	})

	describe("getZooGatewayModels", () => {
		const baseUrl = "https://example.test/api/gateway/v1"
		const token = "zoo_ext_test_token"

		const mockResponse = {
			status: 200,
			headers: { etag: '"catalog-abc"' },
			data: {
				object: "list",
				data: [
					{
						id: "anthropic/claude-sonnet-4",
						object: "model",
						created: 1640995200,
						owned_by: "anthropic",
						name: "Claude Sonnet 4",
						description: "Sonnet 4",
						context_window: 200000,
						max_tokens: 64000,
						type: "language",
						pricing: {
							input: "3.00",
							output: "15.00",
							input_cache_write: "3.75",
							input_cache_read: "0.30",
						},
					},
					{
						id: "image/dall-e-3",
						object: "model",
						created: 1640995200,
						owned_by: "openai",
						name: "DALL-E 3",
						description: "Image",
						context_window: 4000,
						max_tokens: 1000,
						type: "image",
						pricing: { input: "40.00", output: "0.00" },
					},
				],
			},
		}

		it("forwards the bearer token and timeout, filters non-language models", async () => {
			mockAxiosGet.mockResolvedValueOnce(mockResponse)

			const result = await getZooGatewayModels(gatewayOptions())

			const axiosConfig = mockAxiosGet.mock.calls[0]?.[1]
			expect(axiosConfig?.validateStatus?.(200)).toBe(true)
			expect(axiosConfig?.validateStatus?.(304)).toBe(true)
			expect(axiosConfig?.validateStatus?.(500)).toBe(false)

			expect(mockAxiosGet).toHaveBeenCalledWith(
				`${baseUrl}/models`,
				expect.objectContaining({
					headers: expect.objectContaining({ Authorization: `Bearer ${token}` }),
					timeout: expect.any(Number),
					validateStatus: expect.any(Function),
				}),
			)
			expect(result.kind).toBe("ok")
			if (result.kind !== "ok") return
			expect(Object.keys(result.models)).toHaveLength(1)
			expect(result.models["anthropic/claude-sonnet-4"]).toBeDefined()
			expect(result.etag).toBe('"catalog-abc"')
		})

		it("reads ETag from the capitalized response header", async () => {
			mockAxiosGet.mockResolvedValueOnce({
				...mockResponse,
				headers: { ETag: '"catalog-capital"' },
			})

			const result = await getZooGatewayModels(gatewayOptions())

			expect(result.kind).toBe("ok")
			if (result.kind !== "ok") return
			expect(result.etag).toBe('"catalog-capital"')
		})

		it("sends If-None-Match when provided and returns not_modified on 304", async () => {
			mockAxiosGet.mockResolvedValueOnce({ status: 304, headers: {}, data: "" })

			const result = await getZooGatewayModels(
				gatewayOptions({
					ifNoneMatch: '"catalog-abc"',
				}),
			)

			expect(mockAxiosGet).toHaveBeenCalledWith(
				`${baseUrl}/models`,
				expect.objectContaining({
					headers: expect.objectContaining({
						Authorization: `Bearer ${token}`,
						"If-None-Match": '"catalog-abc"',
					}),
				}),
			)
			expect(result).toEqual({ kind: "not_modified" })

			const validateStatus = mockAxiosGet.mock.calls[0]?.[1]?.validateStatus
			expect(validateStatus?.(304)).toBe(true)
			expect(validateStatus?.(200)).toBe(true)
			expect(validateStatus?.(500)).toBe(false)
		})

		it("skips the request and returns {} when no token is available", async () => {
			const result = await getZooGatewayModels(gatewayOptions({ zooSessionToken: undefined }))

			expect(mockAxiosGet).not.toHaveBeenCalled()
			expect(modelsFromResult(result)).toEqual({})
		})

		it("returns {} and never leaks the error object when the request fails", async () => {
			const consoleErrorSpy = vitest.spyOn(console, "error").mockImplementation(function () {})
			const failure = Object.assign(new Error("Network error"), {
				config: { headers: { Authorization: "Bearer should-never-be-logged" } },
				code: "ECONNRESET",
				response: { status: 502, statusText: "Bad Gateway" },
			})
			mockAxiosGet.mockRejectedValueOnce(failure)

			const result = await getZooGatewayModels(gatewayOptions())

			expect(modelsFromResult(result)).toEqual({})
			const logged = consoleErrorSpy.mock.calls.map((args) => String(args[0])).join("\n")
			expect(logged).toContain("status=502")
			expect(logged).toContain("code=ECONNRESET")
			expect(logged).not.toContain("should-never-be-logged")
			expect(logged).not.toContain("Authorization")
			consoleErrorSpy.mockRestore()
		})

		it("accepts gateway catalog models without created or description (e.g. Bedrock)", async () => {
			mockAxiosGet.mockResolvedValueOnce({
				status: 200,
				headers: {},
				data: {
					object: "list",
					data: [
						{
							id: "anthropic/claude-sonnet-4",
							object: "model",
							owned_by: "anthropic",
							name: "Claude Sonnet 4",
							context_window: 200000,
							max_tokens: 64000,
							type: "language",
							pricing: {
								input: "3.00",
								output: "15.00",
							},
						},
					],
				},
			})

			const result = await getZooGatewayModels(gatewayOptions())

			expect(Object.keys(modelsFromResult(result))).toEqual(["anthropic/claude-sonnet-4"])
			if (result.kind !== "ok") return
			expect(result.models["anthropic/claude-sonnet-4"].description).toBe("Claude Sonnet 4")
		})
		it("returns {} on a structurally broken response instead of throwing", async () => {
			const consoleErrorSpy = vitest.spyOn(console, "error").mockImplementation(function () {})
			mockAxiosGet.mockResolvedValueOnce({ status: 200, headers: {}, data: { unexpected: true } })

			const result = await getZooGatewayModels(gatewayOptions())

			expect(modelsFromResult(result)).toEqual({})
			expect(consoleErrorSpy).toHaveBeenCalled()
			consoleErrorSpy.mockRestore()
		})
	})

	describe("parseZooGatewayModel", () => {
		it("enables image attachment from Zoo Gateway vision tags", () => {
			const result = parseZooGatewayModel({
				id: "anthropic/claude-sonnet-4.5",
				model: {
					id: "anthropic/claude-sonnet-4.5",
					object: "model",
					owned_by: "anthropic",
					name: "Claude Sonnet 4.5",
					context_window: 200000,
					max_tokens: 64000,
					type: "language",
					tags: ["tool-use", "vision"],
					pricing: {
						input: "3.00",
						output: "15.00",
					},
				},
			})

			expect(result.supportsImages).toBe(true)
		})

		it("delegates to the vercel-ai-gateway parser", () => {
			const model: VercelAiGatewayModel = {
				id: "anthropic/claude-sonnet-4",
				object: "model",
				created: 0,
				owned_by: "anthropic",
				name: "Claude Sonnet 4",
				description: "Sonnet",
				context_window: 200000,
				max_tokens: 64000,
				type: "language",
				pricing: {
					input: "3.00",
					output: "15.00",
					input_cache_write: "3.75",
					input_cache_read: "0.30",
				},
			}

			const result = parseZooGatewayModel({
				id: "anthropic/claude-sonnet-4",
				model,
			})

			expect(result.contextWindow).toBe(200000)
			expect(result.maxTokens).toBe(64000)
			expect(result.supportsPromptCache).toBe(true)
		})
	})
})
