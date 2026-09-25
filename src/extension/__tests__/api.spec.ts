import type * as vscode from "vscode"
import { IpcMessageType, TaskCommandName, type ClineMessage, type IpcMessage } from "@roo-code/types"

import { API } from "../api"
import type { ClineProvider } from "../../core/webview/ClineProvider"
import { MessageQueueService } from "../../core/message-queue/MessageQueueService"
import { Task } from "../../core/task/Task"

vi.mock("vscode")
vi.mock("../../core/webview/ClineProvider")

type TaskCommandHandler = (
	clientId: string,
	command: Extract<IpcMessage, { type: IpcMessageType.TaskCommand }>["data"],
) => Promise<void>

let taskCommandHandler: TaskCommandHandler | undefined

type TaskTestAccess = {
	addToClineMessages: (message: ClineMessage) => Promise<void>
}

const createStreamingTask = (provider: object) => {
	const task = Object.create(Task.prototype) as Task
	Object.assign(task, {
		abort: false,
		clineMessages: [],
		taskId: "task-1",
		instanceId: "instance-1",
		isStreaming: true,
		messageQueueService: new MessageQueueService(),
		providerRef: { deref: () => provider },
		addToClineMessages: vi.fn(async () => {}),
		saveClineMessages: vi.fn(async () => true),
		updateClineMessage: vi.fn(async () => {}),
		cancelAutoApprovalTimeout: vi.fn(),
		checkpointSave: vi.fn(async () => {}),
		emit: vi.fn(),
	})
	vi.spyOn(task as unknown as TaskTestAccess, "addToClineMessages").mockImplementation(async (message) => {
		task.clineMessages.push(message)
	})
	return task
}

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
	it("enqueues directly when the current webview task is streaming", async () => {
		const addMessage = vi.fn()
		const postMessageToWebview = vi.fn()
		const provider = {
			viewLaunched: true,
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

	it.each([
		["command", "npm publish"],
		["use_mcp_server", '{"server_name":"filesystem","tool_name":"write_file"}'],
	] as const)("does not approve a protected headless %s ask from queued IPC input", async (askType, askText) => {
		const appendLine = vi.fn()
		const provider = {
			context: {},
			cwd: "/test/cwd",
			viewLaunched: false,
			getState: vi.fn().mockResolvedValue({ autoApprovalEnabled: false }),
			getCurrentTask: vi.fn(),
			getCurrentTaskStack: vi.fn().mockReturnValue([]),
			on: vi.fn(),
		} as unknown as ClineProvider
		const task = createStreamingTask(provider)
		vi.mocked(provider.getCurrentTask).mockReturnValue(task)
		new API({ appendLine } as unknown as vscode.OutputChannel, provider, "/tmp/roo-test.sock", true)
		const images = ["data:image/png;base64,image1data"]
		const executeProtectedTool = vi.fn()
		const ask = task.ask(askType, askText, false)
		await vi.waitFor(() => expect(task.clineMessages).toHaveLength(1))

		await taskCommandHandler?.("client-1", {
			commandName: TaskCommandName.SendMessage,
			data: { text: "Use this before completing", images },
		})
		const result = await ask
		if (result.response === "yesButtonClicked") {
			executeProtectedTool()
		}

		expect(appendLine).toHaveBeenCalledWith("[API] SendMessage -> Use this before completing")
		expect(result).toMatchObject({ response: "messageResponse", text: "Use this before completing", images })
		expect(task.messageQueueService.isEmpty()).toBe(true)
		expect(executeProtectedTool).not.toHaveBeenCalled()
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
