import * as vscode from "vscode"

import { CodebaseSearchTool } from "../CodebaseSearchTool"
import { CodeIndexManager } from "../../../services/code-index/manager"

vi.mock("vscode", () => ({
	workspace: {
		asRelativePath: vi.fn((filePath: string) => filePath.replace("/workspace/", "")),
	},
}))

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: vi.fn(),
	},
}))

describe("CodebaseSearchTool", () => {
	it("records self-improving code index hit details from search results", async () => {
		const recordCodeIndexEvent = vi.fn().mockResolvedValue(undefined)
		const getSelfImprovingManager = vi.fn().mockReturnValue({ recordCodeIndexEvent })
		const searchIndex = vi.fn().mockResolvedValue([
			{
				payload: {
					filePath: "/workspace/src/example.ts",
					startLine: 10,
					endLine: 20,
					codeChunk: "const answer = 42",
				},
				score: 0.87,
			},
		])
		vi.mocked(CodeIndexManager.getInstance).mockReturnValue({
			isFeatureEnabled: true,
			isFeatureConfigured: true,
			searchIndex,
		} as any)

		const task = {
			cwd: "/workspace",
			taskId: "task-1",
			consecutiveMistakeCount: 0,
			providerRef: {
				deref: vi.fn().mockReturnValue({
					context: {},
					getSelfImprovingManager,
				}),
			},
			say: vi.fn().mockResolvedValue(undefined),
		} as any
		const callbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn().mockResolvedValue(undefined),
			pushToolResult: vi.fn(),
		}

		const tool = new CodebaseSearchTool()
		await tool.execute({ query: "find the answer" }, task, callbacks)

		expect(recordCodeIndexEvent).toHaveBeenCalledWith("task-1", {
			available: true,
			hits: 1,
			topScore: 0.87,
		})
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(vscode.workspace.asRelativePath).toHaveBeenCalledWith("/workspace/src/example.ts", false)
	})
})
