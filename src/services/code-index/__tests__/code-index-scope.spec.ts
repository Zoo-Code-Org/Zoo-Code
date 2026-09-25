import { makeExtensionContext } from "../../../test-utils/vscode"
import { CodeIndexScope } from "../code-index-scope"
import { CodeIndexStatusManager } from "../code-index-status-manager"
import { CodeIndexManagerRegistry } from "../code-index-manager-registry"
import { CodeIndexSecretStatusManager } from "../code-index-secret-status-manager"

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

	it("shares the extension scope for the same context", () => {
		const context = makeExtensionContext()
		const scope = CodeIndexScope.getOrCreate(context)
		expect(CodeIndexScope.getOrCreate(context)).toBe(scope)
		expect(CodeIndexScope.getOrCreate(makeExtensionContext())).not.toBe(scope)
	})

	it("guards generic values and preserves defined falsy values", () => {
		const scope = new CodeIndexScope(makeExtensionContext())
		expect(() => scope["ensureInitialized"](42)).toThrow("Code index scope is not initialized")
		scope.init()
		expect(() => scope["ensureInitialized"](undefined)).toThrow("Code index scope is not initialized")
		expect(scope["ensureInitialized"](false)).toBe(false)
		expect(scope["ensureInitialized"](0)).toBe(0)
		expect(scope["ensureInitialized"]("")).toBe("")
		scope.dispose()
		expect(() => scope["ensureInitialized"](42)).toThrow("Code index scope is not initialized")
	})

	it("owns a guarded secret-status manager independently of workspace managers", async () => {
		const context = makeExtensionContext()
		vi.spyOn(context.secrets, "get").mockResolvedValue("test-secret")
		const scope = CodeIndexScope.getOrCreate(context)
		expect(() => scope.secretStatusManager).toThrow("not initialized")
		scope.init()
		const manager = scope.secretStatusManager
		expect(manager).toBeInstanceOf(CodeIndexSecretStatusManager)
		expect(scope.secretStatusManager).toBe(manager)
		const provider = { postMessageToWebview: vi.fn().mockResolvedValue(undefined) }
		await manager.postStatus(provider)
		expect(context.secrets.get).toHaveBeenCalledTimes(7)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "codeIndexSecretStatus",
			values: expect.objectContaining({ hasOpenAiKey: true, hasOpenRouterApiKey: true }),
		})
		expect(CodeIndexManagerRegistry.getOrCreate).not.toHaveBeenCalled()
		scope.dispose()
		expect(() => scope.secretStatusManager).toThrow("not initialized")
		scope.init()
		expect(scope.secretStatusManager).not.toBe(manager)
		scope.dispose()
	})
})
