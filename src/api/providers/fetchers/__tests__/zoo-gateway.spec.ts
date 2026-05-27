// npx vitest run src/api/providers/fetchers/__tests__/zoo-gateway.spec.ts

import axios from "axios"

import { getZooGatewayModels, parseZooGatewayModel } from "../zoo-gateway"

vitest.mock("axios")
vitest.mock("../../../../services/zoo-code-auth", () => ({
	getCachedZooCodeToken: vitest.fn(() => ""),
	getZooCodeBaseUrl: vitest.fn(() => "https://example.test"),
}))
const mockedAxios = axios as any

describe("Zoo Gateway Fetchers", () => {
	beforeEach(() => {
		vitest.clearAllMocks()
	})

	describe("getZooGatewayModels", () => {
		const baseUrl = "https://example.test/api/gateway/v1"
		const token = "zoo_ext_test_token"

		const mockResponse = {
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
			mockedAxios.get.mockResolvedValueOnce(mockResponse)

			const models = await getZooGatewayModels({
				zooGatewayBaseUrl: baseUrl,
				zooSessionToken: token,
			} as any)

			expect(mockedAxios.get).toHaveBeenCalledWith(
				`${baseUrl}/models`,
				expect.objectContaining({
					headers: expect.objectContaining({ Authorization: `Bearer ${token}` }),
					timeout: expect.any(Number),
				}),
			)
			expect(Object.keys(models)).toHaveLength(1)
			expect(models["anthropic/claude-sonnet-4"]).toBeDefined()
		})

		it("omits the Authorization header when no token is provided", async () => {
			mockedAxios.get.mockResolvedValueOnce(mockResponse)

			await getZooGatewayModels({ zooGatewayBaseUrl: baseUrl } as any)

			const call = mockedAxios.get.mock.calls[0]
			expect(call[1].headers.Authorization).toBeUndefined()
		})

		it("returns {} and never leaks the error object when the request fails", async () => {
			const consoleErrorSpy = vitest.spyOn(console, "error").mockImplementation(() => {})
			const failure: any = new Error("Network error")
			// Simulate axios attaching the request config (which contains the bearer token).
			failure.config = { headers: { Authorization: "Bearer should-never-be-logged" } }
			failure.code = "ECONNRESET"
			failure.response = { status: 502, statusText: "Bad Gateway" }
			mockedAxios.get.mockRejectedValueOnce(failure)

			const models = await getZooGatewayModels({
				zooGatewayBaseUrl: baseUrl,
				zooSessionToken: token,
			} as any)

			expect(models).toEqual({})
			const logged = consoleErrorSpy.mock.calls.map((args) => String(args[0])).join("\n")
			expect(logged).toContain("status=502")
			expect(logged).toContain("code=ECONNRESET")
			expect(logged).not.toContain("should-never-be-logged")
			expect(logged).not.toContain("Authorization")
			consoleErrorSpy.mockRestore()
		})

		it("returns {} on a structurally broken response instead of throwing", async () => {
			const consoleErrorSpy = vitest.spyOn(console, "error").mockImplementation(() => {})
			mockedAxios.get.mockResolvedValueOnce({ data: { unexpected: true } })

			const models = await getZooGatewayModels({
				zooGatewayBaseUrl: baseUrl,
				zooSessionToken: token,
			} as any)

			expect(models).toEqual({})
			expect(consoleErrorSpy).toHaveBeenCalled()
			consoleErrorSpy.mockRestore()
		})
	})

	describe("parseZooGatewayModel", () => {
		it("delegates to the vercel-ai-gateway parser", () => {
			const result = parseZooGatewayModel({
				id: "anthropic/claude-sonnet-4",
				model: {
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
				} as any,
			})

			expect(result.contextWindow).toBe(200000)
			expect(result.maxTokens).toBe(64000)
			expect(result.supportsPromptCache).toBe(true)
		})
	})
})
