import * as vscode from "vscode"

import { handleNewTask } from "../handleTask"
import { ClineProvider } from "../../core/webview/ClineProvider"
import { WebviewFocusTracker } from "../../core/webview/WebviewFocusTracker"
import { Package } from "../../shared/package"

vi.mock("vscode", () => ({
	window: { showInputBox: vi.fn() },
	commands: { executeCommand: vi.fn().mockResolvedValue(undefined) },
}))
vi.mock("../../core/webview/ClineProvider", () => ({
	ClineProvider: class {
		static getInstance = vi.fn()
		get isViewVisible() {
			return true
		}
	},
}))
vi.mock("../../i18n", () => ({ t: (key: string) => key }))

describe("handleNewTask", () => {
	let provider: ClineProvider
	let tracker: WebviewFocusTracker

	beforeEach(() => {
		vi.clearAllMocks()
		tracker = new WebviewFocusTracker()
		provider = Object.create(ClineProvider.prototype) as ClineProvider
		provider.handleCodeAction = vi.fn().mockResolvedValue(undefined)
		vi.mocked(ClineProvider.getInstance).mockResolvedValue(provider)
		vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined)
	})

	it("executes the supplied prompt on the resolved provider", async () => {
		await handleNewTask({ prompt: "new task" }, tracker)
		expect(ClineProvider.getInstance).toHaveBeenCalledOnce()
		expect(vscode.window.showInputBox).not.toHaveBeenCalled()
		expect(provider.handleCodeAction).toHaveBeenCalledWith("newTask", "NEW_TASK", { userInput: "new task" })
	})

	it("executes the prompt entered in the input dialog", async () => {
		vi.mocked(vscode.window.showInputBox).mockResolvedValue("entered task")
		await handleNewTask(undefined, tracker)
		expect(provider.handleCodeAction).toHaveBeenCalledWith("newTask", "NEW_TASK", { userInput: "entered task" })
	})

	it("focuses the sidebar without executing an action when input is cancelled", async () => {
		const getLastActive = vi.spyOn(tracker, "getLastActiveProvider")
		await handleNewTask(undefined, tracker)
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith(`${Package.name}.SidebarProvider.focus`)
		expect(ClineProvider.getInstance).not.toHaveBeenCalled()
		expect(getLastActive).not.toHaveBeenCalled()
		expect(provider.handleCodeAction).not.toHaveBeenCalled()
	})

	it("does nothing when no provider can be resolved", async () => {
		vi.mocked(ClineProvider.getInstance).mockResolvedValue(undefined)
		await handleNewTask({ prompt: "new task" }, tracker)
		expect(provider.handleCodeAction).not.toHaveBeenCalled()
	})

	it("awaits the provider action and propagates its error", async () => {
		const error = new Error("Task creation failed")
		vi.mocked(provider.handleCodeAction).mockRejectedValue(error)
		await expect(handleNewTask({ prompt: "new task" }, tracker)).rejects.toBe(error)
	})

	it.each(["supplied", "dialog"])(
		"uses the last active visible chat for a %s prompt without resolving another provider",
		async (source) => {
			vi.spyOn(tracker, "getLastActiveProvider").mockReturnValue(provider)
			const fallback = Object.create(ClineProvider.prototype) as ClineProvider
			fallback.handleCodeAction = vi.fn().mockResolvedValue(undefined)
			vi.mocked(ClineProvider.getInstance).mockResolvedValue(fallback)
			vi.mocked(vscode.window.showInputBox).mockResolvedValue("new task")
			await handleNewTask(source === "supplied" ? { prompt: "new task" } : undefined, tracker)
			expect(provider.handleCodeAction).toHaveBeenCalledWith("newTask", "NEW_TASK", { userInput: "new task" })
			expect(ClineProvider.getInstance).not.toHaveBeenCalled()
			expect(fallback.handleCodeAction).not.toHaveBeenCalled()
		},
	)

	it.each(["supplied", "dialog"])(
		"uses the fallback for a %s prompt when the last active chat is hidden",
		async (source) => {
			vi.spyOn(provider, "isViewVisible", "get").mockReturnValue(false)
			vi.spyOn(tracker, "getLastActiveProvider").mockReturnValue(provider)
			const fallback = Object.create(ClineProvider.prototype) as ClineProvider
			fallback.handleCodeAction = vi.fn().mockResolvedValue(undefined)
			vi.mocked(ClineProvider.getInstance).mockResolvedValue(fallback)
			vi.mocked(vscode.window.showInputBox).mockResolvedValue("new task")

			await handleNewTask(source === "supplied" ? { prompt: "new task" } : undefined, tracker)

			expect(ClineProvider.getInstance).toHaveBeenCalledOnce()
			expect(provider.handleCodeAction).not.toHaveBeenCalled()
			expect(fallback.handleCodeAction).toHaveBeenCalledExactlyOnceWith("newTask", "NEW_TASK", {
				userInput: "new task",
			})
		},
	)

	it.each(["supplied", "dialog"])(
		"does not execute a %s prompt on a hidden chat when fallback finds no provider",
		async (source) => {
			vi.spyOn(provider, "isViewVisible", "get").mockReturnValue(false)
			vi.spyOn(tracker, "getLastActiveProvider").mockReturnValue(provider)
			vi.mocked(ClineProvider.getInstance).mockResolvedValue(undefined)
			vi.mocked(vscode.window.showInputBox).mockResolvedValue("new task")

			await expect(
				handleNewTask(source === "supplied" ? { prompt: "new task" } : undefined, tracker),
			).resolves.toBeUndefined()

			expect(ClineProvider.getInstance).toHaveBeenCalledOnce()
			expect(provider.handleCodeAction).not.toHaveBeenCalled()
		},
	)
})
