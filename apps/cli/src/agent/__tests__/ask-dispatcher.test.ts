import type { ClineMessage, ClineAsk } from "@roo-code/types"
import { AskDispatcher } from "../ask-dispatcher.js"
import type { OutputManager } from "../output-manager.js"
import type { PromptManager } from "../prompt-manager.js"

const createMockOutputManager = (): OutputManager =>
	({
		output: vi.fn(),
		markDisplayed: vi.fn(),
	}) as unknown as OutputManager

const createMockPromptManager = (): PromptManager =>
	({
		promptForInput: vi.fn(),
		promptForYesNo: vi.fn(),
		promptWithTimeout: vi.fn(),
	}) as unknown as PromptManager

describe("AskDispatcher", () => {
	let mockOutputManager: OutputManager
	let mockPromptManager: PromptManager
	let sendMessageMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		mockOutputManager = createMockOutputManager()
		mockPromptManager = createMockPromptManager()
		sendMessageMock = vi.fn()
	})

	describe("handleAsk - disabled mode", () => {
		it("returns handled=false when disabled", async () => {
			const dispatcher = new AskDispatcher({
				outputManager: mockOutputManager,
				promptManager: mockPromptManager,
				sendMessage: sendMessageMock,
				disabled: true,
			})

			const message: ClineMessage = {
				ts: 1,
				type: "ask",
				ask: "followup",
				text: "test",
				partial: false,
			} as ClineMessage

			const result = await dispatcher.handleAsk(message)
			expect(result.handled).toBe(false)
		})
	})

	describe("handleAsk - partial messages", () => {
		it("skips partial messages", async () => {
			const dispatcher = new AskDispatcher({
				outputManager: mockOutputManager,
				promptManager: mockPromptManager,
				sendMessage: sendMessageMock,
			})

			const message: ClineMessage = {
				ts: 1,
				type: "ask",
				ask: "followup",
				text: "test",
				partial: true,
			} as ClineMessage

			const result = await dispatcher.handleAsk(message)
			expect(result.handled).toBe(false)
		})
	})

	describe("handleAsk - unknown ask type in non-interactive mode", () => {
		it("calls onInputRequired for unknown ask types", async () => {
			const onInputRequired = vi.fn()
			const dispatcher = new AskDispatcher({
				outputManager: mockOutputManager,
				promptManager: mockPromptManager,
				sendMessage: sendMessageMock,
				nonInteractive: true,
				onInputRequired,
			})

			const message: ClineMessage = {
				ts: 1,
				type: "ask",
				ask: "unknown_ask_type" as ClineAsk,
				text: "test message",
				partial: false,
			} as ClineMessage

			const result = await dispatcher.handleAsk(message)
			expect(result.handled).toBe(true)
			expect(onInputRequired).toHaveBeenCalledWith("unknown_ask_type", "test message")
		})
	})

	describe("handleAsk - error handling", () => {
		it("removes ask from handled set on error", async () => {
			const dispatcher = new AskDispatcher({
				outputManager: mockOutputManager,
				promptManager: mockPromptManager,
				sendMessage: () => {
					throw new Error("sendMessage error")
				},
			})

			const message: ClineMessage = {
				ts: 1,
				type: "ask",
				ask: "command_output",
				text: "test",
				partial: false,
			} as ClineMessage

			const result = await dispatcher.handleAsk(message)
			expect(result.handled).toBe(false)
			expect(result.error).toBeInstanceOf(Error)

			// Should be able to handle again after error
			expect(dispatcher.isHandled(1)).toBe(false)
		})
	})

	describe("api_req_failed handling", () => {
		it("calls onInputRequired when provided", async () => {
			const onInputRequired = vi.fn()
			const dispatcher = new AskDispatcher({
				outputManager: mockOutputManager,
				promptManager: mockPromptManager,
				sendMessage: sendMessageMock,
				onInputRequired,
			})

			const message: ClineMessage = {
				ts: 1,
				type: "ask",
				ask: "api_req_failed",
				text: "API error",
				partial: false,
			} as ClineMessage

			const result = await dispatcher.handleAsk(message)
			expect(result.handled).toBe(true)
			expect(onInputRequired).toHaveBeenCalledWith("api_req_failed", "API error")
		})
	})

	describe("followup handling with onInputRequired", () => {
		it("calls onInputRequired in non-interactive mode", async () => {
			const onInputRequired = vi.fn()
			const dispatcher = new AskDispatcher({
				outputManager: mockOutputManager,
				promptManager: mockPromptManager,
				sendMessage: sendMessageMock,
				nonInteractive: true,
				onInputRequired,
			})

			const message: ClineMessage = {
				ts: 1,
				type: "ask",
				ask: "followup",
				text: JSON.stringify({ question: "What next?", suggest: [{ answer: "Continue" }] }),
				partial: false,
			} as ClineMessage

			const result = await dispatcher.handleAsk(message)
			expect(result.handled).toBe(true)
			expect(onInputRequired).toHaveBeenCalledWith("followup", "What next?")
		})
	})
})
