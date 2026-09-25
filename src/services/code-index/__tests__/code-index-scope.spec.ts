import { makeExtensionContext } from "../../../test-utils/vscode"
import { CodeIndexScope } from "../code-index-scope"
import { CodeIndexStatusManager } from "../code-index-status-manager"
import { CodeIndexManagerRegistry } from "../code-index-manager-registry"

vi.mock("../code-index-status-manager")
vi.mock("../code-index-manager-registry", () => ({
	CodeIndexManagerRegistry: { getOrCreate: vi.fn() },
}))

describe("CodeIndexScope", () => {
	beforeEach(() => vi.clearAllMocks())

	it("creates, initializes and disposes its status manager", () => {
		const context = makeExtensionContext()
		const scope = new CodeIndexScope(context)
		expect(scope["_isInitialized"]).toBe(false)
		expect(CodeIndexStatusManager).not.toHaveBeenCalled()
		scope.init()
		expect(scope["_isInitialized"]).toBe(true)
		const manager = vi.mocked(CodeIndexStatusManager).mock.instances[0]
		const [resolve] = vi.mocked(CodeIndexStatusManager).mock.calls[0]
		resolve("/first")
		expect(CodeIndexManagerRegistry.getOrCreate).toHaveBeenCalledExactlyOnceWith(context, "/first")
		expect(manager.init).toHaveBeenCalledExactlyOnceWith()
		expect(() => scope.init()).toThrow("already initialized")
		scope.dispose()
		expect(scope["_isInitialized"]).toBe(false)
		scope.dispose()
		expect(manager.dispose).toHaveBeenCalledExactlyOnceWith()
		scope.init()
		expect(CodeIndexStatusManager).toHaveBeenCalledTimes(2)
		scope.dispose()
	})

	it("can dispose before initialization and retry failed initialization", () => {
		const scope = new CodeIndexScope(makeExtensionContext())
		scope.dispose()
		expect(CodeIndexStatusManager).not.toHaveBeenCalled()
		vi.mocked(CodeIndexStatusManager.prototype.init).mockImplementationOnce(() => {
			throw new Error("init failed")
		})
		expect(() => scope.init()).toThrow("init failed")
		expect(scope["_isInitialized"]).toBe(false)
		expect(() => scope.init()).not.toThrow()
		expect(scope["_isInitialized"]).toBe(true)
		scope.dispose()
	})
})
