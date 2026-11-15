// npx vitest core/webview/__tests__/webviewMessageHandler.providerInfo.spec.ts

import type { ClineProvider } from "../ClineProvider"
import { webviewMessageHandler } from "../webviewMessageHandler"

vi.mock("../../../api/providers/fetchers/modelCache")

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
})
