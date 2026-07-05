// npx vitest run core/webview/__tests__/webviewMessageHandler.delegation.spec.ts

import { webviewMessageHandler } from "../webviewMessageHandler"
import type { ClineProvider } from "../ClineProvider"

vi.mock("vscode", () => ({
	window: {
		showInformationMessage: vi.fn(),
		showErrorMessage: vi.fn(),
	},
	workspace: {
		workspaceFolders: [],
	},
}))

vi.mock("../../../i18n", () => ({
	t: (key: string) => key,
}))

describe("webviewMessageHandler - delegation transition UX", () => {
	let mockProvider: {
		getCurrentTask: ReturnType<typeof vi.fn>
		handleModeSwitch: ReturnType<typeof vi.fn>
		abandonCurrentSubtask: ReturnType<typeof vi.fn>
		forceCurrentSubtaskDone: ReturnType<typeof vi.fn>
	}

	beforeEach(() => {
		vi.clearAllMocks()

		mockProvider = {
			getCurrentTask: vi.fn(),
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			abandonCurrentSubtask: vi.fn().mockResolvedValue(undefined),
			forceCurrentSubtaskDone: vi.fn().mockResolvedValue(undefined),
		}
	})

	describe("case 'mode'", () => {
		it("switches modes normally when there is no active delegated child", async () => {
			mockProvider.getCurrentTask.mockReturnValue({ taskId: "task-1", parentTaskId: undefined })

			await webviewMessageHandler(mockProvider as unknown as ClineProvider, {
				type: "mode",
				text: "outline",
			})

			expect(mockProvider.handleModeSwitch).toHaveBeenCalledWith("outline")
		})

		it("blocks the switch and shows a notice when the current task is a delegated child", async () => {
			const vscode = await import("vscode")
			mockProvider.getCurrentTask.mockReturnValue({ taskId: "child-1", parentTaskId: "parent-1" })

			await webviewMessageHandler(mockProvider as unknown as ClineProvider, {
				type: "mode",
				text: "outline",
			})

			expect(mockProvider.handleModeSwitch).not.toHaveBeenCalled()
			expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1)
		})
	})

	describe("case 'abandonSubtask'", () => {
		it("delegates to provider.abandonCurrentSubtask", async () => {
			await webviewMessageHandler(mockProvider as unknown as ClineProvider, {
				type: "abandonSubtask",
			})

			expect(mockProvider.abandonCurrentSubtask).toHaveBeenCalledTimes(1)
		})
	})

	describe("case 'forceSubtaskDone'", () => {
		it("delegates to provider.forceCurrentSubtaskDone", async () => {
			await webviewMessageHandler(mockProvider as unknown as ClineProvider, {
				type: "forceSubtaskDone",
			})

			expect(mockProvider.forceCurrentSubtaskDone).toHaveBeenCalledTimes(1)
		})
	})
})
