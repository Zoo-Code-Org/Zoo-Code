// npx vitest core/webview/__tests__/webviewMessageHandler.openFile.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"
import * as nodePath from "path"
import * as nodeFs from "fs"
import type { PathLike } from "fs"
import * as vscode from "vscode"
import { openFile } from "../../../integrations/misc/open-file"
import { webviewMessageHandler } from "../webviewMessageHandler"
import { decodeUntrustedPathToStable, isRealPathOutsideWorkspace } from "../../../utils/pathUtils"
import type { ClineProvider } from "../ClineProvider"
import type { Task } from "../../task/Task"

vi.mock("../../../api/providers/fetchers/modelCache")

// Platform-native mock roots: the production isPathOutsideWorkspace resolves
// with node's path module, so POSIX-style roots would not match on Windows.
const IS_WIN = process.platform === "win32"
const WORKSPACE_ROOT = IS_WIN ? "C:\\mock\\workspace" : "/mock/workspace"
const OTHER_ROOT = IS_WIN ? "C:\\mock\\workspace2" : "/mock/workspace2"
const OUTSIDE_ROOT = IS_WIN ? "C:\\outside" : "/outside"
const MOCK_CWD = nodePath.join(WORKSPACE_ROOT, "project")
const OUTSIDE_ABS = nodePath.join(OUTSIDE_ROOT, "passwd")

// Mirrors the i18n mock's echo format so assertions are exact on every platform.
const cannotAccessPathError = (pathValue: string) =>
	`common:errors.cannot_access_path:${JSON.stringify({ path: pathValue, error: "common:errors.path_outside_workspace" })}`

// Mutable holder for the vscode mock (vi.mock factories are hoisted above the
// constants above): tests reassign the workspace folders per case, and the
// production isPathOutsideWorkspace reads them through this getter.
const vscodeState = vi.hoisted(() => ({
	workspaceFolders: [] as { uri: { fsPath: string } }[],
}))

