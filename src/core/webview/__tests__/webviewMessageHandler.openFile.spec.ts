// npx vitest core/webview/__tests__/webviewMessageHandler.openFile.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"
import * as nodePath from "path"
import * as vscode from "vscode"
import { openFile } from "../../../integrations/misc/open-file"
import { webviewMessageHandler } from "../webviewMessageHandler"
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
		workspaceFolders: [{ uri: { fsPath: "/mock/workspace" } }],
		openTextDocument: vi.fn().mockResolvedValue({}),
	},
	commands: {
		executeCommand: vi.fn(),
	},
}))

vi.mock("../../../i18n", () => ({
	// Echo the key with params serialized so tests can assert the full
	// message arguments without loading a real i18n catalogue.
	t: vi.fn((key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key)),
}))

vi.mock("../../../utils/fs")
vi.mock("../../../utils/path")
vi.mock("../../../utils/globalContext")

// Hand-rolled containment check mirroring isPathOutsideWorkspace, but resolving
// the workspace root too so the mock works on both POSIX and Windows test runs.
vi.mock("../../../utils/pathUtils", () => ({
	isPathOutsideWorkspace: vi.fn((filePath: string) => {
		const nodePath = require("path")
		const normalized = nodePath.resolve(filePath)
		const workspaceRoot = nodePath.resolve("/mock/workspace")
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

// Mock the openFile module so the test observes the handler's resolved path and
// proves markdown-sourced requests never reach out-of-workspace targets.
vi.mock("../../../integrations/misc/open-file", () => ({
	openFile: vi.fn().mockResolvedValue(undefined),
}))

const MOCK_CWD = "/mock/workspace/project"

const mockProvider = {
	getState: vi.fn(),
	postMessageToWebview: vi.fn(),
	customModesManager: {
		getCustomModes: vi.fn(),
		deleteCustomMode: vi.fn(),
	},
	context: {
		extensionPath: "/mock/extension/path",
		globalStorageUri: { fsPath: "/mock/global/storage" },
	},
	contextProxy: {
		context: {
			extensionPath: "/mock/extension/path",
			globalStorageUri: { fsPath: "/mock/global/storage" },
		},
		setValue: vi.fn(),
		getValue: vi.fn(),
	},
	log: vi.fn(),
	postStateToWebview: vi.fn(),
	getCurrentTask: vi.fn().mockReturnValue({ cwd: MOCK_CWD }),
	getTaskWithId: vi.fn(),
	createTaskWithHistoryItem: vi.fn(),
	cwd: MOCK_CWD,
} as unknown as ClineProvider

describe("webviewMessageHandler - openFile markdown workspace containment", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		// The containment logic only reads `cwd`; a full Task would be noise. The single
		// assertion is safe because Task is structurally compatible with the stub.
		vi.mocked(mockProvider.getCurrentTask).mockReturnValue({ cwd: MOCK_CWD } as Task)
		;(mockProvider as { cwd?: string }).cwd = MOCK_CWD
	})

	// MarkdownBlock tags its openFile posts with fromMarkdown, flagging the
	// request as sourced from untrusted task markdown.
	it("opens a markdown file within the workspace using a relative path", async () => {
		await webviewMessageHandler(mockProvider, {
			type: "openFile",
			text: "src/index.ts",
			values: { line: 3, fromMarkdown: true },
		})

		expect(openFile).toHaveBeenCalledWith(nodePath.resolve(MOCK_CWD, "src/index.ts"), {
			line: 3,
			fromMarkdown: true,
		})
		expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
	})

	it("rejects a markdown relative path that traverses outside the workspace", async () => {
		await webviewMessageHandler(mockProvider, {
			type: "openFile",
			text: "../../.env",
			values: { fromMarkdown: true },
		})

		expect(openFile).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			'common:errors.cannot_access_path:{"path":"../../.env","error":"common:errors.path_outside_workspace"}',
		)
	})

	it("rejects a markdown absolute path outside the workspace", async () => {
		await webviewMessageHandler(mockProvider, {
			type: "openFile",
			text: "/etc/passwd",
			values: { fromMarkdown: true },
		})

		expect(openFile).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			'common:errors.cannot_access_path:{"path":"/etc/passwd","error":"common:errors.path_outside_workspace"}',
		)
	})

	it("opens a markdown file using an absolute path within the workspace", async () => {
		await webviewMessageHandler(mockProvider, {
			type: "openFile",
			text: `${MOCK_CWD}/src/index.ts`,
			values: { fromMarkdown: true },
		})

		expect(openFile).toHaveBeenCalledWith(`${MOCK_CWD}/src/index.ts`, { fromMarkdown: true })
		expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
	})

	// First-party callers (slash-command settings, modes, MCP) are not flagged
	// and keep the previous behavior, including global config files that live
	// outside the workspace.
	it("keeps legacy behavior for untagged callers opening paths outside the workspace", async () => {
		await webviewMessageHandler(mockProvider, {
			type: "openFile",
			text: "/global/roo/commands/my-command.md",
		})

		expect(openFile).toHaveBeenCalledWith("/global/roo/commands/my-command.md", undefined)
		expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
	})

	it("does nothing when no path is provided", async () => {
		await webviewMessageHandler(mockProvider, {
			type: "openFile",
		})

		expect(openFile).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
	})

	it("shows an error when no workspace cwd is available", async () => {
		vi.mocked(mockProvider.getCurrentTask).mockReturnValue(undefined)
		;(mockProvider as { cwd?: string }).cwd = undefined

		await webviewMessageHandler(mockProvider, {
			type: "openFile",
			text: "src/index.ts",
			values: { fromMarkdown: true },
		})

		expect(openFile).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			'common:errors.could_not_open_file:{"errorMessage":"common:errors.no_workspace"}',
		)
	})
})
