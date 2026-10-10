// npx vitest core/webview/__tests__/webviewMessageHandler.readOriginalContent.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../api/providers/fetchers/modelCache")

vi.mock("vscode", () => ({
	window: {
		showInformationMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		showTextDocument: vi.fn(),
	},
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/mock/workspace" } }],
		openTextDocument: vi.fn().mockResolvedValue({}),
	},
}))

vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string) => key),
}))

vi.mock("fs/promises", () => {
	const readFile = vi.fn().mockResolvedValue("file content here")
	return {
		default: {
			rm: vi.fn(),
			mkdir: vi.fn(),
			readFile,
			writeFile: vi.fn(),
		},
		rm: vi.fn(),
		mkdir: vi.fn(),
		readFile,
		writeFile: vi.fn(),
	}
})

vi.mock("../../../utils/fs")
vi.mock("../../../utils/path")
vi.mock("../../../utils/globalContext")

vi.mock("../../../utils/pathUtils", () => ({
	isPathOutsideWorkspace: vi.fn((filePath: string) => {
		const nodePath = require("path")
		const normalized = nodePath.resolve(filePath)
		const workspaceRoot = nodePath.resolve("/mock/workspace")
		// Path is inside workspace if it equals or is under workspace root
		if (normalized === workspaceRoot) return false
		if (normalized.startsWith(workspaceRoot + nodePath.sep)) return false
		return true
	}),
}))

vi.mock("../../mentions/resolveImageMentions", () => ({
	resolveImageMentions: vi.fn(async ({ text, images }: { text: string; images?: string[] }) => ({
		text,
		images: [...(images ?? [])],
	})),
}))

import { webviewMessageHandler } from "../webviewMessageHandler"
import type { ClineProvider } from "../ClineProvider"
import type { ClineMessage } from "@roo-code/types"

const originalFile = "const a = 1\nconst b = 2\n"

const toolMessage = (
	ts: number,
	payload: unknown,
	type: "ask" | "say" = "ask",
	messageId?: string,
	isAnswered = true,
): ClineMessage =>
	type === "ask"
		? { ts, type: "ask", ask: "tool", text: JSON.stringify(payload), isAnswered, ...(messageId && { messageId }) }
		: { ts, type: "say", say: "tool", text: JSON.stringify(payload), ...(messageId && { messageId }) }

function createProvider(clineMessages: ClineMessage[] | undefined) {
	const postMessageToWebview = vi.fn()
	// Only the members the handler touches for this message type.
	const provider = {
		postMessageToWebview,
		getCurrentTask: vi.fn().mockReturnValue(clineMessages ? { taskId: "task-1", clineMessages } : undefined),
	} as unknown as ClineProvider

	return { provider, postMessageToWebview }
}

describe("webviewMessageHandler - readOriginalContent", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("answers with the originalContent of the requested tool message", async () => {
		const { provider, postMessageToWebview } = createProvider([
			toolMessage(10, { tool: "appliedDiff", path: "a.ts", diff: "d", originalContent: originalFile }),
			toolMessage(11, { tool: "appliedDiff", path: "b.ts", diff: "d", originalContent: "other" }),
		])

		await webviewMessageHandler(provider, { type: "readOriginalContent", messageTs: 10 })

		expect(postMessageToWebview).toHaveBeenCalledWith({
			type: "originalContent",
			originalContentInfo: { ts: 10, messageId: undefined, taskId: undefined, content: originalFile },
		})
	})

	it("answers with null content for an unknown ts or when there is no current task", async () => {
		const unknown = createProvider([toolMessage(40, { tool: "appliedDiff", originalContent: "x" })])
		await webviewMessageHandler(unknown.provider, { type: "readOriginalContent", messageTs: 999 })
		expect(unknown.postMessageToWebview).toHaveBeenCalledWith({
			type: "originalContent",
			originalContentInfo: { ts: 999, messageId: undefined, taskId: undefined, content: null },
		})

		const noTask = createProvider(undefined)
		await webviewMessageHandler(noTask.provider, { type: "readOriginalContent", messageTs: 10 })
		expect(noTask.postMessageToWebview).toHaveBeenCalledWith({
			type: "originalContent",
			originalContentInfo: { ts: 10, messageId: undefined, taskId: undefined, content: null },
		})
	})

	it("picks the message by messageId when two messages share a ts", async () => {
		const { provider, postMessageToWebview } = createProvider([
			toolMessage(10, { tool: "appliedDiff", path: "a.ts", originalContent: "first" }, "ask", "id-1"),
			toolMessage(10, { tool: "appliedDiff", path: "b.ts", originalContent: "second" }, "ask", "id-2"),
		])

		await webviewMessageHandler(provider, { type: "readOriginalContent", messageTs: 10, messageId: "id-2" })

		expect(postMessageToWebview).toHaveBeenCalledWith({
			type: "originalContent",
			originalContentInfo: { ts: 10, messageId: "id-2", taskId: undefined, content: "second" },
		})
	})

	it("echoes the task id and answers null for a request made for another task", async () => {
		const { provider, postMessageToWebview } = createProvider([
			toolMessage(10, { tool: "appliedDiff", originalContent: originalFile }, "ask", "id-1"),
		])

		await webviewMessageHandler(provider, {
			type: "readOriginalContent",
			messageTs: 10,
			messageId: "id-1",
			taskId: "task-1",
		})
		await webviewMessageHandler(provider, {
			type: "readOriginalContent",
			messageTs: 10,
			messageId: "id-1",
			taskId: "task-2",
		})

		expect(postMessageToWebview).toHaveBeenNthCalledWith(1, {
			type: "originalContent",
			originalContentInfo: { ts: 10, messageId: "id-1", taskId: "task-1", content: originalFile },
		})
		expect(postMessageToWebview).toHaveBeenNthCalledWith(2, {
			type: "originalContent",
			originalContentInfo: { ts: 10, messageId: "id-1", taskId: "task-2", content: null },
		})
	})

	it("answers null for an unanswered or denied edit approval", async () => {
		const { provider, postMessageToWebview } = createProvider([
			toolMessage(10, { tool: "appliedDiff", originalContent: originalFile }, "ask", "id-1", false),
		])

		await webviewMessageHandler(provider, { type: "readOriginalContent", messageTs: 10, messageId: "id-1" })

		expect(postMessageToWebview).toHaveBeenCalledWith({
			type: "originalContent",
			originalContentInfo: { ts: 10, messageId: "id-1", taskId: undefined, content: null },
		})
	})

	it("ignores a request without a ts", async () => {
		const { provider, postMessageToWebview } = createProvider([
			toolMessage(10, { tool: "appliedDiff", originalContent: "x" }),
		])

		await webviewMessageHandler(provider, { type: "readOriginalContent" })

		expect(postMessageToWebview).not.toHaveBeenCalled()
	})
})
