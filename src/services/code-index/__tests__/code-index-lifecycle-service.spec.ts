import * as vscode from "vscode"

import type { ContextProxy } from "../../../core/config/ContextProxy"
import { makeExtensionContext } from "../../../test-utils/vscode"
import { codeIndexScopeRegistry } from "../code-index-scope-registry"
import { CodeIndexDisposalError } from "../errors/code-index-disposal-error"
import { CodeIndexLifecycleService } from "../code-index-lifecycle-service"

vi.mock("vscode", () => ({
	workspace: {
		workspaceFolders: [],
	},
}))

vi.mock("../code-index-scope-registry", () => ({
	codeIndexScopeRegistry: {
		getScope: vi.fn(),
		disposeAll: vi.fn(),
	},
}))

describe("CodeIndexLifecycleService", () => {
	const context = makeExtensionContext()
	const contextProxy = {} as ContextProxy
	const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(vscode.workspace).workspaceFolders = []
	})

	it("initializes a scope for every workspace folder in the background", async () => {
		const init = vi.fn().mockResolvedValue(undefined)
		const folders = ["/workspace/one", "/workspace/two"].map((fsPath, index) => ({
			uri: { fsPath },
			name: `workspace-${index}`,
			index,
		})) as vscode.WorkspaceFolder[]
		vi.mocked(vscode.workspace).workspaceFolders = folders
		vi.mocked(codeIndexScopeRegistry.getScope).mockReturnValue({ init } as never)

		await new CodeIndexLifecycleService(context, contextProxy, outputChannel).init()

		expect(codeIndexScopeRegistry.getScope).toHaveBeenNthCalledWith(1, context, "/workspace/one")
		expect(codeIndexScopeRegistry.getScope).toHaveBeenNthCalledWith(2, context, "/workspace/two")
		expect(init).toHaveBeenCalledTimes(2)
		expect(init).toHaveBeenCalledWith(contextProxy)
	})

	it("logs background initialization failures", async () => {
		vi.mocked(vscode.workspace).workspaceFolders = [
			{ uri: { fsPath: "/workspace/failing" }, name: "failing", index: 0 },
		] as vscode.WorkspaceFolder[]
		vi.mocked(codeIndexScopeRegistry.getScope).mockReturnValue({
			init: vi.fn().mockRejectedValue(new Error("configuration failed")),
		} as never)

		await new CodeIndexLifecycleService(context, contextProxy, outputChannel).init()

		expect(outputChannel.appendLine).toHaveBeenCalledWith(
			"[CodeIndexManager] Error during background CodeIndexManager configuration/indexing for /workspace/failing: configuration failed",
		)
	})

	it("disposes the registry only once", async () => {
		const service = new CodeIndexLifecycleService(context, contextProxy, outputChannel)

		await service.dispose()
		await service.dispose()

		expect(codeIndexScopeRegistry.disposeAll).toHaveBeenCalledTimes(1)
	})

	it("logs aggregate disposal failures", async () => {
		vi.mocked(codeIndexScopeRegistry.disposeAll).mockImplementationOnce(() => {
			throw new CodeIndexDisposalError([new Error("index cleanup failed")])
		})

		await new CodeIndexLifecycleService(context, contextProxy, outputChannel).dispose()

		expect(outputChannel.appendLine).toHaveBeenCalledWith(
			"CodeIndexDisposalError: Failed to dispose code index managers (1 errors):\n1. index cleanup failed",
		)
	})

	it("labels unexpected disposal failures", async () => {
		vi.mocked(codeIndexScopeRegistry.disposeAll).mockImplementationOnce(() => {
			throw new Error("unexpected cleanup failure")
		})

		await new CodeIndexLifecycleService(context, contextProxy, outputChannel).dispose()

		expect(outputChannel.appendLine).toHaveBeenCalledWith(
			"Unexpected error while disposing code index managers: unexpected cleanup failure",
		)
	})
})
