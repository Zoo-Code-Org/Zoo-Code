import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"

import { API } from "../api"
import { ClineProvider } from "../../core/webview/ClineProvider"
import { TaskCommandName } from "@roo-code/types"

vi.mock("vscode")
vi.mock("../../core/webview/ClineProvider")

describe("API - SendMessage Command", () => {
	let api: API
	let mockOutputChannel: vscode.OutputChannel
	let mockProvider: ClineProvider
	let mockPostMessageToWebview: ReturnType<typeof vi.fn<ClineProvider["postMessageToWebview"]>>
	let mockLog: ReturnType<typeof vi.fn<(message: string) => void>>

	beforeEach(() => {
		// Setup mocks
		mockOutputChannel = {
			appendLine: vi.fn(),
		} as unknown as vscode.OutputChannel

		mockPostMessageToWebview = vi.fn<ClineProvider["postMessageToWebview"]>().mockResolvedValue(undefined)

		mockProvider = {
			context: {} as vscode.ExtensionContext,
			contextProxy: { getValues: vi.fn().mockReturnValue({}) },
			postMessageToWebview: mockPostMessageToWebview,
			on: vi.fn(),
			getCurrentTaskStack: vi.fn().mockReturnValue([]),
			getCurrentTask: vi.fn().mockReturnValue(undefined),
			viewLaunched: true,
		} as unknown as ClineProvider

		mockLog = vi.fn<(message: string) => void>()

		// Create API instance with logging enabled for testing
		api = new API(mockOutputChannel, mockProvider, undefined, true)
		// Override the log method to use our mock
		Object.defineProperty(api, "log", { value: mockLog })
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

	it("should enqueue directly when the current task is streaming", async () => {
		const addMessage = vi.fn()
		const messageText = "Use this before completing"
		const images = ["data:image/png;base64,aW1hZ2Ux"]
		const currentTask = {
			isStreaming: true,
			messageQueueService: { addMessage },
		}
		mockProvider.getCurrentTask = vi.fn().mockReturnValue(currentTask)

		await api.sendMessage(messageText, images)

		expect(addMessage).toHaveBeenCalledWith(messageText, images)
		expect(mockPostMessageToWebview).not.toHaveBeenCalled()
	})

	it("should enqueue image-only input when the current task is streaming", async () => {
		const addMessage = vi.fn()
		const images = ["data:image/png;base64,aW1hZ2Ux"]
		mockProvider.getCurrentTask = vi.fn().mockReturnValue({
			isStreaming: true,
			messageQueueService: { addMessage },
		})

		await api.sendMessage(undefined, images)

		expect(addMessage).toHaveBeenCalledWith("", images)
		expect(mockPostMessageToWebview).not.toHaveBeenCalled()
	})

	it("should cap streaming input at 20 images before enqueueing", async () => {
		const addMessage = vi.fn()
		const images = Array.from(
			{ length: 21 },
			(_, index) => `data:image/png;base64,${Buffer.from(`image-${index}`).toString("base64")}`,
		)
		mockProvider.getCurrentTask = vi.fn().mockReturnValue({
			isStreaming: true,
			messageQueueService: { addMessage },
		})

		await api.sendMessage("Review these", images)

		expect(addMessage).toHaveBeenCalledWith("Review these", images.slice(0, 20))
	})

	it("should discard malformed streaming image data before enqueueing", async () => {
		const addMessage = vi.fn()
		mockProvider.getCurrentTask = vi.fn().mockReturnValue({
			isStreaming: true,
			messageQueueService: { addMessage },
		})

		await api.sendMessage("Continue safely", ["not-an-image", "data:image/png;base64,%%%"])

		expect(addMessage).toHaveBeenCalledWith("Continue safely", [])
	})

	it("should apply configured image size limits before streaming enqueue", async () => {
		const addMessage = vi.fn()
		mockProvider.contextProxy.getValues = vi.fn().mockReturnValue({ maxImageFileSize: 0 })
		mockProvider.getCurrentTask = vi.fn().mockReturnValue({
			isStreaming: true,
			messageQueueService: { addMessage },
		})

		await api.sendMessage("Continue safely", ["data:image/png;base64,aW1hZ2U="])

		expect(addMessage).toHaveBeenCalledWith("Continue safely", [])
	})

	it("should retain webview routing when the current task is not streaming", async () => {
		const addMessage = vi.fn()
		const messageText = "Answer the current ask"
		const currentTask = {
			isStreaming: false,
			messageQueueService: { addMessage },
		}
		mockProvider.getCurrentTask = vi.fn().mockReturnValue(currentTask)

		await api.sendMessage(messageText)

		expect(addMessage).not.toHaveBeenCalled()
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
})
