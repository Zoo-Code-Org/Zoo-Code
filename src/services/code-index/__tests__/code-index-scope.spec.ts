import { makeExtensionContext, makeUri } from "../../../test-utils/vscode"
import type { ContextProxy } from "../../../core/config/ContextProxy"
import { CodeIndexManager } from "../manager"
import { CodeIndexScope } from "../code-index-scope"
import { CodeIndexStateManager } from "../state-manager"

vi.mock("../state-manager", () => ({
	CodeIndexStateManager: vi.fn().mockImplementation(function () {
		return { init: vi.fn(), dispose: vi.fn() }
	}),
}))

vi.mock("../manager", () => ({
	CodeIndexManager: vi.fn().mockImplementation(function () {
		return { initialize: vi.fn(), dispose: vi.fn().mockResolvedValue(undefined) }
	}),
}))

describe("CodeIndexScope", () => {
	beforeEach(() => vi.clearAllMocks())

	function createScope() {
		const context = makeExtensionContext()
		const uri = makeUri("/workspace")
		const scope = new CodeIndexScope(uri.fsPath, uri, context)
		return { scope, context, uri }
	}

	function getManager(scope: CodeIndexScope) {
		return scope.codeIndexManager
	}

	it("creates and injects dependencies in the constructor without loading manager configuration", () => {
		const { scope, context, uri } = createScope()
		expect(CodeIndexStateManager).toHaveBeenCalledExactlyOnceWith()
		const codeIndexStateManager = vi.mocked(CodeIndexStateManager).mock.results[0].value
		expect(codeIndexStateManager.init).not.toHaveBeenCalled()
		expect(CodeIndexManager).toHaveBeenCalledExactlyOnceWith(uri.fsPath, uri, context, codeIndexStateManager)
		expect(scope.codeIndexManager).toBe(vi.mocked(CodeIndexManager).mock.results[0].value)
		expect(getManager(scope).initialize).not.toHaveBeenCalled()
	})

	it("creates a separate state manager for each scope", () => {
		createScope()
		createScope()
		const calls = vi.mocked(CodeIndexManager).mock.calls
		expect(CodeIndexStateManager).toHaveBeenCalledTimes(2)
		expect(calls[0][3]).not.toBe(calls[1][3])
	})

	it("initializes its manager", async () => {
		const { scope } = createScope()
		const manager = getManager(scope)
		const contextProxy = {} as ContextProxy

		await scope.init(contextProxy)

		expect(vi.mocked(CodeIndexStateManager).mock.results[0].value.init).toHaveBeenCalledExactlyOnceWith()
		expect(manager.initialize).toHaveBeenCalledExactlyOnceWith(contextProxy)
	})

	it("disposes its resources", async () => {
		const { scope } = createScope()
		const codeIndexManager = getManager(scope)
		const stateManager = vi.mocked(CodeIndexStateManager).mock.results[0].value
		await scope.dispose()
		expect(codeIndexManager.dispose).toHaveBeenCalledExactlyOnceWith()
		expect(stateManager.dispose).toHaveBeenCalledExactlyOnceWith()
	})

	it("continues disposing resources when a disposal rejects", async () => {
		const { scope } = createScope()
		const codeIndexManager = getManager(scope)
		const stateManager = vi.mocked(CodeIndexStateManager).mock.results[0].value
		const error = new Error("disposal failed")
		vi.mocked(codeIndexManager.dispose).mockRejectedValue(error)

		let caught: unknown
		try {
			await scope.dispose()
		} catch (error) {
			caught = error
		}

		expect(caught).toBeInstanceOf(AggregateError)
		expect((caught as AggregateError).errors).toEqual([error])
		expect(codeIndexManager.dispose).toHaveBeenCalledOnce()
		expect(stateManager.dispose).toHaveBeenCalledOnce()
	})
})
