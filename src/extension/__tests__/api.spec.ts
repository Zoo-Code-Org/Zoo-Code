import type * as vscode from "vscode"
import { IpcMessageType, TaskCommandName, type IpcMessage } from "@roo-code/types"

import { API } from "../api"
import type { ClineProvider } from "../../core/webview/ClineProvider"

vi.mock("vscode")
vi.mock("../../core/webview/ClineProvider")

type TaskCommandHandler = (
	clientId: string,
	command: Extract<IpcMessage, { type: IpcMessageType.TaskCommand }>["data"],
) => Promise<void>

let taskCommandHandler: TaskCommandHandler | undefined

vi.mock("@roo-code/ipc", () => ({
	IpcServer: class {
		listen() {}
		on(messageType: IpcMessageType, handler: TaskCommandHandler) {
			if (messageType === IpcMessageType.TaskCommand) {
				taskCommandHandler = handler
			}
		}
	},
}))

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

	it("delivers SendMessage commands through the IPC handler", async () => {
		const addMessage = vi.fn()
		const appendLine = vi.fn()
		const provider = {
			context: {},
			cwd: "/test/cwd",
			getCurrentTask: vi.fn().mockReturnValue({
				isStreaming: true,
				messageQueueService: { addMessage },
			}),
			getCurrentTaskStack: vi.fn().mockReturnValue([]),
			on: vi.fn(),
		} as unknown as ClineProvider
		new API({ appendLine } as unknown as vscode.OutputChannel, provider, "/tmp/roo-test.sock", true)
		const images = ["data:image/png;base64,image1data"]

		await taskCommandHandler?.("client-1", {
			commandName: TaskCommandName.SendMessage,
			data: { text: "Use this before completing", images },
		})

		expect(appendLine).toHaveBeenCalledWith("[API] SendMessage -> Use this before completing")
		expect(addMessage).toHaveBeenCalledWith("Use this before completing", images)
	})

	it("logs rejected SendMessage commands without rejecting the IPC handler", async () => {
		const appendLine = vi.fn()
		const provider = {
			context: {},
			cwd: "/test/cwd",
			getCurrentTask: vi.fn(),
			getCurrentTaskStack: vi.fn().mockReturnValue([]),
			on: vi.fn(),
		} as unknown as ClineProvider
		const api = new API({ appendLine } as unknown as vscode.OutputChannel, provider, "/tmp/roo-test.sock", true)
		vi.spyOn(api, "sendMessage").mockRejectedValue(new Error("invalid input"))

		await expect(
			taskCommandHandler?.("client-1", {
				commandName: TaskCommandName.SendMessage,
				data: { text: "" },
			}),
		).resolves.toBeUndefined()
		expect(appendLine).toHaveBeenCalledWith("[API] SendMessage failed: invalid input")
	})
})
