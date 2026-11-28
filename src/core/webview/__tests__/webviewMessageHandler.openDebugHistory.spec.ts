// npx vitest core/webview/__tests__/webviewMessageHandler.openDebugHistory.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"
import * as nodePath from "path"
import * as os from "os"
import * as vscode from "vscode"

import { webviewMessageHandler } from "../webviewMessageHandler"
import { getTaskDirectoryPath } from "../../../utils/storage"
import { fileExistsAtPath } from "../../../utils/fs"
import type { ClineProvider } from "../ClineProvider"
import type { Task } from "../../task/Task"

vi.mock("../../../api/providers/fetchers/modelCache")

vi.mock("vscode", () => ({
	window: {
		showInformationMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		showTextDocument: vi.fn(),
	},
	workspace: {
		openTextDocument: vi.fn().mockResolvedValue({}),
	},
	commands: {
		executeCommand: vi.fn(),
	},
}))

vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key)),
}))

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return {
		...actual,
		readFile: vi.fn().mockResolvedValue(JSON.stringify({ hello: "world" })),
		writeFile: vi.fn().mockResolvedValue(undefined),
	}
})

// The handler only needs fileExistsAtPath from this module; keep every other
// export real so the rest of the module graph loads unchanged.
vi.mock("../../../utils/fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../utils/fs")>()
	return {
		...actual,
		fileExistsAtPath: vi.fn().mockResolvedValue(true),
	}
})

// Resolve child task directories deterministically and record the taskId the
// handler asked for; this is the assertion target of the taskId routing.
vi.mock("../../../utils/storage", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../utils/storage")>()
	return {
		...actual,
		getTaskDirectoryPath: vi.fn(
			async (_globalStoragePath: string, taskId: string) => `/mock/global/storage/tasks/${taskId}`,
		),
	}
})

const CURRENT_TASK_ID = "current-task-id-0000"
const CHILD_TASK_ID = "child-1234567890"

const mockProvider = {
	getState: vi.fn(),
	postMessageToWebview: vi.fn(),
	contextProxy: {
		globalStorageUri: { fsPath: "/mock/global/storage" },
		setValue: vi.fn(),
		getValue: vi.fn(),
	},
	log: vi.fn(),
	postStateToWebview: vi.fn(),
	getCurrentTask: vi.fn(),
} as unknown as ClineProvider

