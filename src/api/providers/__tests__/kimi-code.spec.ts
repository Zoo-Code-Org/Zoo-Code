import { buildApiHandler } from "../../index"
import { KimiCodeHandler } from "../kimi-code"

vi.mock("../../../integrations/kimi-code/oauth", () => ({
	kimiCodeOAuthManager: {
		getAccessToken: vi.fn().mockResolvedValue("oauth-token"),
		forceRefreshAccessToken: vi.fn().mockResolvedValue("refreshed-token"),
	},
}))

vi.mock("../fetchers/modelCache", () => ({
	getModels: vi.fn().mockRejectedValue(new Error("offline")),
}))

describe("KimiCodeHandler", () => {
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
})
