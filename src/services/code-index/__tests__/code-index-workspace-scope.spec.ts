import { ContextProxy } from "../../../core/config/ContextProxy"
import { makeExtensionContext, makeUri } from "../../../test-utils/vscode"
import { CodeIndexManager } from "../manager"
import { CodeIndexWorkspaceScope } from "../code-index-workspace-scope"

vi.mock("../manager", () => ({
	CodeIndexManager: vi.fn().mockImplementation(function () {
		return { initialize: vi.fn().mockResolvedValue({ requiresRestart: false }), dispose: vi.fn() }
	}),
}))

describe("CodeIndexWorkspaceScope", () => {
	beforeEach(() => vi.clearAllMocks())

	it("owns, initializes and disposes its manager", async () => {
		const context = makeExtensionContext()
		const uri = makeUri("/workspace")
		const contextProxy = {} as ContextProxy
		const scope = new CodeIndexWorkspaceScope(uri.fsPath, uri, context)

		expect(CodeIndexManager).toHaveBeenCalledExactlyOnceWith(uri.fsPath, uri, context)
		await expect(scope.initialize(contextProxy)).resolves.toEqual({ requiresRestart: false })
		expect(scope.codeIndexManager.initialize).toHaveBeenCalledExactlyOnceWith(contextProxy)

		scope.dispose()
		expect(scope.codeIndexManager.dispose).toHaveBeenCalledExactlyOnceWith()
	})

	it.each([true, false])("propagates requiresRestart=%s unchanged", async (requiresRestart) => {
		const uri = makeUri("/workspace")
		const scope = new CodeIndexWorkspaceScope(uri.fsPath, uri, makeExtensionContext())
		const result = { requiresRestart }
		vi.mocked(scope.codeIndexManager.initialize).mockResolvedValueOnce(result)

		await expect(scope.initialize({} as ContextProxy)).resolves.toBe(result)
	})

	it("propagates initialization rejection without taking over consumer cleanup", async () => {
		const uri = makeUri("/workspace")
		const scope = new CodeIndexWorkspaceScope(uri.fsPath, uri, makeExtensionContext())
		const error = new Error("initialization failed")
		vi.mocked(scope.codeIndexManager.initialize).mockRejectedValueOnce(error)

		await expect(scope.initialize({} as ContextProxy)).rejects.toBe(error)
		expect(scope.codeIndexManager.dispose).not.toHaveBeenCalled()
		scope.dispose()
		expect(scope.codeIndexManager.dispose).toHaveBeenCalledExactlyOnceWith()
	})

	it("propagates disposal errors to its owner", () => {
		const uri = makeUri("/workspace")
		const scope = new CodeIndexWorkspaceScope(uri.fsPath, uri, makeExtensionContext())
		const error = new Error("disposal failed")
		vi.mocked(scope.codeIndexManager.dispose).mockImplementationOnce(() => {
			throw error
		})

		expect(() => scope.dispose()).toThrow(error)
		expect(scope.codeIndexManager.dispose).toHaveBeenCalledExactlyOnceWith()
	})
})
