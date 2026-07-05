// npx vitest run __tests__/concierge-transition-ux.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"

/* vscode mock for Task/Provider imports */
vi.mock("vscode", () => {
	const window = {
		createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
	}
	const workspace = {
		getConfiguration: vi.fn(() => ({
			get: vi.fn((_key: string, defaultValue: any) => defaultValue),
			update: vi.fn(),
		})),
		workspaceFolders: [],
	}
	const env = { machineId: "test-machine", uriScheme: "vscode", appName: "VSCode", language: "en", sessionId: "sess" }
	const Uri = { file: (p: string) => ({ fsPath: p, toString: () => p }) }
	const commands = { executeCommand: vi.fn() }
	const ExtensionMode = { Development: 2 }
	const version = "1.0.0-test"
	return { window, workspace, env, Uri, commands, ExtensionMode, version }
})

// Mock persistence BEFORE importing provider
vi.mock("../core/task-persistence/taskMessages", () => ({
	readTaskMessages: vi.fn().mockResolvedValue([]),
}))
vi.mock("../core/task-persistence", () => ({
	readApiMessages: vi.fn().mockResolvedValue([]),
	saveApiMessages: vi.fn().mockResolvedValue(undefined),
	saveTaskMessages: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("p-wait-for", () => ({
	default: vi.fn().mockImplementation(async () => Promise.resolve()),
}))
vi.mock("../i18n", () => ({
	t: (key: string) => key,
}))

import { ClineProvider } from "../core/webview/ClineProvider"

describe("Phase 3 transition UX — abandon and force-done", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("abandonCurrentSubtask", () => {
		it("does nothing when the current task has no parent", async () => {
			const reopenParentFromDelegation = vi.fn()
			const task = { taskId: "solo-task", parentTaskId: undefined }
			const provider = {
				getCurrentTask: vi.fn(() => task),
				reopenParentFromDelegation,
			} as unknown as ClineProvider

			await (ClineProvider.prototype as any).abandonCurrentSubtask.call(provider)

			expect(reopenParentFromDelegation).not.toHaveBeenCalled()
		})

		it("cancels the in-flight request and reopens the parent with a synthetic abandonment summary", async () => {
			const cancelCurrentRequest = vi.fn()
			const abortTask = vi.fn()
			const task = {
				taskId: "child-1",
				parentTaskId: "parent-1",
				cancelCurrentRequest,
				abortTask,
				isStreaming: false,
			}

			const reopenParentFromDelegation = vi.fn().mockResolvedValue(undefined)
			const provider = {
				getCurrentTask: vi.fn(() => task),
				reopenParentFromDelegation,
			} as unknown as ClineProvider

			await (ClineProvider.prototype as any).abandonCurrentSubtask.call(provider)

			expect(cancelCurrentRequest).toHaveBeenCalledTimes(1)
			expect(abortTask).toHaveBeenCalledTimes(1)
			expect(reopenParentFromDelegation).toHaveBeenCalledWith({
				parentTaskId: "parent-1",
				childTaskId: "child-1",
				completionResultSummary: "Session abandoned by the writer; no results to report.",
			})
		})
	})

	describe("forceCurrentSubtaskDone", () => {
		it("does nothing when the current task has no parent", async () => {
			const task = { taskId: "solo-task", parentTaskId: undefined }
			const provider = {
				getCurrentTask: vi.fn(() => task),
			} as unknown as ClineProvider

			await expect(
				(ClineProvider.prototype as any).forceCurrentSubtaskDone.call(provider),
			).resolves.toBeUndefined()
		})

		it("enqueues the completion instruction when the child is streaming", async () => {
			const addMessage = vi.fn()
			const submitUserMessage = vi.fn()
			const task = {
				taskId: "child-1",
				parentTaskId: "parent-1",
				isStreaming: true,
				messageQueueService: { addMessage },
				submitUserMessage,
			}
			const provider = { getCurrentTask: vi.fn(() => task) } as unknown as ClineProvider

			await (ClineProvider.prototype as any).forceCurrentSubtaskDone.call(provider)

			expect(addMessage).toHaveBeenCalledTimes(1)
			expect(submitUserMessage).not.toHaveBeenCalled()
		})

		it("submits the completion instruction directly when the child is idle", async () => {
			const addMessage = vi.fn()
			const submitUserMessage = vi.fn().mockResolvedValue(undefined)
			const task = {
				taskId: "child-1",
				parentTaskId: "parent-1",
				isStreaming: false,
				messageQueueService: { addMessage },
				submitUserMessage,
			}
			const provider = { getCurrentTask: vi.fn(() => task) } as unknown as ClineProvider

			await (ClineProvider.prototype as any).forceCurrentSubtaskDone.call(provider)

			expect(submitUserMessage).toHaveBeenCalledTimes(1)
			expect(addMessage).not.toHaveBeenCalled()
		})
	})
})
