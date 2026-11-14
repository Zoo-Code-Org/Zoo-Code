import { describe, it, expect, beforeEach, vi } from "vitest"
import { webviewMessageHandler } from "../webviewMessageHandler"

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

describe("webviewMessageHandler newTask authorization", () => {
	let provider: Record<string, ReturnType<typeof vi.fn>>

	beforeEach(() => {
		vi.clearAllMocks()
		provider = {
			createTask: vi.fn().mockResolvedValue({ taskId: "task-1" }),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			getCurrentTask: vi.fn(() => undefined),
			getState: vi.fn().mockResolvedValue({ maxImageFileSize: 5, maxTotalImageSize: 20 }),
		} as unknown as Record<string, ReturnType<typeof vi.fn>>
	})

	it("forwards the authorized mention substring from the webview message", async () => {
		await webviewMessageHandler(
			provider as never,
			{
				type: "newTask",
				text: "context @/secret\nuser line",
				authorizedMentionText: "user line",
			} as never,
		)

		expect(provider.createTask).toHaveBeenCalledWith(
			"context @/secret\nuser line",
			[],
			undefined,
			expect.objectContaining({ authorizedMentionText: "user line" }),
			undefined,
		)
	})

	it("passes an empty authorized substring when the webview omits it", async () => {
		await webviewMessageHandler(
			provider as never,
			{
				type: "newTask",
				text: "generated @/path from selected code",
			} as never,
		)

		expect(provider.createTask).toHaveBeenCalledWith(
			"generated @/path from selected code",
			[],
			undefined,
			expect.objectContaining({ authorizedMentionText: "" }),
			undefined,
		)
	})
})
