import * as vscode from "vscode"

import type { ContextProxy } from "../../../core/config/ContextProxy"
import { makeExtensionContext } from "../../../test-utils/vscode"
import { CodeIndexWorkspaceScopeRegistry } from "../code-index-workspace-scope-registry"
import { CodeIndexDisposalError } from "../errors/code-index-disposal-error"
import { CodeIndexScope } from "../code-index-scope"

vi.mock("vscode", () => ({
	workspace: {
		workspaceFolders: [],
	},
}))

vi.mock("../code-index-workspace-scope-registry", () => ({
	CodeIndexWorkspaceScopeRegistry: vi.fn().mockImplementation(function () {
		return { getScope: vi.fn(), disposeAll: vi.fn() }
	}),
}))
vi.mock("../code-index-status-manager", () => ({
	CodeIndexStatusManager: vi.fn().mockImplementation(function () {
		return { init: vi.fn(), dispose: vi.fn() }
	}),
}))

describe("CodeIndexScope", () => {
	const context = makeExtensionContext()
	const contextProxy = {} as ContextProxy
	const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
	let service: CodeIndexScope
	let codeIndexWorkspaceScopeRegistry: CodeIndexWorkspaceScopeRegistry
	const createService = () => service

	beforeEach(() => {
		vi.clearAllMocks()
		service = new CodeIndexScope(context, contextProxy, outputChannel)
		codeIndexWorkspaceScopeRegistry = service.workspaceRegistry
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
		vi.mocked(codeIndexWorkspaceScopeRegistry.getScope).mockReturnValue({ init } as never)

		await createService().init()

		expect(codeIndexWorkspaceScopeRegistry.getScope).toHaveBeenNthCalledWith(1, context, "/workspace/one")
		expect(codeIndexWorkspaceScopeRegistry.getScope).toHaveBeenNthCalledWith(2, context, "/workspace/two")
		expect(init).toHaveBeenCalledTimes(2)
		expect(init).toHaveBeenCalledWith(contextProxy)
	})

	it("logs background initialization failures", async () => {
		vi.mocked(vscode.workspace).workspaceFolders = [
			{ uri: { fsPath: "/workspace/failing" }, name: "failing", index: 0 },
		] as vscode.WorkspaceFolder[]
		vi.mocked(codeIndexWorkspaceScopeRegistry.getScope).mockReturnValue({
			init: vi.fn().mockRejectedValue(new Error("configuration failed")),
		} as never)

		await createService().init()

		expect(outputChannel.appendLine).toHaveBeenCalledWith(
			"[CodeIndexManager] Error during background CodeIndexManager configuration/indexing for /workspace/failing: configuration failed",
		)
	})

	it("disposes status subscriptions before workspace resources", async () => {
		const service = createService()
		await service.init()
		vi.mocked(codeIndexWorkspaceScopeRegistry.disposeAll).mockImplementation(async () => {
			expect(service.statusManager.dispose).toHaveBeenCalledOnce()
		})
		await service.dispose()

		expect(codeIndexWorkspaceScopeRegistry.disposeAll).toHaveBeenCalledTimes(1)
	})

	it("starts status subscriptions only after workspace initialization settles", async () => {
		vi.mocked(vscode.workspace).workspaceFolders = [
			{ uri: { fsPath: "/workspace" }, name: "workspace", index: 0 },
		] as vscode.WorkspaceFolder[]
		const init = vi.fn(async () => {
			expect(service.statusManager.init).not.toHaveBeenCalled()
			await Promise.resolve()
			expect(service.statusManager.init).not.toHaveBeenCalled()
		})
		vi.mocked(codeIndexWorkspaceScopeRegistry.getScope).mockReturnValue({ init } as never)
		await service.init()
		expect(service.statusManager.init).toHaveBeenCalledOnce()
	})

	it("logs aggregate disposal failures", async () => {
		vi.mocked(codeIndexWorkspaceScopeRegistry.disposeAll).mockImplementationOnce(() => {
			throw new CodeIndexDisposalError([new Error("index cleanup failed")])
		})

		await createService().dispose()

		expect(outputChannel.appendLine).toHaveBeenCalledWith(
			"CodeIndexDisposalError: Failed to dispose code index managers (1 errors):\n1. index cleanup failed",
		)
	})

	it("labels unexpected disposal failures", async () => {
		vi.mocked(codeIndexWorkspaceScopeRegistry.disposeAll).mockImplementationOnce(() => {
			throw new Error("unexpected cleanup failure")
		})

		await createService().dispose()

		expect(outputChannel.appendLine).toHaveBeenCalledWith(
			"Unexpected error while disposing code index managers: unexpected cleanup failure",
		)
	})
})
