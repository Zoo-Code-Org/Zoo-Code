import { buildApiHandler } from "../../index"
import { KimiCodeHandler } from "../kimi-code"
import type { Mock } from "vitest"

vi.mock("../../../integrations/kimi-code/oauth", () => {
	const mockGetAccessToken = vi.fn().mockResolvedValue("oauth-token")
	const mockForceRefreshAccessToken = vi.fn().mockResolvedValue("refreshed-token")
	return {
		kimiCodeOAuthManager: {
			getAccessToken: mockGetAccessToken,
			forceRefreshAccessToken: mockForceRefreshAccessToken,
		},
		mockGetAccessToken,
		mockForceRefreshAccessToken,
	}
})

vi.mock("../fetchers/modelCache", () => {
	const mockGetModels = vi.fn().mockRejectedValue(new Error("offline"))
	return {
		getModels: mockGetModels,
		mockGetModels,
	}
})

const { mockGetAccessToken, mockForceRefreshAccessToken } = await import("../../../integrations/kimi-code/oauth")
const { mockGetModels } = await import("../fetchers/modelCache")

describe("KimiCodeHandler", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		;(mockGetAccessToken as any).mockResolvedValue("oauth-token")
		;(mockForceRefreshAccessToken as any).mockResolvedValue("refreshed-token")
		;(mockGetModels as any).mockRejectedValue(new Error("offline"))
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
		expect(mockGetAccessToken as any).not.toHaveBeenCalled()
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
		expect(mockGetAccessToken as any).toHaveBeenCalled()
	})

	it("throws error when OAuth is required but no token available", async () => {
		;(mockGetAccessToken as any).mockResolvedValueOnce(null)
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
		fetchSpy.mockResolvedValueOnce(
			new Response(null, { status: 401 }),
		)
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
		expect(mockForceRefreshAccessToken as any).toHaveBeenCalled()
	})

	it("does not retry on 401 when using API key auth", async () => {
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "api-key", kimiCodeApiKey: "key" })
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(null, { status: 401 }),
		)
		const gen = handler.createMessage("system", [{ role: "user", content: "test" }])
		await expect(async () => {
			for await (const chunk of gen) {
				// consume
			}
		}).rejects.toThrow()
		expect(mockForceRefreshAccessToken as any).not.toHaveBeenCalled()
	})

	it("fetches models during prepareRequest", async () => {
		;(mockGetModels as any).mockResolvedValueOnce({ "test-model": { maxTokens: 1000 } })
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "api-key", kimiCodeApiKey: "key" })
		const gen = handler.createMessage("system", [{ role: "user", content: "test" }])
		try {
			for await (const chunk of gen) {
				// consume
			}
		} catch {
			// expected
		}
		expect(mockGetModels as any).toHaveBeenCalled()
	})

	it("continues when model discovery fails", async () => {
		;(mockGetModels as any).mockRejectedValueOnce(new Error("discovery failed"))
		const handler = new KimiCodeHandler({ kimiCodeAuthMethod: "api-key", kimiCodeApiKey: "key" })
		const gen = handler.createMessage("system", [{ role: "user", content: "test" }])
		try {
			for await (const chunk of gen) {
				// consume
			}
		} catch {
			// expected - different error
		}
		expect(mockGetModels as any).toHaveBeenCalled()
	})

	it("uses discovered model info when available", async () => {
		;(mockGetModels as any).mockResolvedValueOnce({ "kimi-for-coding": { maxTokens: 8000, contextWindow: 128000 } })
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
})