vi.mock("vscode", () => ({
	window: {
		showInformationMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		showTextDocument: vi.fn(),
	},
	workspace: {
		get workspaceFolders() {
			return vscodeState.workspaceFolders
		},
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

// The real utils/pathUtils runs unmocked on purpose: the handler's
// containment must be exercised through the production predicate (lexical
// and realpath-based), not a hand-rolled copy.

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

// Deterministic real-filesystem model for the realpath-based containment:
// explicit symlink targets plus a set of "existing" paths; everything else is
// ENOENT, so the real-path helper walks up to the deepest existing ancestor.
// Keeps the tests portable without touching the real filesystem.
const realWorld = vi.hoisted(() => ({
	existing: new Set<string>(),
	symlinks: new Map<string, string>(),
}))

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
		vscodeState.workspaceFolders = [{ uri: { fsPath: WORKSPACE_ROOT } }]
		realWorld.existing.clear()
		realWorld.symlinks.clear()
		realWorld.existing.add(WORKSPACE_ROOT)
		realWorld.existing.add(MOCK_CWD)
		vi.spyOn(nodeFs.promises, "realpath").mockImplementation(async (p: PathLike) => {
			const key = String(p)
			const symlink = realWorld.symlinks.get(key)
			if (symlink) {
				return symlink
			}
			if (realWorld.existing.has(key)) {
				return key
			}
			const err = new Error(`ENOENT: no such file or directory, realpath '${key}'`)
			;(err as NodeJS.ErrnoException).code = "ENOENT"
			throw err
		})
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
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(cannotAccessPathError("../../.env"))
	})

	it("rejects a markdown absolute path outside the workspace", async () => {
		await webviewMessageHandler(mockProvider, {
			type: "openFile",
			text: OUTSIDE_ABS,
			values: { fromMarkdown: true },
		})

		expect(openFile).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(cannotAccessPathError(OUTSIDE_ABS))
	})

	it("opens a markdown file using an absolute path within the workspace", async () => {
		await webviewMessageHandler(mockProvider, {
			type: "openFile",
			text: nodePath.join(MOCK_CWD, "src/index.ts"),
			values: { fromMarkdown: true },
		})

		expect(openFile).toHaveBeenCalledWith(nodePath.join(MOCK_CWD, "src/index.ts"), { fromMarkdown: true })
		expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
	})

	// openFile decodes the path AFTER the containment checks, so percent-encoded
	// traversal must be decoded at the containment boundary instead.
	it("rejects a percent-encoded traversal (%2e%2e) posted by the webview", async () => {
		await webviewMessageHandler(mockProvider, {
			type: "openFile",
			text: "./%2e%2e/%2e%2e/.env",
			values: { fromMarkdown: true },
		})

		expect(openFile).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(cannotAccessPathError("./%2e%2e/%2e%2e/.env"))
	})

	it("rejects a double-encoded traversal (%252e%252e) that only escapes after two decodes", async () => {
		await webviewMessageHandler(mockProvider, {
			type: "openFile",
			text: "./%252e%252e/%252e%252e/.env",
			values: { fromMarkdown: true },
		})

		expect(openFile).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			cannotAccessPathError("./%252e%252e/%252e%252e/.env"),
		)
	})

	it("opens a legitimately percent-encoded filename within the workspace", async () => {
		await webviewMessageHandler(mockProvider, {
			type: "openFile",
			text: "src/report%202024.txt",
			values: { fromMarkdown: true },
		})

		expect(openFile).toHaveBeenCalledWith(nodePath.join(MOCK_CWD, "src/report 2024.txt"), { fromMarkdown: true })
		expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
	})

	// Lexical containment cannot see symlinks: a link inside the workspace may
	// resolve to a target outside it.
	it("rejects a symlink inside the workspace that resolves outside of it", async () => {
		realWorld.symlinks.set(nodePath.join(MOCK_CWD, "link.txt"), nodePath.join(OUTSIDE_ROOT, "secret.txt"))

		await webviewMessageHandler(mockProvider, {
			type: "openFile",
			text: "link.txt",
			values: { fromMarkdown: true },
		})

		expect(openFile).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(cannotAccessPathError("link.txt"))
	})

	it("allows creating a new file under a new directory inside the workspace", async () => {
		await webviewMessageHandler(mockProvider, {
			type: "openFile",
			text: "newdir/note.txt",
			values: { create: true, fromMarkdown: true },
		})

		// The target does not exist yet, so containment is verified against its
		// deepest existing ancestor (MOCK_CWD), which is inside the workspace.
		expect(openFile).toHaveBeenCalledWith(nodePath.join(MOCK_CWD, "newdir/note.txt"), {
			create: true,
			fromMarkdown: true,
		})
		expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
	})

	it("accepts a tagged path inside a second workspace folder (multi-root)", async () => {
		vscodeState.workspaceFolders = [{ uri: { fsPath: WORKSPACE_ROOT } }, { uri: { fsPath: OTHER_ROOT } }]
		realWorld.existing.add(OTHER_ROOT)

		await webviewMessageHandler(mockProvider, {
			type: "openFile",
			text: nodePath.join(OTHER_ROOT, "x.ts"),
			values: { fromMarkdown: true },
		})

		expect(openFile).toHaveBeenCalledWith(nodePath.join(OTHER_ROOT, "x.ts"), { fromMarkdown: true })
		expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
	})

	it("rejects a tagged request when no workspace folders are configured", async () => {
		vscodeState.workspaceFolders = []

		await webviewMessageHandler(mockProvider, {
			type: "openFile",
			text: "src/index.ts",
			values: { fromMarkdown: true },
		})

		expect(openFile).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(cannotAccessPathError("src/index.ts"))
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

	// The boundary decodes tagged requests only: untagged callers keep the
	// legacy path exactly, so openFile's later decode applies exactly once.
	it("keeps untagged percent-encoded paths undecoded at the boundary", async () => {
		await webviewMessageHandler(mockProvider, {
			type: "openFile",
			text: "src/a%20b.txt",
		})

		expect(openFile).toHaveBeenCalledWith(nodePath.join(MOCK_CWD, "src/a%20b.txt"), undefined)
		expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
	})

	// A hostile encoding that never stabilizes inside the fixed-point bound is
	// rejected at the boundary (pinned here and by the direct helper test).
	it("rejects a tagged encoding that does not stabilize within the bound", async () => {
		const spy = vi.spyOn(globalThis, "decodeURIComponent").mockImplementation((s: string) => `${s}x`)
		try {
			await webviewMessageHandler(mockProvider, {
				type: "openFile",
				text: "a",
				values: { fromMarkdown: true },
			})

			expect(openFile).not.toHaveBeenCalled()
			expect(vscode.window.showErrorMessage).toHaveBeenCalled()
		} finally {
			spy.mockRestore()
		}
	})

	// Defense in depth: a lexically outside path whose symlinked ancestor
	// resolves inside the workspace is still rejected by the lexical check.
	it("rejects a lexically outside path even when its symlinked ancestor resolves inside the workspace", async () => {
		realWorld.symlinks.set(nodePath.join(OUTSIDE_ROOT, "link-in"), MOCK_CWD)

		await webviewMessageHandler(mockProvider, {
			type: "openFile",
			text: nodePath.join(OUTSIDE_ROOT, "link-in", "f.txt"),
			values: { fromMarkdown: true },
		})

		expect(openFile).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			cannotAccessPathError(nodePath.join(OUTSIDE_ROOT, "link-in", "f.txt")),
		)
	})
})

