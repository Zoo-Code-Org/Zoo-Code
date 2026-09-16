import type * as vscode from "vscode"

import { API } from "../api"
import type { ClineProvider } from "../../core/webview/ClineProvider"

vi.mock("vscode")
vi.mock("../../core/webview/ClineProvider")

describe("API.sendMessage", () => {
	it("enqueues directly when the current task is streaming", async () => {
		const addMessage = vi.fn()
		const postMessageToWebview = vi.fn()
		const provider = {
			getCurrentTask: vi.fn().mockReturnValue({
				isStreaming: true,
				messageQueueService: { addMessage },
			}),
			getCurrentTaskStack: vi.fn().mockReturnValue([]),
			postMessageToWebview,
			on: vi.fn(),
		} as unknown as ClineProvider
		const api = new API({} as vscode.OutputChannel, provider)
		const images = ["data:image/png;base64,image1data"]

		await api.sendMessage("Use this before completing", images)

		expect(addMessage).toHaveBeenCalledWith("Use this before completing", images)
		expect(postMessageToWebview).not.toHaveBeenCalled()

		addMessage.mockClear()
		await api.sendMessage(undefined, images)
		expect(addMessage).toHaveBeenCalledWith("", images)
	})
})
