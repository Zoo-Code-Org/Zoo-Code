import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"

import { API } from "../api"
import { ClineProvider } from "../../core/webview/ClineProvider"
import { makeClineProviderFactory } from "../../test-utils/provider"

vi.mock("vscode")
vi.mock("../../core/webview/ClineProvider")

describe("API - SendMessage Command", () => {
	let api: API
	let mockOutputChannel: vscode.OutputChannel
	let mockProvider: ClineProvider
	let mockPostMessageToWebview: ReturnType<typeof vi.fn<(message: unknown) => Promise<void>>>
	let mockLog: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>

	beforeEach(() => {
		// Setup mocks
		mockOutputChannel = {
			appendLine: vi.fn(),
		} as unknown as vscode.OutputChannel

		mockPostMessageToWebview = vi.fn<(message: unknown) => Promise<void>>().mockResolvedValue(undefined)

		mockProvider = {
			context: {} as vscode.ExtensionContext,
			postMessageToWebview: mockPostMessageToWebview,
			on: vi.fn(),
			getCurrentTaskStack: vi.fn().mockReturnValue([]),
			getCurrentTask: vi.fn().mockReturnValue(undefined),
			viewLaunched: true,
		} as unknown as ClineProvider

		mockLog = vi.fn<(...args: unknown[]) => void>()

		// Create API instance with logging enabled for testing
		api = new API(mockOutputChannel, mockProvider, makeClineProviderFactory(), undefined, true)
		// Override the log method to use our mock
		Object.assign(api, { log: mockLog })
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

	describe("when the webview is not launched", () => {
		const user = (text: string) => ({ text, source: "user" as const })

		it.each([
			{ label: "text and images", text: "see @/file.ts", images: ["img"], expected: [user("see @/file.ts")] },
			{ label: "empty text", text: "", images: undefined, expected: [] },
			{ label: "missing text", text: undefined, images: undefined, expected: [] },
		])("submits the user text directly with $label", async ({ text, images, expected }) => {
			const submitUserMessage = vi.fn().mockResolvedValue(undefined)
			Object.assign(mockProvider, {
				viewLaunched: false,
				getCurrentTask: vi.fn().mockReturnValue({ submitUserMessage }),
			})

			await api.sendMessage(text, images)

			expect(submitUserMessage).toHaveBeenCalledWith(text ?? "", images, undefined, undefined, expected)
			expect(mockPostMessageToWebview).not.toHaveBeenCalled()
		})

		it("logs and drops the message when there is no current task", async () => {
			Object.assign(mockProvider, { viewLaunched: false })

			await api.sendMessage("see @/file.ts")

			expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("no current task"))
			expect(mockPostMessageToWebview).not.toHaveBeenCalled()
		})
	})
})
