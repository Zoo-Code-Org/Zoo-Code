import type { Mock } from "vitest"
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("vscode", () => ({
	window: {
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
	},
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/mock/workspace" } }],
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn(),
			update: vi.fn(),
		}),
	},
	Uri: {
		file: vi.fn((path) => ({ fsPath: path })),
	},
	env: {
		uriScheme: "vscode",
	},
}))

vi.mock("../../../mentions/resolveImageMentions", () => ({
	resolveImageMentions: vi.fn(async (payload: { text: string; images?: string[] }) => ({
		text: payload.text,
		images: payload.images,
	})),
}))

import { webviewMessageHandler } from "../webviewMessageHandler"
import type { ClineProvider } from "../ClineProvider"
import type { WebviewMessage } from "@roo-code/types"
import { MessageQueueService } from "../../message-queue/MessageQueueService"

describe("webviewMessageHandler - queueMessage origin", () => {
	let mockClineProvider: ClineProvider
	let messageQueueService: MessageQueueService

	beforeEach(() => {
		vi.clearAllMocks()

		messageQueueService = new MessageQueueService()

		mockClineProvider = {
			getCurrentTask: vi.fn().mockReturnValue({ messageQueueService }),
			postMessageToWebview: vi.fn(),
			contextProxy: {
				getValue: vi.fn(),
				setValue: vi.fn(),
				globalStorageUri: { fsPath: "/mock/storage" },
			},
			getState: vi.fn().mockResolvedValue({
				maxImageFileSize: 5,
				maxTotalImageSize: 20,
			}),
			log: vi.fn(),
		} as unknown as ClineProvider
	})

	it("stores api origin on the queued message", async () => {
		const message: WebviewMessage = { type: "queueMessage", text: "steer the task", images: [], origin: "api" }

		await webviewMessageHandler(mockClineProvider, message)

		expect((mockClineProvider.getCurrentTask as Mock)().messageQueueService).toBe(messageQueueService)
		expect(messageQueueService.messages).toMatchObject([{ text: "steer the task", origin: "api" }])
	})

	it("keeps webview input unattributed so it can still answer approval asks", async () => {
		const message: WebviewMessage = { type: "queueMessage", text: "human note", images: [] }

		await webviewMessageHandler(mockClineProvider, message)

		expect(messageQueueService.messages).toHaveLength(1)
		expect(messageQueueService.messages[0].text).toBe("human note")
		expect(messageQueueService.messages[0].origin).toBeUndefined()
	})
})