describe("webviewMessageHandler - openDebugApiHistory/openDebugUiHistory taskId routing", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(fileExistsAtPath).mockResolvedValue(true)
	})

	it("opens the requested child's ui log even when no current task exists", async () => {
		vi.mocked(mockProvider.getCurrentTask).mockReturnValue(undefined)

		await webviewMessageHandler(mockProvider, {
			type: "openDebugUiHistory",
			taskId: CHILD_TASK_ID,
		})

		expect(getTaskDirectoryPath).toHaveBeenCalledWith("/mock/global/storage", CHILD_TASK_ID)
		const fsPromises = await import("fs/promises")
		expect(fsPromises.readFile).toHaveBeenCalledWith(
			nodePath.join(`/mock/global/storage/tasks/${CHILD_TASK_ID}`, "ui_messages.json"),
			"utf8",
		)
		expect(fsPromises.writeFile).toHaveBeenCalledWith(
			expect.stringMatching(/roo-debug-ui-child-12-\d+\.json$/),
			JSON.stringify({ hello: "world" }, null, 2),
			"utf8",
		)
		const writtenPath = String(vi.mocked(fsPromises.writeFile).mock.calls[0][0])
		expect(writtenPath.startsWith(os.tmpdir())).toBe(true)
		expect(vscode.workspace.openTextDocument).toHaveBeenCalled()
		expect(vscode.window.showTextDocument).toHaveBeenCalledWith({}, { preview: true })
		expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
	})

	it("falls back to the current task's id when the message omits taskId", async () => {
		vi.mocked(mockProvider.getCurrentTask).mockReturnValue({ taskId: CURRENT_TASK_ID } as Task)

		await webviewMessageHandler(mockProvider, { type: "openDebugUiHistory" })

		expect(getTaskDirectoryPath).toHaveBeenCalledWith("/mock/global/storage", CURRENT_TASK_ID)
		const fsPromises = await import("fs/promises")
		expect(fsPromises.readFile).toHaveBeenCalledWith(
			nodePath.join(`/mock/global/storage/tasks/${CURRENT_TASK_ID}`, "ui_messages.json"),
			"utf8",
		)
		expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
	})

	it("prefers the explicit taskId over the current task", async () => {
		vi.mocked(mockProvider.getCurrentTask).mockReturnValue({ taskId: CURRENT_TASK_ID } as Task)

		await webviewMessageHandler(mockProvider, {
			type: "openDebugApiHistory",
			taskId: CHILD_TASK_ID,
		})

		expect(getTaskDirectoryPath).toHaveBeenCalledWith("/mock/global/storage", CHILD_TASK_ID)
		const fsPromises = await import("fs/promises")
		expect(fsPromises.readFile).toHaveBeenCalledWith(
			nodePath.join(`/mock/global/storage/tasks/${CHILD_TASK_ID}`, "api_conversation_history.json"),
			"utf8",
		)
		expect(fsPromises.writeFile).toHaveBeenCalledWith(
			expect.stringMatching(/roo-debug-api-child-12-\d+\.json$/),
			expect.any(String),
			"utf8",
		)
	})

	it("keeps the no-active-task error when neither taskId nor current task exists", async () => {
		vi.mocked(mockProvider.getCurrentTask).mockReturnValue(undefined)

		await webviewMessageHandler(mockProvider, { type: "openDebugApiHistory" })

		expect(getTaskDirectoryPath).not.toHaveBeenCalled()
		const fsPromises = await import("fs/promises")
		expect(fsPromises.readFile).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("No active task to view history for")
	})

	it.each(["openDebugApiHistory", "openDebugUiHistory"] as const)(
		"rejects a traversal taskId for %s with no filesystem access and no fallback to the current task",
		async (type) => {
			// A current task exists: the guard must not fall back to it either.
			vi.mocked(mockProvider.getCurrentTask).mockReturnValue({ taskId: CURRENT_TASK_ID } as Task)

			await webviewMessageHandler(mockProvider, {
				type,
				taskId: "../../other-uuid-1234",
			})

			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Invalid task id for debug history")
			expect(getTaskDirectoryPath).not.toHaveBeenCalled()
			const fsPromises = await import("fs/promises")
			expect(fsPromises.readFile).not.toHaveBeenCalled()
			expect(fsPromises.writeFile).not.toHaveBeenCalled()
			expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled()
			expect(mockProvider.log).toHaveBeenCalledWith(
				expect.stringContaining("Rejected debug history request with unsafe taskId"),
			)
		},
	)

	it("rejects a taskId over 128 characters", async () => {
		vi.mocked(mockProvider.getCurrentTask).mockReturnValue(undefined)

		await webviewMessageHandler(mockProvider, {
			type: "openDebugUiHistory",
			taskId: "a".repeat(129),
		})

		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Invalid task id for debug history")
		expect(getTaskDirectoryPath).not.toHaveBeenCalled()
	})

	it("accepts a max-length taskId using the full allowed alphabet", async () => {
		const validId = "Aa0_-".repeat(25) + "ABC" // 128 chars of [A-Za-z0-9_-]
		expect(validId).toHaveLength(128)
		vi.mocked(mockProvider.getCurrentTask).mockReturnValue(undefined)

		await webviewMessageHandler(mockProvider, {
			type: "openDebugApiHistory",
			taskId: validId,
		})

		expect(getTaskDirectoryPath).toHaveBeenCalledWith("/mock/global/storage", validId)
		const fsPromises = await import("fs/promises")
		expect(fsPromises.readFile).toHaveBeenCalled()
		expect(fsPromises.writeFile).toHaveBeenCalledWith(
			expect.stringMatching(new RegExp(`roo-debug-api-${validId.slice(0, 8)}-\\d+\\.json$`)),
			expect.any(String),
			"utf8",
		)
		expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
	})
})
