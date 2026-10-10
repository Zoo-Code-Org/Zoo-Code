import { makeExtensionContext, makeUri } from "../../../test-utils/vscode"
import { CodeIndexManager } from "../manager"
import { CodeIndexWorkspaceScope } from "../code-index-workspace-scope"
import { CodeIndexStateManager } from "../state-manager"
import { WorkspaceIndexingEnablementManager } from "../workspace-indexing-enablement-manager"
import { WorkspaceIndexingSettingsManager } from "../workspace-indexing-settings-manager"

vi.mock("../state-manager")

vi.mock("../manager", () => ({
	CodeIndexManager: vi.fn().mockImplementation(function () {
		return { initialize: vi.fn(), dispose: vi.fn() }
	}),
}))

describe("CodeIndexWorkspaceScope", () => {
	beforeEach(() => vi.clearAllMocks())

	it("uses guarded getters to construct dependent managers during initialization", () => {
		const scope = new CodeIndexWorkspaceScope("/workspace", makeUri("/workspace"), makeExtensionContext())
		const getter = vi.spyOn(scope, "codeIndexManager", "get")
		scope.init()
		expect(getter).toHaveBeenCalledTimes(2)
		expect(scope.workspaceIndexingSettingsManager["manager"]).toBe(scope.codeIndexManager)
	})

	it("owns a guarded settings manager and recreates it after disposal", () => {
		const scope = new CodeIndexWorkspaceScope("/workspace", makeUri("/workspace"), makeExtensionContext())
		expect(() => scope.workspaceIndexingSettingsManager).toThrow("not initialized")
		scope.init()
		const settings = scope.workspaceIndexingSettingsManager
		expect(settings).toBeInstanceOf(WorkspaceIndexingSettingsManager)
		expect(settings["manager"]).toBe(scope.codeIndexManager)
		scope.dispose()
		expect(() => scope.workspaceIndexingSettingsManager).toThrow("not initialized")
		scope.init()
		expect(scope.workspaceIndexingSettingsManager).not.toBe(settings)
	})

	it("owns a guarded workspace indexing manager and recreates it after disposal", () => {
		const scope = new CodeIndexWorkspaceScope("/workspace", makeUri("/workspace"), makeExtensionContext())
		expect(() => scope.workspaceIndexingEnablementManager).toThrow("not initialized")
		scope.init()
		const indexing = scope.workspaceIndexingEnablementManager
		expect(indexing).toBeInstanceOf(WorkspaceIndexingEnablementManager)
		expect(indexing["manager"]).toBe(scope.codeIndexManager)
		scope.dispose()
		expect(() => scope.workspaceIndexingEnablementManager).toThrow("not initialized")
		scope.init()
		expect(scope.workspaceIndexingEnablementManager).not.toBe(indexing)
	})

	it("guards generic values and preserves defined falsy values", () => {
		const scope = new CodeIndexWorkspaceScope("/workspace", makeUri("/workspace"), makeExtensionContext())
		expect(() => scope["ensureInitialized"](42)).toThrow("Code index workspace scope is not initialized")
		scope.init()
		expect(() => scope["ensureInitialized"](undefined)).toThrow("Code index workspace scope is not initialized")
		expect(scope["ensureInitialized"](false)).toBe(false)
		expect(scope["ensureInitialized"](0)).toBe(0)
		expect(scope["ensureInitialized"]("")).toBe("")
	})

	it("creates its manager only on init without starting configuration initialization", () => {
		const context = makeExtensionContext()
		const uri = makeUri("/workspace")
		const scope = new CodeIndexWorkspaceScope(uri.fsPath, uri, context)

		expect(CodeIndexManager).not.toHaveBeenCalled()
		expect(CodeIndexStateManager).not.toHaveBeenCalled()
		expect(scope["_stateManager"]).toBeUndefined()
		expect(() => scope.codeIndexManager).toThrow("Code index workspace scope is not initialized")
		expect(scope.init()).toBeUndefined()
		const manager = scope.codeIndexManager

		expect(CodeIndexStateManager).toHaveBeenCalledExactlyOnceWith()
		expect(scope["_stateManager"]).toBe(vi.mocked(CodeIndexStateManager).mock.instances[0])
		expect(CodeIndexManager).toHaveBeenCalledExactlyOnceWith(
			uri.fsPath,
			uri,
			context,
			vi.mocked(CodeIndexStateManager).mock.instances[0],
		)
		expect(scope.codeIndexManager).toBe(manager)
		expect(() => scope.init()).toThrow("Code index workspace scope is already initialized")
		expect(scope.codeIndexManager).toBe(manager)
		expect(CodeIndexManager).toHaveBeenCalledTimes(1)
		expect(manager.initialize).not.toHaveBeenCalled()
	})

	it("synchronously disposes its manager", () => {
		const scope = new CodeIndexWorkspaceScope("/workspace", makeUri("/workspace"), makeExtensionContext())
		scope.init()
		const manager = scope.codeIndexManager

		expect(scope.dispose()).toBeUndefined()
		expect(scope["_stateManager"]).toBeUndefined()
		expect(() => scope.codeIndexManager).toThrow("Code index workspace scope is not initialized")
		scope.dispose()
		expect(manager.dispose).toHaveBeenCalledExactlyOnceWith()
	})

	it("can dispose before dependency creation without constructing a manager", () => {
		const scope = new CodeIndexWorkspaceScope("/workspace", makeUri("/workspace"), makeExtensionContext())
		scope.dispose()
		expect(() => scope.codeIndexManager).toThrow("Code index workspace scope is not initialized")
		expect(CodeIndexManager).not.toHaveBeenCalled()
	})

	it("creates a fresh manager when initialized after disposal", () => {
		const scope = new CodeIndexWorkspaceScope("/workspace", makeUri("/workspace"), makeExtensionContext())
		scope.init()
		const previous = scope.codeIndexManager
		scope.dispose()
		scope.init()
		const current = scope.codeIndexManager
		expect(current).not.toBe(previous)
		expect(scope.codeIndexManager).toBe(current)
		expect(CodeIndexManager).toHaveBeenCalledTimes(2)
		expect(current.dispose).not.toHaveBeenCalled()
		const calls = vi.mocked(CodeIndexManager).mock.calls
		expect(CodeIndexStateManager).toHaveBeenCalledTimes(2)
		expect(calls[1][3]).not.toBe(calls[0][3])
		expect(scope["_stateManager"]).toBe(calls[1][3])
	})

	it("creates separate state managers for different workspace scopes", () => {
		const context = makeExtensionContext()
		const first = new CodeIndexWorkspaceScope("/first", makeUri("/first"), context)
		const second = new CodeIndexWorkspaceScope("/second", makeUri("/second"), context)
		first.init()
		second.init()

		const calls = vi.mocked(CodeIndexManager).mock.calls
		expect(CodeIndexStateManager).toHaveBeenCalledTimes(2)
		expect(calls[0][3]).toBe(vi.mocked(CodeIndexStateManager).mock.instances[0])
		expect(calls[1][3]).toBe(vi.mocked(CodeIndexStateManager).mock.instances[1])
		expect(calls[1][3]).not.toBe(calls[0][3])
	})

	it("clears its reference even when manager disposal throws", () => {
		const scope = new CodeIndexWorkspaceScope("/workspace", makeUri("/workspace"), makeExtensionContext())
		scope.init()
		const manager = scope.codeIndexManager
		const error = new Error("disposal failed")
		vi.mocked(manager.dispose).mockImplementationOnce(() => {
			throw error
		})
		expect(() => scope.dispose()).toThrow(error)
		expect(scope["_stateManager"]).toBeUndefined()
		expect(() => scope.codeIndexManager).toThrow("Code index workspace scope is not initialized")
		scope.dispose()
		expect(manager.dispose).toHaveBeenCalledTimes(1)
	})

	it("remains uninitialized when construction fails and permits retry", () => {
		const scope = new CodeIndexWorkspaceScope("/workspace", makeUri("/workspace"), makeExtensionContext())
		const error = new Error("construction failed")
		vi.mocked(CodeIndexManager).mockImplementationOnce(function () {
			throw error
		})

		expect(() => scope.init()).toThrow(error)
		expect(() => scope.codeIndexManager).toThrow("Code index workspace scope is not initialized")
		expect(scope.init()).toBeUndefined()
		expect(scope.codeIndexManager).toBe(vi.mocked(CodeIndexManager).mock.results[1].value)
		expect(CodeIndexManager).toHaveBeenCalledTimes(2)
	})
})
