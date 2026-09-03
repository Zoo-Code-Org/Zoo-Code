import { buildApiHandler } from "../../index"
import { KimiCodeHandler } from "../kimi-code"

import { clearAllMocks } from "../../../test-utils/reset"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

const { mockGetAccessToken, mockForceRefreshAccessToken, mockGetModels } = vi.hoisted(() => ({
	mockGetAccessToken: vi.fn(),
	mockForceRefreshAccessToken: vi.fn(),
	mockGetModels: vi.fn(),
}))

vi.mock("../../../integrations/kimi-code/oauth", () => ({
	kimiCodeOAuthManager: {
		getAccessToken: mockGetAccessToken,
		forceRefreshAccessToken: mockForceRefreshAccessToken,
	},
}))

vi.mock("../fetchers/modelCache", () => ({
	getModels: mockGetModels,
	refreshModels: mockGetModels,
}))

describe("KimiCodeHandler", () => {
	beforeEach(() => {
		clearAllMocks()
		mockGetAccessToken.mockResolvedValue("oauth-token")
		mockForceRefreshAccessToken.mockResolvedValue("refreshed-token")
		mockGetModels.mockRejectedValue(new Error("offline"))
	})

	it("is dispatched separately from Moonshot and preserves an unknown selected model", () => {
		const handler = buildApiHandler({
			apiProvider: providerIdentifiers.kimiCode,
			kimiCodeAuthMethod: "api-key",
			kimiCodeApiKey: "kimi-key",
			apiModelId: "future-kimi-model",
		})
		expect(handler).toBeInstanceOf(KimiCodeHandler)
		expect(handler.getModel().id).toBe("future-kimi-model")
	})

	it("uses kimi-for-coding only when no model is selected", () => {
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "api-key", kimiCodeApiKey: "kimi-key" })
		expect(handler.getModel().id).toBe("kimi-for-coding")
	})

	it("uses API key when auth method is api-key", async () => {
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "api-key", kimiCodeApiKey: "my-api-key" })
		const gen = handler.createMessage("system", [{ role: "user", content: "test" }])
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify({ choices: [{ message: { content: "response" }, finish_reason: "stop" }] }), {
				status: 200,
			}),
		)
		try {
			for await (const chunk of gen) {
				// consume
			}
		} catch {
			// expected - mock is incomplete
		}
		expect(mockGetAccessToken).not.toHaveBeenCalled()
	})

	it("uses OAuth token when auth method is oauth or not specified", async () => {
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "oauth" })
		const gen = handler.createMessage("system", [{ role: "user", content: "test" }])
		try {
			for await (const chunk of gen) {
				// consume
			}
		} catch {
			// expected - mock will fail
		}
		expect(mockGetAccessToken).toHaveBeenCalled()
	})

	it("throws error when OAuth is required but no token available", async () => {
		mockGetAccessToken.mockResolvedValueOnce(null)
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "oauth" })
		const gen = handler.createMessage("system", [{ role: "user", content: "test" }])
		await expect(async () => {
			for await (const chunk of gen) {
				// consume
			}
		}).rejects.toThrow("Not authenticated with Kimi Code")
	})

	it("throws error when API key auth is missing the key", async () => {
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "api-key" })
		const gen = handler.createMessage("system", [{ role: "user", content: "test" }])
		await expect(async () => {
			for await (const chunk of gen) {
				// consume
			}
		}).rejects.toThrow("Kimi Code API key is required")
	})

	it("retries with forced refresh on 401 when using OAuth", async () => {
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "oauth" })
		const fetchSpy = vi.spyOn(globalThis, "fetch")
		fetchSpy.mockResolvedValueOnce(new Response(null, { status: 401 }))
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), {
				status: 200,
			}),
		)
		const gen = handler.createMessage("system", [{ role: "user", content: "test" }])
		try {
			for await (const chunk of gen) {
				// consume
			}
		} catch {
			// expected - mock is incomplete
		}
		expect(mockForceRefreshAccessToken).toHaveBeenCalledOnce()
	})

	it("force-refreshes and retries exactly once after a non-streaming OAuth 401", async () => {
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "oauth" })
		const unauthorized = Object.assign(new Error("Unauthorized"), { status: 401 })
		const createCompletion = vi
			.spyOn((handler as any).client.chat.completions, "create")
			.mockRejectedValueOnce(unauthorized)
			.mockResolvedValueOnce({ choices: [{ message: { content: "retried" } }] })

		await expect(handler.completePrompt("test")).resolves.toBe("retried")
		expect(mockForceRefreshAccessToken).toHaveBeenCalledOnce()
		expect(createCompletion).toHaveBeenCalledTimes(2)
		expect(createCompletion).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ thinking: { type: "enabled", keep: "all" } }),
			expect.anything(),
		)
	})

	it("does not retry on 401 when using API key auth", async () => {
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "api-key", kimiCodeApiKey: "key" })
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 401 }))
		const gen = handler.createMessage("system", [{ role: "user", content: "test" }])
		await expect(async () => {
			for await (const chunk of gen) {
				// consume
			}
		}).rejects.toThrow()
		expect(mockForceRefreshAccessToken).not.toHaveBeenCalled()
	})

	it("does not force-refresh on non-401 OAuth failures", async () => {
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "oauth" })
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 500 }))
		const gen = handler.createMessage("system", [{ role: "user", content: "test" }])
		await expect(async () => {
			for await (const chunk of gen) {
				// consume
			}
		}).rejects.toThrow()
		expect(mockForceRefreshAccessToken).not.toHaveBeenCalled()
	})

	it("fetches models during prepareRequest", async () => {
		mockGetModels.mockResolvedValueOnce({ "test-model": { maxTokens: 1000 } })
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "api-key", kimiCodeApiKey: "key" })
		const gen = handler.createMessage("system", [{ role: "user", content: "test" }])
		try {
			for await (const chunk of gen) {
				// consume
			}
		} catch {
			// expected
		}
		expect(mockGetModels).toHaveBeenCalled()
	})

	it("continues when model discovery fails", async () => {
		mockGetModels.mockRejectedValueOnce(new Error("discovery failed"))
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "api-key", kimiCodeApiKey: "key" })
		const gen = handler.createMessage("system", [{ role: "user", content: "test" }])
		try {
			for await (const chunk of gen) {
				// consume
			}
		} catch {
			// expected - different error
		}
		expect(mockGetModels).toHaveBeenCalled()
	})

	it.each([
		["failure", () => Promise.reject(new Error("offline"))],
		["empty response", () => Promise.resolve({})],
	])("does not repeatedly block requests after model discovery %s", async (_case, discovery) => {
		mockGetModels.mockImplementationOnce(discovery)
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }),
		)
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "api-key", kimiCodeApiKey: "key" })

		await handler.completePrompt("first")
		await handler.completePrompt("second")

		expect(mockGetModels).toHaveBeenCalledOnce()
	})

	it("uses discovered model info when available", async () => {
		mockGetModels.mockResolvedValueOnce({ "kimi-for-coding": { maxTokens: 8000, contextWindow: 128000 } })
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "api-key", kimiCodeApiKey: "key" })
		const gen = handler.createMessage("system", [{ role: "user", content: "test" }])
		try {
			for await (const chunk of gen) {
				// consume
			}
		} catch {
			// expected
		}
		const model = handler.getModel()
		expect(model.info.maxTokens).toBe(8000)
	})

	it("uses preserved thinking instead of reasoning effort for the default K2.7 model", () => {
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "api-key", kimiCodeApiKey: "key" })
		const model = handler.getModel()
		expect(model.info.supportsReasoningEffort).toBe(false)
		expect(model.info.requiredReasoningEffort).toBe(false)
		expect(model.info.preserveReasoning).toBe(true)
		expect(model.reasoning).toBeUndefined()
	})

	it("defaults K3 to high reasoning effort and advertises low/high/max support", () => {
		const handler = new KimiCodeHandler({
			kimiCodeAuthMethod: "api-key",
			kimiCodeApiKey: "key",
			apiModelId: "k3",
		})
		const model = handler.getModel()
		expect(model.info.supportsReasoningEffort).toEqual(["low", "high", "max"])
		expect(model.info.requiredReasoningEffort).toBe(true)
		expect(model.info.supportsTemperature).toBe(false)
		expect(model.reasoning).toEqual({ reasoning_effort: "high" })
	})

	it("sends the user-selected K3 reasoning effort", () => {
		const handler = new KimiCodeHandler({
			kimiCodeAuthMethod: "api-key",
			kimiCodeApiKey: "key",
			apiModelId: "k3",
			reasoningEffort: "low",
		})
		expect(handler.getModel().reasoning).toEqual({ reasoning_effort: "low" })
	})

	it("falls back to the model default when a persisted effort from another provider is unsupported", () => {
		const handler = new KimiCodeHandler({
			kimiCodeAuthMethod: "api-key",
			kimiCodeApiKey: "key",
			apiModelId: "k3",
			reasoningEffort: "medium",
		})
		expect(handler.getModel().reasoning).toEqual({ reasoning_effort: "high" })
	})

	it.each(["k3", "k3-256k"])(
		"sends the K3 reasoning protocol without temperature or thinking for %s",
		async (modelId) => {
			const handler = new KimiCodeHandler({
				kimiCodeAuthMethod: "api-key",
				kimiCodeApiKey: "key",
				apiModelId: modelId,
				modelTemperature: 0.7,
			})
			const createCompletion = vi.spyOn(handler["client"].chat.completions, "create").mockResolvedValue({
				async *[Symbol.asyncIterator]() {
					yield { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }
				},
			} as never)

			for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "test" }])) {
				// consume
			}

			expect(createCompletion).toHaveBeenCalledWith(
				expect.objectContaining({ model: modelId, reasoning_effort: "high" }),
				expect.anything(),
			)
			const request = createCompletion.mock.calls[0][0]
			expect(request).not.toHaveProperty("temperature")
			expect(request).not.toHaveProperty("thinking")
		},
	)

	it.each(["kimi-for-coding", "kimi-for-coding-highspeed"])(
		"sends K2.7 preserved thinking without reasoning effort or temperature for %s",
		async (modelId) => {
			const handler = new KimiCodeHandler({
				kimiCodeAuthMethod: "api-key",
				kimiCodeApiKey: "key",
				apiModelId: modelId,
				reasoningEffort: "low",
				modelTemperature: 0.7,
			})
			const createCompletion = vi.spyOn(handler["client"].chat.completions, "create").mockResolvedValue({
				async *[Symbol.asyncIterator]() {
					yield { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }
				},
			} as never)

			for await (const _chunk of handler.createMessage("system", [
				{ role: "user", content: "inspect the project" },
				{
					role: "assistant",
					content: [
						{ type: "reasoning", text: "I should inspect the files.", summary: [] } as never,
						{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "README.md" } },
					],
				},
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "call_1", content: "# Project" },
						{ type: "text", text: "Continue with the result." },
					],
				},
			])) {
				// consume
			}

			expect(createCompletion).toHaveBeenCalledWith(
				expect.objectContaining({
					model: modelId,
					thinking: { type: "enabled", keep: "all" },
				}),
				expect.anything(),
			)
			const request = createCompletion.mock.calls[0][0]
			expect(request).not.toHaveProperty("reasoning_effort")
			expect(request).not.toHaveProperty("temperature")
			expect(request.messages).toContainEqual(
				expect.objectContaining({ role: "assistant", reasoning_content: "I should inspect the files." }),
			)
			expect(request.messages).toContainEqual(
				expect.objectContaining({ role: "tool", content: "# Project\n\nContinue with the result." }),
			)
			expect(request.messages.filter((message) => message.role === "user")).toHaveLength(1)
		},
	)
})