describe("utils/pathUtils containment helpers", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vscodeState.workspaceFolders = [{ uri: { fsPath: WORKSPACE_ROOT } }]
		realWorld.existing.clear()
		realWorld.symlinks.clear()
		realWorld.existing.add(WORKSPACE_ROOT)
		realWorld.existing.add(MOCK_CWD)
		vi.spyOn(nodeFs.promises, "realpath").mockImplementation(async (p: PathLike) => {
			const key = String(p)
			const symlink = realWorld.symlinks.get(key)
			if (symlink) {
				return symlink
			}
			if (realWorld.existing.has(key)) {
				return key
			}
			const err = new Error(`ENOENT: no such file or directory, realpath '${key}'`)
			;(err as NodeJS.ErrnoException).code = "ENOENT"
			throw err
		})
	})

	describe("decodeUntrustedPathToStable", () => {
		it("returns a stable path unchanged", () => {
			expect(decodeUntrustedPathToStable("src/index.ts")).toBe("src/index.ts")
		})

		it("decodes to a fixed point", () => {
			expect(decodeUntrustedPathToStable("./%2e%2e/%2e%2e/.env")).toBe("./../../.env")
			expect(decodeUntrustedPathToStable("%252e%252e")).toBe("..")
		})

		it("leaves a bare percent that is not a valid escape unchanged", () => {
			expect(decodeUntrustedPathToStable("report 50%.md")).toBe("report 50%.md")
		})

		it("returns null when the value does not stabilize within the bound", () => {
			const spy = vi.spyOn(globalThis, "decodeURIComponent").mockImplementation((s: string) => `${s}x`)
			try {
				expect(decodeUntrustedPathToStable("a")).toBeNull()
			} finally {
				spy.mockRestore()
			}
		})
	})

	describe("isRealPathOutsideWorkspace", () => {
		it("fails closed when no workspace folders are configured", async () => {
			vscodeState.workspaceFolders = []
			await expect(isRealPathOutsideWorkspace(nodePath.join(MOCK_CWD, "x.ts"))).resolves.toBe(true)
		})

		it("accepts an existing path inside the workspace", async () => {
			realWorld.existing.add(nodePath.join(MOCK_CWD, "x.ts"))
			await expect(isRealPathOutsideWorkspace(nodePath.join(MOCK_CWD, "x.ts"))).resolves.toBe(false)
		})

		it("accepts a missing file via its deepest existing in-workspace ancestor", async () => {
			await expect(isRealPathOutsideWorkspace(nodePath.join(MOCK_CWD, "newdir", "x.ts"))).resolves.toBe(false)
		})

		it("rejects a symlink whose target is outside the workspace", async () => {
			realWorld.symlinks.set(nodePath.join(MOCK_CWD, "link.txt"), nodePath.join(OUTSIDE_ROOT, "secret.txt"))
			await expect(isRealPathOutsideWorkspace(nodePath.join(MOCK_CWD, "link.txt"))).resolves.toBe(true)
		})

		it("fails closed on an unexpected filesystem error", async () => {
			const err = new Error("EACCES: permission denied")
			;(err as NodeJS.ErrnoException).code = "EACCES"
			const spy = vi.spyOn(nodeFs.promises, "realpath").mockRejectedValue(err)
			try {
				await expect(isRealPathOutsideWorkspace(nodePath.join(MOCK_CWD, "x.ts"))).resolves.toBe(true)
			} finally {
				spy.mockRestore()
			}
		})

		it("fails closed when no ancestor exists down to the filesystem root", async () => {
			// Nothing exists in the model: the ancestor walk reaches the root
			// guard instead of an existing ancestor, and containment fails closed.
			realWorld.existing.clear()
			await expect(isRealPathOutsideWorkspace(nodePath.join(MOCK_CWD, "x.ts"))).resolves.toBe(true)
		})

		it("fails closed when a workspace folder cannot be realized", async () => {
			realWorld.existing.add(nodePath.join(MOCK_CWD, "x.ts"))
			const err = new Error("EACCES: permission denied")
			;(err as NodeJS.ErrnoException).code = "EACCES"
			vi.spyOn(nodeFs.promises, "realpath").mockImplementation(async (p: PathLike) => {
				const key = String(p)
				if (key === WORKSPACE_ROOT) {
					throw err
				}
				const symlink = realWorld.symlinks.get(key)
				if (symlink) {
					return symlink
				}
				if (realWorld.existing.has(key)) {
					return key
				}
				const enoent = new Error(`ENOENT: no such file or directory, realpath '${key}'`)
				;(enoent as NodeJS.ErrnoException).code = "ENOENT"
				throw enoent
			})

			await expect(isRealPathOutsideWorkspace(nodePath.join(MOCK_CWD, "x.ts"))).resolves.toBe(true)
		})
	})
})
