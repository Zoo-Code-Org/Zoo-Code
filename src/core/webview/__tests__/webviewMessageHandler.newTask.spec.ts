import { describe, it, expect, beforeEach, vi } from "vitest"
import { webviewMessageHandler } from "../webviewMessageHandler"
import type { ClineProvider } from "../ClineProvider"
import type { WebviewMessage } from "../../../shared/WebviewMessage"

vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string) => key),
	changeLanguage: vi.fn(),
}))

vi.mock("vscode", () => ({
	window: {
		showErrorMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showInformationMessage: vi.fn(),
	},
	workspace: {
		workspaceFolders: undefined,
		getConfiguration: vi.fn(() => ({
			get: vi.fn(),
			update: vi.fn(),
		})),
	},
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
	Uri: {
		parse: vi.fn((str: string) => ({ toString: () => str })),
		file: vi.fn((path: string) => ({ fsPath: path })),
	},
	env: { openExternal: vi.fn() },
	commands: { executeCommand: vi.fn() },
}))

const { resolveImageMentions } = vi.hoisted(() => ({
	resolveImageMentions: vi.fn(async ({ images }: { images?: string[] }) => ({ text: "", images: images ?? [] })),
}))
vi.mock("../../mentions/resolveImageMentions", () => ({ resolveImageMentions }))

describe("webviewMessageHandler mention authorization forwarding", () => {
	// Narrow double: the handler under test only touches these members.
	// The single cast at construction keeps every use site type-checked.
	let provider: {
		createTask: ReturnType<typeof vi.fn>
		postMessageToWebview: ReturnType<typeof vi.fn>
		getCurrentTask: ReturnType<typeof vi.fn>
		getState: ReturnType<typeof vi.fn>
	}
	let providerAsClineProvider: ClineProvider
	let currentTask: {
		handleWebviewAskResponse: ReturnType<typeof vi.fn>
		messageQueueService: { addMessage: ReturnType<typeof vi.fn> }
	}

	beforeEach(() => {
		vi.clearAllMocks()
		currentTask = {
			handleWebviewAskResponse: vi.fn(),
			messageQueueService: { addMessage: vi.fn() },
		}
		provider = {
			createTask: vi.fn().mockResolvedValue({ taskId: "task-1" }),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			getCurrentTask: vi.fn(() => currentTask),
			getState: vi.fn().mockResolvedValue({ maxImageFileSize: 5, maxTotalImageSize: 20 }),
		}
		providerAsClineProvider = provider as unknown as ClineProvider
	})

	it("forwards the authorized mention substring from the webview message", async () => {
		const message: WebviewMessage = {
			type: "newTask",
			text: "context @/secret\nuser line",
			authorizedMentionText: "user line",
		}
		await webviewMessageHandler(providerAsClineProvider, message)

		expect(provider.createTask).toHaveBeenCalledWith(
			"context @/secret\nuser line",
			[],
			undefined,
			expect.objectContaining({ authorizedMentionText: "user line" }),
			undefined,
		)
	})

	it("passes an empty authorized substring when the webview omits it", async () => {
		const message: WebviewMessage = {
			type: "newTask",
			text: "generated @/path from selected code",
		}
		await webviewMessageHandler(providerAsClineProvider, message)

		expect(provider.createTask).toHaveBeenCalledWith(
			"generated @/path from selected code",
			[],
			undefined,
			expect.objectContaining({ authorizedMentionText: "" }),
			undefined,
		)
	})

	it("forwards the authorized substring with the ask response", async () => {
		const message: WebviewMessage = {
			type: "askResponse",
			askResponse: "messageResponse",
			text: "context @/secret\nuser line",
			authorizedMentionText: "user line",
		}
		await webviewMessageHandler(providerAsClineProvider, message)

		expect(currentTask.handleWebviewAskResponse).toHaveBeenCalledWith(
			"messageResponse",
			"context @/secret\nuser line",
			[],
			"user line",
		)
	})

	it("treats an omitted authorized substring on an ask response as empty", async () => {
		const message: WebviewMessage = {
			type: "askResponse",
			askResponse: "messageResponse",
			text: "generated @/path",
		}
		await webviewMessageHandler(providerAsClineProvider, message)

		expect(currentTask.handleWebviewAskResponse).toHaveBeenCalledWith("messageResponse", "generated @/path", [], "")
	})

	it("passes an empty authorized substring when a queued message omits it", async () => {
		const message: WebviewMessage = { type: "queueMessage", text: "generated @/path" }
		await webviewMessageHandler(providerAsClineProvider, message)

		expect(currentTask.messageQueueService.addMessage).toHaveBeenCalledWith("generated @/path", [], "")
	})

	it("forwards the authorized substring with a queued message", async () => {
		const message: WebviewMessage = {
			type: "queueMessage",
			text: "context @/secret\nuser line",
			authorizedMentionText: "user line",
		}
		await webviewMessageHandler(providerAsClineProvider, message)

		expect(currentTask.messageQueueService.addMessage).toHaveBeenCalledWith(
			"context @/secret\nuser line",
			[],
			"user line",
		)
	})

	it.each([
		{ label: "an authorized substring", authorizedMentionText: "user @/a.png", expected: "user @/a.png" },
		{ label: "an omitted field", authorizedMentionText: undefined, expected: "" },
	])("scans only the authorized text for image mentions with $label", async ({ authorizedMentionText, expected }) => {
		const message: WebviewMessage = {
			type: "newTask",
			text: "generated @/b.png user @/a.png",
			authorizedMentionText,
		}
		await webviewMessageHandler(providerAsClineProvider, message)

		expect(resolveImageMentions).toHaveBeenCalledWith(expect.objectContaining({ text: expected }))
		expect(provider.createTask).toHaveBeenCalledWith(
			"generated @/b.png user @/a.png",
			[],
			undefined,
			expect.anything(),
			undefined,
		)
	})

	it("scans the edited text for images and authorizes it as user typed", async () => {
		const submitUserMessage = vi.fn()
		const editTask = {
			clineMessages: [{ ts: 1, type: "say", say: "user_feedback", text: "old" }],
			apiConversationHistory: [],
			overwriteClineMessages: vi.fn(),
			overwriteApiConversationHistory: vi.fn(),
			submitUserMessage,
		}
		provider.getCurrentTask.mockReturnValue(editTask)
		const message: WebviewMessage = { type: "editMessageConfirm", messageTs: 1, text: "see @/a.png" }
		await webviewMessageHandler(providerAsClineProvider, message).catch(() => {})

		expect(resolveImageMentions).toHaveBeenCalledWith(expect.objectContaining({ text: "see @/a.png" }))
	})
})
