// npx vitest run src/core/webview/__tests__/webviewMessageHandler.rollback.spec.ts
import { describe, expect, it, vi, beforeEach } from "vitest"

import type { ExtensionMessage, WebviewMessage } from "@roo-code/types"

import { webviewMessageHandler } from "../webviewMessageHandler"
import { restoreLatestFile, rollbackFile, rollbackStep } from "../../checkpoints/rollback"
import type { Task } from "../../task/Task"
import type { ClineProvider } from "../ClineProvider"

// The rollback cases only call these two provider methods, so the provider
// double below is cast once at this boundary; the spy is shared so results
// can be asserted after the handler runs.
vi.mock("../../checkpoints/rollback", () => ({
	rollbackFile: vi.fn(),
	rollbackStep: vi.fn(),
	restoreLatestFile: vi.fn(),
}))

vi.mock("vscode", () => ({
	window: {
		showErrorMessage: vi.fn(),
	},
	workspace: {
		workspaceFolders: undefined,
	},
}))

// The no-task failure posts localized copy; the extension i18n loader only
// populates resources outside tests, so the spec pins the English values the
// handler asks for (path is relative to this file: ../../../i18n = src/i18n).
vi.mock("../../../i18n", () => ({
	changeLanguage: vi.fn(),
	t: (key: string) => {
		const values: Record<string, string> = {
			"common:errors.message.no_active_task_to_roll_back": "No active task to roll back from",
			"common:errors.message.no_active_task_to_restore": "No active task to restore from",
		}
		return values[key] ?? key
	},
}))

// Structural mock: the handler only needs the task identity for these cases.
const mockTask = {} as Task
const postMessageToWebview = vi.fn(async (_message: ExtensionMessage) => undefined)

function makeProvider(task: Task | undefined): ClineProvider {
	const provider = {
		getCurrentTask: () => task,
		postMessageToWebview,
	}
	// Cast at the spec boundary: the rollback cases only read getCurrentTask()
	// and observe postMessageToWebview calls on the structural double.
	return provider as unknown as ClineProvider
}

const provider = makeProvider(mockTask)

