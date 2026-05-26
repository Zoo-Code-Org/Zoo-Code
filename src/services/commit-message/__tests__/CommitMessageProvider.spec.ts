import * as path from "path"
import * as vscode from "vscode"

import { CommitMessageProvider, isPathWithinRepository } from "../CommitMessageProvider"

vi.mock("vscode", () => ({
	window: {
		showWarningMessage: vi.fn(),
	},
	workspace: {
		workspaceFolders: undefined,
	},
	Uri: {
		file: (fsPath: string) => ({ fsPath }),
	},
}))

describe("CommitMessageProvider", () => {
	const createProvider = () =>
		new CommitMessageProvider(
			{} as vscode.ExtensionContext,
			{ appendLine: vi.fn() } as unknown as vscode.OutputChannel,
		)

	beforeEach(() => {
		vi.clearAllMocks()
		;(vscode.workspace as any).workspaceFolders = undefined
	})

	it("matches repository roots by path containment instead of string prefix", () => {
		const root = path.parse(process.cwd()).root
		const repositoryPath = path.join(root, "work", "app")

		expect(isPathWithinRepository(path.join(repositoryPath, "src", "index.ts"), repositoryPath)).toBe(true)
		expect(isPathWithinRepository(repositoryPath, repositoryPath)).toBe(true)
		expect(isPathWithinRepository(path.join(root, "work", "application"), repositoryPath)).toBe(false)
	})

	it("adds existing commit input to the generation context", () => {
		const provider = createProvider()
		const gitContext = "diff --git a/src/file.ts b/src/file.ts"

		const contextWithDraft = (provider as any).appendExistingCommitMessageDraft(gitContext, "existing message")

		expect(contextWithDraft).toContain(gitContext)
		expect(contextWithDraft).toContain("## Existing Commit Message Draft")
		expect(contextWithDraft).toContain("existing message")
	})

	it("does not add empty commit input to the generation context", () => {
		const provider = createProvider()
		const gitContext = "diff --git a/src/file.ts b/src/file.ts"

		expect((provider as any).appendExistingCommitMessageDraft(gitContext, "   ")).toBe(gitContext)
	})

	it("asks before falling back to unstaged changes", async () => {
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("commitMessage.confirmUnstagedAction" as never)
		const provider = createProvider()
		const gitCollector = {
			gatherChanges: vi
				.fn()
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([{ filePath: "src/file.ts" }]),
		}

		const resolution = await (provider as any).resolveCommitChanges(gitCollector)

		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
			"commitMessage.useUnstagedConfirm",
			{ modal: true },
			"commitMessage.confirmUnstagedAction",
		)
		expect(gitCollector.gatherChanges).toHaveBeenNthCalledWith(1, { staged: true })
		expect(gitCollector.gatherChanges).toHaveBeenNthCalledWith(2, { staged: false })
		expect(resolution).toEqual({
			changes: [{ filePath: "src/file.ts" }],
			files: ["src/file.ts"],
			usedStaged: false,
		})
	})

	it("does not read unstaged changes when fallback is declined", async () => {
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined)
		const provider = createProvider()
		const gitCollector = {
			gatherChanges: vi.fn().mockResolvedValueOnce([]),
		}

		const resolution = await (provider as any).resolveCommitChanges(gitCollector)

		expect(gitCollector.gatherChanges).toHaveBeenCalledTimes(1)
		expect(resolution).toEqual({ changes: [], files: [], usedStaged: true })
	})

	it("uses the SCM resource URI as the workspace path when provided", () => {
		const provider = createProvider()

		expect((provider as any).determineWorkspacePath(vscode.Uri.file("/repo"))).toBe("/repo")
	})

	it("falls back to the workspace folder only when exactly one folder is open", () => {
		;(vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file("/single-root") }]
		const provider = createProvider()

		expect((provider as any).determineWorkspacePath()).toBe("/single-root")
	})

	it("fails clearly instead of guessing in multi-root workspaces", () => {
		;(vscode.workspace as any).workspaceFolders = [
			{ uri: vscode.Uri.file("/first-root") },
			{ uri: vscode.Uri.file("/second-root") },
		]
		const provider = createProvider()

		expect(() => (provider as any).determineWorkspacePath()).toThrow(
			"Run this command from a specific Git source control input in a multi-root workspace",
		)
	})
})
