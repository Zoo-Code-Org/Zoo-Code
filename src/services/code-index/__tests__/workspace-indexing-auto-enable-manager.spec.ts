import { ContextProxy } from "../../../core/config/ContextProxy"
import { makeExtensionContext, makeUri } from "../../../test-utils/vscode"
import { CodeIndexManager } from "../manager"
import { CodeIndexStateManager } from "../state-manager"
import { WorkspaceIndexingAutoEnableManager } from "../workspace-indexing-auto-enable-manager"
import { WorkspaceIndexingStartManager } from "../workspace-indexing-start-manager"
import { CodeIndexManagerRegistry } from "../code-index-manager-registry"
import { CodeIndexWorkspaceScope } from "../code-index-workspace-scope"

vi.mock("../state-manager")

describe("WorkspaceIndexingAutoEnableManager", () => {
	afterEach(() => vi.restoreAllMocks())

	function setup(states: boolean[] = [false, false]) {
		const managers = states.map((isWorkspaceEnabled, index) => {
			const workspacePath = `/workspace-${index}`
			const workspace = new CodeIndexManager(
				workspacePath,
				makeUri(workspacePath),
				makeExtensionContext(),
				new CodeIndexStateManager(),
			)
			Object.defineProperties(workspace, {
				isWorkspaceEnabled: { value: isWorkspaceEnabled, writable: true },
				isFeatureEnabled: { value: true, writable: true },
				isFeatureConfigured: { value: true, writable: true },
				isInitialized: { value: true, writable: true },
				state: { value: "Standby", writable: true },
			})
			return Object.assign(workspace, {
				initialize: vi.fn().mockResolvedValue({ requiresRestart: false }),
				startIndexing: vi.fn().mockResolvedValue(undefined),
				stopIndexing: vi.fn(),
				setWorkspaceEnabled: vi.fn().mockResolvedValue(undefined),
			})
		})
		const manager = {
			setAutoEnableDefault: vi.fn(async (enabled: boolean) => {
				for (const workspace of managers)
					Object.defineProperty(workspace, "isWorkspaceEnabled", { value: enabled })
			}),
			getCurrentStatus: vi.fn<CodeIndexManager["getCurrentStatus"]>().mockReturnValue({
				systemStatus: "Standby",
				message: "Ready",
				processedItems: 0,
				totalItems: 0,
				currentItemUnit: "blocks",
				workspacePath: "/workspace",
				workspaceEnabled: true,
				autoEnableDefault: true,
			}),
		}
		const provider = {
			contextProxy: new ContextProxy(makeExtensionContext()),
			log: vi.fn(),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		}
		const scopes = managers.map((codeIndexManager, index) => {
			const path = `/workspace-${index}`
			const scope = new CodeIndexWorkspaceScope(path, makeUri(path), makeExtensionContext())
			vi.spyOn(scope, "codeIndexManager", "get").mockReturnValue(codeIndexManager)
			vi.spyOn(scope, "workspaceIndexingStartManager", "get").mockReturnValue(
				new WorkspaceIndexingStartManager(codeIndexManager),
			)
			return scope
		})
		vi.spyOn(CodeIndexManagerRegistry, "getAllScopes").mockReturnValue(scopes)
		return {
			managers,
			manager,
			provider,
			indexing: new WorkspaceIndexingAutoEnableManager(manager),
		}
	}

	it("starts all newly enabled workspaces after persistence without awaiting indexing", async () => {
		const { managers, manager, provider, indexing } = setup()
		managers[0].startIndexing.mockReturnValue(new Promise<void>(() => {}))
		await indexing.setAutoEnableDefault(true, provider)
		expect(manager.setAutoEnableDefault).toHaveBeenCalledExactlyOnceWith(true)
		for (const workspace of managers) {
			expect(workspace.initialize).toHaveBeenCalledExactlyOnceWith(provider.contextProxy)
			expect(workspace.startIndexing).toHaveBeenCalledOnce()
			expect(manager.setAutoEnableDefault.mock.invocationCallOrder[0]).toBeLessThan(
				workspace.initialize.mock.invocationCallOrder[0],
			)
			expect(workspace.initialize.mock.invocationCallOrder[0]).toBeLessThan(
				workspace.startIndexing.mock.invocationCallOrder[0],
			)
			expect(workspace.stopIndexing).not.toHaveBeenCalled()
			expect(workspace.setWorkspaceEnabled).not.toHaveBeenCalled()
		}
		expect(provider.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "indexingStatusUpdate",
			values: manager.getCurrentStatus(),
		})
	})

	it("stops only newly disabled workspaces", async () => {
		const { managers, manager, provider, indexing } = setup([true, false])
		await indexing.setAutoEnableDefault(false, provider)
		expect(manager.setAutoEnableDefault).toHaveBeenCalledExactlyOnceWith(false)
		expect(managers[0].stopIndexing).toHaveBeenCalledOnce()
		expect(managers[1].stopIndexing).not.toHaveBeenCalled()
		for (const workspace of managers) expect(workspace.initialize).not.toHaveBeenCalled()
	})

	it("leaves workspace overrides unchanged", async () => {
		const { managers, manager, provider, indexing } = setup([true, false])
		manager.setAutoEnableDefault.mockImplementation(async () => {})
		await indexing.setAutoEnableDefault(true, provider)
		for (const workspace of managers) {
			expect(workspace.initialize).not.toHaveBeenCalled()
			expect(workspace.startIndexing).not.toHaveBeenCalled()
			expect(workspace.stopIndexing).not.toHaveBeenCalled()
		}
	})

	it.each(["isFeatureEnabled", "isFeatureConfigured"] as const)("does not start when %s is false", async (key) => {
		const { managers, provider, indexing } = setup([false])
		Object.defineProperty(managers[0], key, { value: false })
		await indexing.setAutoEnableDefault(true, provider)
		expect(managers[0].initialize).not.toHaveBeenCalled()
		expect(managers[0].startIndexing).not.toHaveBeenCalled()
	})

	it("logs background failures and continues with other workspaces", async () => {
		const { managers, provider, indexing } = setup()
		managers[0].startIndexing.mockRejectedValue(new Error("failed"))
		await indexing.setAutoEnableDefault(true, provider)
		expect(provider.log).toHaveBeenCalledWith("Indexing error: Error: failed")
		expect(managers[1].startIndexing).toHaveBeenCalledOnce()
		expect(provider.postMessageToWebview).toHaveBeenCalledOnce()
	})

	it("uses shared recovery without persisting workspace overrides", async () => {
		const { managers, provider, indexing } = setup([false])
		Object.defineProperty(managers[0], "isInitialized", { value: false })
		await indexing.setAutoEnableDefault(true, provider)
		await vi.waitFor(() => expect(managers[0].startIndexing).toHaveBeenCalledTimes(2))
		expect(managers[0].initialize).toHaveBeenCalledTimes(2)
		expect(managers[0].setWorkspaceEnabled).not.toHaveBeenCalled()
	})

	it.each(["Indexing", "Indexed", "Stopping"])("does not start a workspace in %s state", async (state) => {
		const { managers, provider, indexing } = setup([false])
		Object.defineProperty(managers[0], "state", { value: state })
		await indexing.setAutoEnableDefault(true, provider)
		expect(managers[0].startIndexing).not.toHaveBeenCalled()
	})

	it("propagates persistence failures without starting or publishing", async () => {
		const { managers, manager, provider, indexing } = setup()
		manager.setAutoEnableDefault.mockRejectedValue(new Error("persistence failed"))
		await expect(indexing.setAutoEnableDefault(true, provider)).rejects.toThrow("persistence failed")
		for (const workspace of managers) expect(workspace.initialize).not.toHaveBeenCalled()
		expect(provider.postMessageToWebview).not.toHaveBeenCalled()
	})
})
