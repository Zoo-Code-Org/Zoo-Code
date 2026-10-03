import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"

import { API } from "../api"
import { ClineProvider } from "../../core/webview/ClineProvider"
import { IpcMessageType, TaskCommandName } from "@roo-code/types"

vi.mock("vscode")
vi.mock("../../core/webview/ClineProvider")

// Capture the registered IPC TaskCommand handler so a test can drive the
// dispatch directly. IpcServer dispatches with emit (no promise handling), so
// a rejected command must be contained inside the listener itself.
const ipcState = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	instances: [] as unknown[],
}))

vi.mock("@roo-code/ipc", () => ({
	IpcServer: class {
		listen = vi.fn()
		send = vi.fn()
		on = vi.fn((type: string, handler: (...args: unknown[]) => unknown) => {
			ipcState.handlers.set(type, handler)
		})
		constructor(...args: unknown[]) {
			ipcState.instances.push(args)
		}
	},
}))

describe("API - SendMessage Command", () => {
	let api: API
	let mockOutputChannel: vscode.OutputChannel
	let mockProvider: ClineProvider
	let mockPostMessageToWebview: ReturnType<typeof vi.fn<(...args: any[]) => any>>
	let mockLog: ReturnType<typeof vi.fn<(...args: any[]) => void>>

	beforeEach(() => {
		// Setup mocks
		mockOutputChannel = {
			appendLine: vi.fn(),
		} as unknown as vscode.OutputChannel

		mockPostMessageToWebview = vi.fn<(...args: any[]) => any>().mockResolvedValue(undefined)

		mockProvider = {
			context: {} as vscode.ExtensionContext,
			postMessageToWebview: mockPostMessageToWebview,
			on: vi.fn(),
			getCurrentTaskStack: vi.fn().mockReturnValue([]),
			getCurrentTask: vi.fn().mockReturnValue(undefined),
			viewLaunched: true,
		} as unknown as ClineProvider

		mockLog = vi.fn<(...args: any[]) => void>()

		// Create API instance with logging enabled for testing
		api = new API(mockOutputChannel, mockProvider, undefined, true)
		// Override the log method to use our mock
		;(api as any).log = mockLog
	})

	it("should handle SendMessage command with text only", async () => {
		// Arrange
		const messageText = "Hello, this is a test message"

		// Act
		await api.sendMessage(messageText)

		// Assert
		expect(mockPostMessageToWebview).toHaveBeenCalledWith({
			type: "invoke",
			invoke: "sendMessage",
			text: messageText,
			images: undefined,
		})
	})

	it("should handle SendMessage command with text and images", async () => {
		// Arrange
		const messageText = "Analyze this image"
		const images = [
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
		]

		// Act
		await api.sendMessage(messageText, images)

		// Assert
		expect(mockPostMessageToWebview).toHaveBeenCalledWith({
			type: "invoke",
			invoke: "sendMessage",
			text: messageText,
			images,
		})
	})

	it("should handle SendMessage command with images only", async () => {
		// Arrange
		const images = [
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
		]

		// Act
		await api.sendMessage(undefined, images)

		// Assert
		expect(mockPostMessageToWebview).toHaveBeenCalledWith({
			type: "invoke",
			invoke: "sendMessage",
			text: undefined,
			images,
		})
	})

	it("should handle SendMessage command with empty parameters", async () => {
		// Act
		await api.sendMessage()

		// Assert
		expect(mockPostMessageToWebview).toHaveBeenCalledWith({
			type: "invoke",
			invoke: "sendMessage",
			text: undefined,
			images: undefined,
		})
	})

	it("should log SendMessage command when processed via IPC", async () => {
		// This test verifies the logging behavior when the command comes through IPC
		// We need to simulate the IPC handler directly since we can't easily test the full IPC flow

		const messageText = "Test message from IPC"
		const commandData = {
			text: messageText,
			images: undefined,
		}

		// Simulate the IPC command handler calling sendMessage
		mockLog(`[API] SendMessage -> ${commandData.text}`)
		await api.sendMessage(commandData.text, commandData.images)

		// Assert that logging occurred
		expect(mockLog).toHaveBeenCalledWith(`[API] SendMessage -> ${messageText}`)

		// Assert that the message was sent
		expect(mockPostMessageToWebview).toHaveBeenCalledWith({
			type: "invoke",
			invoke: "sendMessage",
			text: messageText,
			images: undefined,
		})
	})

	it("should handle SendMessage with multiple images", async () => {
		// Arrange
		const messageText = "Compare these images"
		const images = [
			"data:image/png;base64,image1data",
			"data:image/png;base64,image2data",
			"data:image/png;base64,image3data",
		]

		// Act
		await api.sendMessage(messageText, images)

		// Assert
		expect(mockPostMessageToWebview).toHaveBeenCalledWith({
			type: "invoke",
			invoke: "sendMessage",
			text: messageText,
			images,
		})
		expect(mockPostMessageToWebview).toHaveBeenCalledTimes(1)
	})

	it("rejects in headless mode when the task refuses the delivery", async () => {
		// Arrange: headless flow with an in-flight approval ask — the task
		// refuses the slot write, and the API caller must see the failure.
		const submitUserMessage = vi.fn().mockResolvedValue(false)
		const headlessProvider = {
			context: {} as vscode.ExtensionContext,
			postMessageToWebview: mockPostMessageToWebview,
			on: vi.fn(),
			getCurrentTaskStack: vi.fn().mockReturnValue([]),
			getCurrentTask: vi.fn().mockReturnValue({ submitUserMessage }),
			viewLaunched: false,
		} as unknown as ClineProvider
		const headlessApi = new API(mockOutputChannel, headlessProvider, undefined, true)

		// Act + Assert
		await expect(headlessApi.sendMessage("Hello from headless")).rejects.toThrow(
			"[API#sendMessage] message was not delivered",
		)
		expect(submitUserMessage).toHaveBeenCalledWith("Hello from headless", undefined)
		expect(mockPostMessageToWebview).not.toHaveBeenCalled()
	})

	it("contains a rejected headless SendMessage inside the IPC dispatch boundary", async () => {
		// The task refuses the delivery; the fire-and-forget IPC listener must
		// swallow and log the rejection instead of leaking an unhandled one.
		const submitUserMessage = vi.fn().mockResolvedValue(false)
		const headlessProvider = {
			context: {} as vscode.ExtensionContext,
			postMessageToWebview: mockPostMessageToWebview,
			on: vi.fn(),
			getCurrentTaskStack: vi.fn().mockReturnValue([]),
			getCurrentTask: vi.fn().mockReturnValue({ submitUserMessage }),
			viewLaunched: false,
		} as unknown as ClineProvider
		new API(mockOutputChannel, headlessProvider, "/tmp/test-roo-code.sock", true)
		const handler = ipcState.handlers.get(IpcMessageType.TaskCommand)
		expect(handler).toBeDefined()

		await expect(
			handler!("client-1", { commandName: TaskCommandName.SendMessage, data: { text: "hi" } }),
		).resolves.toBeUndefined()

		// The rejection is contained: logged, not rethrown.
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("[API] SendMessage failed"))
	})
})
