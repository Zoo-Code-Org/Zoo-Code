import { buildApiHandler } from "../../index"
import { KimiCodeHandler } from "../kimi-code"

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

vi.mock("../fetchers/modelCache", () => ({ getModels: mockGetModels }))

describe("KimiCodeHandler", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockGetAccessToken.mockResolvedValue("oauth-token")
		mockForceRefreshAccessToken.mockResolvedValue("refreshed-token")
		mockGetModels.mockRejectedValue(new Error("offline"))
	})

	it("is dispatched separately from Moonshot and preserves an unknown selected model", () => {
		const handler = buildApiHandler({
			apiProvider: "kimi-code",
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

	it("defaults to max reasoning effort and advertises low/high/max support", () => {
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "api-key", kimiCodeApiKey: "key" })
		const model = handler.getModel()
		expect(model.info.supportsReasoningEffort).toEqual(["low", "high", "max"])
		expect(model.info.requiredReasoningEffort).toBe(true)
		expect(model.reasoning).toEqual({ reasoning_effort: "max" })
	})

	it("sends the user-selected reasoning effort", () => {
		const handler = new KimiCodeHandler({
			kimiCodeAuthMethod: "api-key",
			kimiCodeApiKey: "key",
			reasoningEffort: "low",
		})
		expect(handler.getModel().reasoning).toEqual({ reasoning_effort: "low" })
	})

	it("falls back to the model default when a persisted effort from another provider is unsupported", () => {
		const handler = new KimiCodeHandler({
			kimiCodeAuthMethod: "api-key",
			kimiCodeApiKey: "key",
			reasoningEffort: "medium",
		})
		expect(handler.getModel().reasoning).toEqual({ reasoning_effort: "max" })
	})
})