describe("webviewMessageHandler - change card rollback", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("checkpointRollbackFile", () => {
		it("restores the file and posts the success outcome back to the webview", async () => {
			vi.mocked(rollbackFile).mockResolvedValueOnce({ filePath: "src/a.ts", success: true })

			await webviewMessageHandler(provider, {
				type: "checkpointRollbackFile",
				payload: { cardTs: 1000, checkpointId: "abc123", filePath: "src/a.ts" },
			})

			expect(rollbackFile).toHaveBeenCalledWith(mockTask, "abc123", "src/a.ts")
			expect(postMessageToWebview).toHaveBeenCalledWith({
				type: "checkpointRollbackResult",
				checkpointRollbackResult: { cardTs: 1000, filePath: "src/a.ts", success: true },
			})
		})

		it("posts the error outcome when the restore fails", async () => {
			vi.mocked(rollbackFile).mockResolvedValueOnce({
				filePath: "src/a.ts",
				success: false,
				error: "checkpoint not found",
			})

			await webviewMessageHandler(provider, {
				type: "checkpointRollbackFile",
				payload: { cardTs: 1000, checkpointId: "abc123", filePath: "src/a.ts" },
			})

			expect(postMessageToWebview).toHaveBeenCalledWith({
				type: "checkpointRollbackResult",
				checkpointRollbackResult: {
					cardTs: 1000,
					filePath: "src/a.ts",
					success: false,
					error: "checkpoint not found",
				},
			})
		})

		it("posts a correlated failure result when there is no current task", async () => {
			const emptyProvider = makeProvider(undefined)

			await webviewMessageHandler(emptyProvider, {
				type: "checkpointRollbackFile",
				payload: { cardTs: 1000, checkpointId: "abc123", filePath: "src/a.ts" },
			})

			expect(rollbackFile).not.toHaveBeenCalled()
			// The requesting card must clear its pending state, so the handler
			// posts a correlated failure instead of nothing.
			expect(postMessageToWebview).toHaveBeenCalledWith({
				type: "checkpointRollbackResult",
				checkpointRollbackResult: {
					cardTs: 1000,
					filePath: "src/a.ts",
					success: false,
					error: "No active task to roll back from",
				},
			})
		})

		it("posts a correlated failure when the rollback itself throws", async () => {
			vi.mocked(rollbackFile).mockRejectedValueOnce(new Error("git restore failed"))

			await webviewMessageHandler(provider, {
				type: "checkpointRollbackFile",
				payload: { cardTs: 1000, checkpointId: "abc123", filePath: "src/a.ts" },
			})

			// The card must not stay pending: the handler turns the throw into a
			// correlated failure result instead of dropping the message.
			expect(postMessageToWebview).toHaveBeenCalledWith({
				type: "checkpointRollbackResult",
				checkpointRollbackResult: {
					cardTs: 1000,
					filePath: "src/a.ts",
					success: false,
					error: "Rollback failed: git restore failed",
				},
			})
		})
	})

	describe("checkpointRollbackStep", () => {
		it("restores every step file and posts the aggregated outcome", async () => {
			vi.mocked(rollbackStep).mockResolvedValueOnce({
				checkpointId: "abc123",
				files: [
					{ filePath: "src/a.ts", success: true },
					{ filePath: "src/b.ts", success: true },
				],
			})

			await webviewMessageHandler(provider, {
				type: "checkpointRollbackStep",
				payload: { cardTs: 1000, checkpointId: "abc123", filePaths: ["src/a.ts", "src/b.ts"] },
			})

			expect(rollbackStep).toHaveBeenCalledWith(mockTask, ["src/a.ts", "src/b.ts"], "abc123")
			expect(postMessageToWebview).toHaveBeenCalledWith({
				type: "checkpointRollbackResult",
				checkpointRollbackResult: {
					cardTs: 1000,
					success: true,
					files: [
						{ filePath: "src/a.ts", success: true },
						{ filePath: "src/b.ts", success: true },
					],
				},
			})
		})

		it("reports success false with the first failing file's error when a step file fails", async () => {
			vi.mocked(rollbackStep).mockResolvedValueOnce({
				checkpointId: "abc123",
				files: [
					{ filePath: "src/a.ts", success: true },
					{ filePath: "src/b.ts", success: false, error: "boom" },
				],
			})

			await webviewMessageHandler(provider, {
				type: "checkpointRollbackStep",
				payload: { cardTs: 1000, filePaths: ["src/a.ts", "src/b.ts"] },
			})

			// Without an explicit step checkpoint id the journal lookup is used.
			expect(rollbackStep).toHaveBeenCalledWith(mockTask, ["src/a.ts", "src/b.ts"], undefined)
			expect(postMessageToWebview).toHaveBeenCalledWith({
				type: "checkpointRollbackResult",
				checkpointRollbackResult: {
					cardTs: 1000,
					success: false,
					error: "boom",
					files: [
						{ filePath: "src/a.ts", success: true },
						{ filePath: "src/b.ts", success: false, error: "boom" },
					],
				},
			})
		})

		it("posts a correlated failure result when there is no current task", async () => {
			const emptyProvider = makeProvider(undefined)

			await webviewMessageHandler(emptyProvider, {
				type: "checkpointRollbackStep",
				payload: { cardTs: 1000, filePaths: ["src/a.ts"] },
			})

			expect(rollbackStep).not.toHaveBeenCalled()
			expect(postMessageToWebview).toHaveBeenCalledWith({
				type: "checkpointRollbackResult",
				checkpointRollbackResult: {
					cardTs: 1000,
					success: false,
					error: "No active task to roll back from",
				},
			})
		})

		it("posts a correlated failure when the step rollback itself throws", async () => {
			vi.mocked(rollbackStep).mockRejectedValueOnce(new Error("journal unreadable"))

			await webviewMessageHandler(provider, {
				type: "checkpointRollbackStep",
				payload: { cardTs: 1000, filePaths: ["src/a.ts"] },
			})

			expect(postMessageToWebview).toHaveBeenCalledWith({
				type: "checkpointRollbackResult",
				checkpointRollbackResult: {
					cardTs: 1000,
					success: false,
					error: "Rollback failed: journal unreadable",
				},
			})
		})

		it("ignores payloads that do not match the schema", async () => {
			await webviewMessageHandler(provider, {
				// Malformed on purpose (only the webview produces this message): the cast
				// lets the spec reach the handler's safeParse rejection without `any`.
				type: "checkpointRollbackFile",
				payload: { cardTs: 1000 } as unknown as WebviewMessage["payload"],
			})
			await webviewMessageHandler(provider, {
				type: "checkpointRollbackStep",
				payload: { cardTs: 1000, filePaths: [] },
			})
			await webviewMessageHandler(provider, {
				type: "checkpointRestoreLatestFile",
				payload: { cardTs: 1000 } as unknown as WebviewMessage["payload"],
			})

			expect(rollbackFile).not.toHaveBeenCalled()
			expect(rollbackStep).not.toHaveBeenCalled()
			expect(restoreLatestFile).not.toHaveBeenCalled()
			expect(postMessageToWebview).not.toHaveBeenCalled()
		})
	})

	describe("checkpointRestoreLatestFile", () => {
		it("restores the file to its latest recorded version and posts the success outcome", async () => {
			vi.mocked(restoreLatestFile).mockResolvedValueOnce({ filePath: "src/a.ts", success: true })

			await webviewMessageHandler(provider, {
				type: "checkpointRestoreLatestFile",
				payload: { cardTs: 1000, filePath: "src/a.ts" },
			})

			expect(restoreLatestFile).toHaveBeenCalledWith(mockTask, "src/a.ts")
			expect(postMessageToWebview).toHaveBeenCalledWith({
				type: "checkpointRollbackResult",
				checkpointRollbackResult: {
					cardTs: 1000,
					kind: "restore-latest",
					filePath: "src/a.ts",
					success: true,
				},
			})
		})

		it("flags a no-op restore-latest so the card can report it", async () => {
			vi.mocked(restoreLatestFile).mockResolvedValueOnce({ filePath: "src/a.ts", success: true, noOp: true })

			await webviewMessageHandler(provider, {
				type: "checkpointRestoreLatestFile",
				payload: { cardTs: 1000, filePath: "src/a.ts" },
			})

			expect(postMessageToWebview).toHaveBeenCalledWith({
				type: "checkpointRollbackResult",
				checkpointRollbackResult: {
					cardTs: 1000,
					kind: "restore-latest",
					filePath: "src/a.ts",
					success: true,
					noOp: true,
				},
			})
		})

		it("posts the error outcome when the restore fails", async () => {
			vi.mocked(restoreLatestFile).mockResolvedValueOnce({
				filePath: "src/a.ts",
				success: false,
				error: "Checkpoints are not enabled for this task",
			})

			await webviewMessageHandler(provider, {
				type: "checkpointRestoreLatestFile",
				payload: { cardTs: 1000, filePath: "src/a.ts" },
			})

			expect(postMessageToWebview).toHaveBeenCalledWith({
				type: "checkpointRollbackResult",
				checkpointRollbackResult: {
					cardTs: 1000,
					kind: "restore-latest",
					filePath: "src/a.ts",
					success: false,
					error: "Checkpoints are not enabled for this task",
				},
			})
		})

		it("posts a correlated failure result when there is no current task", async () => {
			const emptyProvider = makeProvider(undefined)

			await webviewMessageHandler(emptyProvider, {
				type: "checkpointRestoreLatestFile",
				payload: { cardTs: 1000, filePath: "src/a.ts" },
			})

			expect(restoreLatestFile).not.toHaveBeenCalled()
			// The requesting card must clear its pending state, so the handler
			// posts a correlated failure instead of nothing.
			expect(postMessageToWebview).toHaveBeenCalledWith({
				type: "checkpointRollbackResult",
				checkpointRollbackResult: {
					cardTs: 1000,
					kind: "restore-latest",
					filePath: "src/a.ts",
					success: false,
					error: "No active task to restore from",
				},
			})
		})

		it("posts a correlated failure when the restore itself throws", async () => {
			vi.mocked(restoreLatestFile).mockRejectedValueOnce(new Error("git checkout failed"))

			await webviewMessageHandler(provider, {
				type: "checkpointRestoreLatestFile",
				payload: { cardTs: 1000, filePath: "src/a.ts" },
			})

			expect(postMessageToWebview).toHaveBeenCalledWith({
				type: "checkpointRollbackResult",
				checkpointRollbackResult: {
					cardTs: 1000,
					kind: "restore-latest",
					filePath: "src/a.ts",
					success: false,
					error: "Restore failed: git checkout failed",
				},
			})
		})
	})
})
