import { beforeEach, describe, expect, it, vi } from "vitest"

const { executeCommandHandleMock } = vi.hoisted(() => ({
	executeCommandHandleMock: vi.fn(),
}))

vi.mock("../../task/Task")
vi.mock("@roo-code/core", () => ({
	customToolRegistry: {
		has: vi.fn(() => false),
		get: vi.fn(),
	},
}))
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureToolUsage: vi.fn(),
			captureConsecutiveMistakeError: vi.fn(),
		},
	},
}))
vi.mock("../../tools/ExecuteCommandTool", () => ({
	executeCommandTool: {
		handle: executeCommandHandleMock,
	},
}))
vi.mock("../../tools/validateToolUse", () => ({
	validateToolUse: vi.fn(),
	isValidToolName: vi.fn((toolName: string) => toolName === "execute_command"),
}))

import { presentAssistantMessage } from "../presentAssistantMessage"

const findCommand = "find src -maxdepth 1 -type f"
const rgCommand = "rg TODO src"

describe("presentAssistantMessage - parallel command batches", () => {
	let mockTask: any

	beforeEach(() => {
		vi.clearAllMocks()

		mockTask = {
			taskId: "test-task-id",
			instanceId: "test-instance",
			abort: false,
			presentAssistantMessageLocked: false,
			presentAssistantMessageHasPendingUpdates: false,
			currentStreamingContentIndex: 0,
			assistantMessageContent: [],
			userMessageContent: [],
			didCompleteReadingStream: true,
			didRejectTool: false,
			didAlreadyUseTool: false,
			consecutiveMistakeCount: 0,
			clineMessages: [],
			api: {
				getModel: () => ({ id: "test-model", info: {} }),
			},
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
			toolRepetitionDetector: {
				check: vi.fn().mockReturnValue({ allowExecution: true }),
			},
			providerRef: {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({
						mode: "code",
						customModes: [],
						experiments: {},
						disabledTools: [],
					}),
				}),
			},
			say: vi.fn().mockResolvedValue(undefined),
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
			maybeInterruptForPendingSteerAtToolBoundary: vi.fn().mockResolvedValue(false),
			checkpointSave: vi.fn().mockResolvedValue(undefined),
		}

		mockTask.pushToolResultToUserContent = vi.fn().mockImplementation((toolResult: any) => {
			const existingResult = mockTask.userMessageContent.find(
				(block: any) => block.type === "tool_result" && block.tool_use_id === toolResult.tool_use_id,
			)
			if (existingResult) {
				return false
			}
			mockTask.userMessageContent.push(toolResult)
			return true
		})
	})

	it("runs consecutive read-only execute_command tool calls concurrently and preserves result order", async () => {
		const finished: string[] = []
		mockTask.assistantMessageContent = [commandBlock("cmd-1", findCommand), commandBlock("cmd-2", rgCommand)]
		executeCommandHandleMock.mockImplementation(async (_task: any, toolUse: any, callbacks: any) => {
			const command = toolUse.nativeArgs.command
			const approved = await callbacks.askApproval("command", command)
			if (!approved) {
				return
			}
			if (command === findCommand) {
				await delay(25)
			}
			finished.push(command)
			callbacks.pushToolResult(`result:${command}`)
		})

		await presentAssistantMessage(mockTask)

		expect(finished[0]).toBe(rgCommand)
		expect(executeCommandHandleMock).toHaveBeenCalledTimes(2)
		expect(mockTask.recordToolUsage).toHaveBeenCalledTimes(2)
		expect(toolResultIds(mockTask)).toEqual(["cmd-1", "cmd-2"])
		expect(toolResultContents(mockTask)).toEqual([`result:${findCommand}`, `result:${rgCommand}`])
	})

	it("waits for the stream to complete before executing a read-only command", async () => {
		mockTask.didCompleteReadingStream = false
		mockTask.assistantMessageContent = [commandBlock("cmd-1", findCommand)]
		executeCommandHandleMock.mockImplementation(async (_task: any, toolUse: any, callbacks: any) => {
			await callbacks.askApproval("command", toolUse.nativeArgs.command)
			callbacks.pushToolResult("result")
		})

		await presentAssistantMessage(mockTask)

		expect(executeCommandHandleMock).not.toHaveBeenCalled()
		expect(mockTask.currentStreamingContentIndex).toBe(0)
		expect(mockTask.presentAssistantMessageLocked).toBe(false)

		mockTask.didCompleteReadingStream = true
		await presentAssistantMessage(mockTask)

		expect(executeCommandHandleMock).toHaveBeenCalledTimes(1)
		expect(toolResultIds(mockTask)).toEqual(["cmd-1"])
	})

	it("keeps unsafe command forms on the serial execution path", async () => {
		let active = 0
		let maxActive = 0
		const unsafeCommand = "git diff --output=/tmp/roo-diff.txt"
		mockTask.assistantMessageContent = [commandBlock("cmd-1", unsafeCommand), commandBlock("cmd-2", rgCommand)]
		executeCommandHandleMock.mockImplementation(async (_task: any, toolUse: any, callbacks: any) => {
			const command = toolUse.nativeArgs.command
			const approved = await callbacks.askApproval("command", command)
			if (!approved) {
				return
			}
			active++
			maxActive = Math.max(maxActive, active)
			if (command === unsafeCommand) {
				await delay(25)
			}
			callbacks.pushToolResult(`result:${command}`)
			active--
		})

		await presentAssistantMessage(mockTask)
		await waitFor(() => expect(executeCommandHandleMock).toHaveBeenCalledTimes(2))

		expect(maxActive).toBe(1)
		expect(toolResultIds(mockTask)).toEqual(["cmd-1", "cmd-2"])
	})
})

function commandBlock(id: string, command: string) {
	return {
		type: "tool_use",
		id,
		name: "execute_command",
		params: { command },
		nativeArgs: { command },
		partial: false,
	}
}

function toolResultIds(task: any): string[] {
	return task.userMessageContent
		.filter((item: any) => item.type === "tool_result")
		.map((item: any) => item.tool_use_id)
}

function toolResultContents(task: any): string[] {
	return task.userMessageContent.filter((item: any) => item.type === "tool_result").map((item: any) => item.content)
}

async function waitFor(assertion: () => void): Promise<void> {
	const started = Date.now()
	let lastError: unknown

	while (Date.now() - started < 1000) {
		try {
			assertion()
			return
		} catch (error) {
			lastError = error
			await delay(5)
		}
	}

	throw lastError
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
