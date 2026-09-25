import { ContextProxy } from "../../../core/config/ContextProxy"
import { makeExtensionContext, makeUri } from "../../../test-utils/vscode"
import { CodeIndexManager } from "../manager"
import { CodeIndexStateManager } from "../state-manager"
import { WorkspaceIndexingStartManager } from "../workspace-indexing-start-manager"

vi.mock("../manager")
vi.mock("../state-manager")

describe("WorkspaceIndexingStartManager", () => {
	function setup() {
		const manager = new CodeIndexManager(
			"/workspace",
			makeUri("/workspace"),
			makeExtensionContext(),
			new CodeIndexStateManager(),
		)
		vi.spyOn(manager, "isFeatureEnabled", "get").mockReturnValue(true)
		vi.spyOn(manager, "isFeatureConfigured", "get").mockReturnValue(true)
		vi.spyOn(manager, "isInitialized", "get").mockReturnValue(true)
		vi.spyOn(manager, "isWorkspaceEnabled", "get").mockReturnValue(true)
		vi.spyOn(manager, "state", "get").mockReturnValue("Standby")
		vi.mocked(manager.setWorkspaceEnabled).mockResolvedValue(undefined)
		vi.mocked(manager.initialize).mockResolvedValue({ requiresRestart: false })
		vi.mocked(manager.startIndexing).mockResolvedValue(undefined)
		const provider = { contextProxy: new ContextProxy(makeExtensionContext()), log: vi.fn() }
		return { manager, provider, starting: new WorkspaceIndexingStartManager(manager) }
	}

	it.each(["Standby", "Error"] as const)(
		"enables, initializes, and starts from %s without waiting",
		async (state) => {
			const { manager, provider, starting } = setup()
			vi.spyOn(manager, "state", "get").mockReturnValue(state)
			vi.mocked(manager.startIndexing).mockReturnValue(new Promise<void>(() => {}))
			await starting.startIndexing(provider)
			expect(manager.setWorkspaceEnabled).toHaveBeenCalledExactlyOnceWith(true)
			expect(manager.initialize).toHaveBeenCalledExactlyOnceWith(provider.contextProxy)
			expect(manager.startIndexing).toHaveBeenCalledOnce()
			expect(vi.mocked(manager.setWorkspaceEnabled).mock.invocationCallOrder[0]).toBeLessThan(
				vi.mocked(manager.initialize).mock.invocationCallOrder[0],
			)
			expect(vi.mocked(manager.initialize).mock.invocationCallOrder[0]).toBeLessThan(
				vi.mocked(manager.startIndexing).mock.invocationCallOrder[0],
			)
		},
	)

	it.each(["isFeatureEnabled", "isFeatureConfigured"] as const)("only enables when %s is false", async (key) => {
		const { manager, provider, starting } = setup()
		vi.spyOn(manager, key, "get").mockReturnValue(false)
		await starting.startIndexing(provider)
		expect(manager.setWorkspaceEnabled).toHaveBeenCalledWith(true)
		expect(manager.initialize).not.toHaveBeenCalled()
		expect(manager.startIndexing).not.toHaveBeenCalled()
	})

	it("checks state after initialization and does not start an active indexer", async () => {
		const { manager, provider, starting } = setup()
		vi.mocked(manager.initialize).mockImplementation(async () => {
			vi.spyOn(manager, "state", "get").mockReturnValue("Indexing")
			return { requiresRestart: false }
		})
		await starting.startIndexing(provider)
		expect(manager.initialize).toHaveBeenCalledOnce()
		expect(manager.startIndexing).not.toHaveBeenCalled()
	})

	it.each(["Standby", "Error", "Indexing"] as const)("rechecks %s after recovery initialization", async (state) => {
		const { manager, provider, starting } = setup()
		vi.spyOn(manager, "isInitialized", "get").mockReturnValue(false)
		vi.mocked(manager.initialize)
			.mockResolvedValueOnce({ requiresRestart: false })
			.mockImplementationOnce(async () => {
				vi.spyOn(manager, "state", "get").mockReturnValue(state)
				return { requiresRestart: false }
			})
		await starting.startIndexing(provider)
		expect(manager.initialize).toHaveBeenCalledTimes(2)
		expect(manager.startIndexing).toHaveBeenCalledTimes(state === "Indexing" ? 1 : 2)
	})

	it("logs background failures without blindly retrying a rejected start", async () => {
		const { manager, provider, starting } = setup()
		vi.spyOn(manager, "isInitialized", "get").mockReturnValue(false)
		vi.mocked(manager.startIndexing)
			.mockRejectedValueOnce(new Error("first"))
			.mockRejectedValueOnce(new Error("second"))
		await starting.startIndexing(provider)
		expect(provider.log).toHaveBeenCalledWith("Indexing error: Error: first")
		expect(manager.startIndexing).toHaveBeenCalledOnce()
	})

	it("starts an enabled workspace without writing an explicit override", async () => {
		const { manager, provider, starting } = setup()
		await starting.startEnabledWorkspace(provider)
		expect(manager.setWorkspaceEnabled).not.toHaveBeenCalled()
		expect(manager.startIndexing).toHaveBeenCalledOnce()
	})

	it.each([true, false])("waits for asynchronous recovery and respects workspace enablement: %s", async (enabled) => {
		const { manager, provider, starting } = setup()
		let finishRecovery = () => {}
		const recovery = new Promise<void>((resolve) => {
			finishRecovery = resolve
		})
		vi.mocked(manager.startIndexing).mockImplementationOnce(async () => {
			await recovery
			vi.spyOn(manager, "isInitialized", "get").mockReturnValue(false)
			vi.spyOn(manager, "isWorkspaceEnabled", "get").mockReturnValue(enabled)
		})
		await starting.startEnabledWorkspace(provider)
		expect(manager.initialize).toHaveBeenCalledOnce()
		expect(manager.startIndexing).toHaveBeenCalledOnce()
		finishRecovery()
		await vi.waitFor(() => expect(manager.initialize).toHaveBeenCalledTimes(enabled ? 2 : 1))
		await vi.waitFor(() => expect(manager.startIndexing).toHaveBeenCalledTimes(enabled ? 2 : 1))
		expect(manager.setWorkspaceEnabled).not.toHaveBeenCalled()
	})

	it("logs a failed recovery initialization", async () => {
		const { manager, provider, starting } = setup()
		vi.spyOn(manager, "isInitialized", "get").mockReturnValue(false)
		vi.mocked(manager.initialize)
			.mockResolvedValueOnce({ requiresRestart: false })
			.mockRejectedValueOnce(new Error("recovery failed"))
		await starting.startEnabledWorkspace(provider)
		await vi.waitFor(() => expect(provider.log).toHaveBeenCalledWith("Indexing error: Error: recovery failed"))
		expect(manager.startIndexing).toHaveBeenCalledOnce()
	})

	it.each(["setWorkspaceEnabled", "initialize"] as const)("propagates %s failures", async (method) => {
		const { manager, provider, starting } = setup()
		const error = new Error("failed")
		vi.mocked(manager[method]).mockRejectedValue(error)
		await expect(starting.startIndexing(provider)).rejects.toBe(error)
		expect(manager.startIndexing).not.toHaveBeenCalled()
	})
})
