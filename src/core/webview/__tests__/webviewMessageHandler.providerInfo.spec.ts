// npx vitest core/webview/__tests__/webviewMessageHandler.providerInfo.spec.ts

import type { ClineProvider } from "../ClineProvider"
import { webviewMessageHandler } from "../webviewMessageHandler"

vi.mock("../../../api/providers/fetchers/modelCache")

const KEY_INFO = { name: "key", monthly_limit: "100", monthly_spend: "5", org_balance: "95", config: {} }

describe("webviewMessageHandler - requestProviderInfo", () => {
	// The handler uses only these two members for this message.
	const postMessageToWebview = vi.fn()
	const provider = { postMessageToWebview, log: vi.fn() } as unknown as ClineProvider

	beforeEach(() => {
		postMessageToWebview.mockReset()
	})

	it("routes the message to the provider info handler and posts a providerInfo reply", async () => {
		await webviewMessageHandler(provider, {
			type: "requestProviderInfo",
			requestId: "req-9",
			values: { kind: "nope" },
		})

		expect(postMessageToWebview).toHaveBeenCalledWith({
			type: "providerInfo",
			requestId: "req-9",
			error: "Invalid provider info request",
		})
	})

	it("routes a valid request to the fetcher and posts the success reply", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify(KEY_INFO), { status: 200 }))

		await webviewMessageHandler(provider, {
			type: "requestProviderInfo",
			requestId: "req-10",
			values: { kind: "requestyKeyInfo", apiKey: "rk" },
		})

		expect(postMessageToWebview).toHaveBeenCalledWith({
			type: "providerInfo",
			requestId: "req-10",
			values: { data: KEY_INFO },
		})
		fetchSpy.mockRestore()
	})
})
