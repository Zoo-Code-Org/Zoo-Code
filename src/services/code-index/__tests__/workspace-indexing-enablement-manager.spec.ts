import type { CodeIndexManager } from "../manager"
import { ContextProxy } from "../../../core/config/ContextProxy"
import { makeExtensionContext } from "../../../test-utils/vscode"
import { WorkspaceIndexingEnablementManager } from "../workspace-indexing-enablement-manager"

describe("WorkspaceIndexingEnablementManager", () => {
	const setup = () => {
		const manager = {
			setWorkspaceEnabled: vi.fn().mockResolvedValue(undefined),
			isFeatureEnabled: true,
			isFeatureConfigured: true,
			initialize: vi.fn().mockResolvedValue({ requiresRestart: false }),
			startIndexing: vi.fn().mockResolvedValue(undefined),
			stopIndexing: vi.fn(),
			getCurrentStatus: vi.fn<CodeIndexManager["getCurrentStatus"]>().mockReturnValue({
				systemStatus: "Standby",
				message: "Ready",
				processedItems: 0,
				totalItems: 0,
				currentItemUnit: "blocks",
				workspacePath: "/workspace",
				workspaceEnabled: true,
				autoEnableDefault: false,
			}),
		}
		return {
			manager,
			indexing: new WorkspaceIndexingEnablementManager(manager),
			provider: {
				contextProxy: new ContextProxy(makeExtensionContext()),
				log: vi.fn(),
				postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			},
		}
	}

	it("persists enablement, initializes and starts in order without awaiting indexing", async () => {
		const { manager, indexing, provider } = setup()
		manager.startIndexing.mockReturnValue(new Promise<void>(() => {}))
		await indexing.setEnabled(true, provider)
		expect(manager.setWorkspaceEnabled).toHaveBeenCalledWith(true)
		expect(manager.initialize).toHaveBeenCalledWith(provider.contextProxy)
		expect(manager.setWorkspaceEnabled).toHaveBeenCalledBefore(manager.initialize)
		expect(manager.initialize).toHaveBeenCalledBefore(manager.startIndexing)
		expect(manager.stopIndexing).not.toHaveBeenCalled()
	})

	it("persists disablement before stopping", async () => {
		const { manager, indexing, provider } = setup()
		await indexing.setEnabled(false, provider)
		expect(manager.setWorkspaceEnabled).toHaveBeenCalledWith(false)
		expect(manager.setWorkspaceEnabled).toHaveBeenCalledBefore(manager.stopIndexing)
		expect(manager.stopIndexing).toHaveBeenCalledOnce()
		expect(manager.initialize).not.toHaveBeenCalled()
		expect(manager.startIndexing).not.toHaveBeenCalled()
	})

	it.each(["isFeatureEnabled", "isFeatureConfigured"] as const)("does not start when %s is false", async (flag) => {
		const { manager, indexing, provider } = setup()
		manager[flag] = false
		await indexing.setEnabled(true, provider)
		expect(manager.setWorkspaceEnabled).toHaveBeenCalledWith(true)
		expect(manager.initialize).not.toHaveBeenCalled()
		expect(manager.startIndexing).not.toHaveBeenCalled()
		expect(manager.stopIndexing).not.toHaveBeenCalled()
	})

	it("logs background indexing failures", async () => {
		const { manager, indexing, provider } = setup()
		manager.startIndexing.mockRejectedValue(new Error("failed"))
		await expect(indexing.setEnabled(true, provider)).resolves.toBeUndefined()
		expect(provider.log).toHaveBeenCalledWith("Indexing error: Error: failed")
	})

	it.each([true, false])("publishes the current status after setting enabled=%s", async (enabled) => {
		const { manager, indexing, provider } = setup()
		await indexing.setEnabled(enabled, provider)
		expect(provider.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "indexingStatusUpdate",
			values: manager.getCurrentStatus.mock.results[0].value,
		})
		expect(enabled ? manager.startIndexing : manager.stopIndexing).toHaveBeenCalledBefore(manager.getCurrentStatus)
	})

	it("propagates status publication failures", async () => {
		const { indexing, provider } = setup()
		const error = new Error("post failed")
		provider.postMessageToWebview.mockRejectedValue(error)
		await expect(indexing.setEnabled(false, provider)).rejects.toBe(error)
	})

	it.each(["setWorkspaceEnabled", "initialize"] as const)(
		"propagates %s failures without starting",
		async (method) => {
			const { manager, indexing, provider } = setup()
			const error = new Error("failed")
			manager[method].mockRejectedValue(error)
			await expect(indexing.setEnabled(true, provider)).rejects.toBe(error)
			expect(manager.startIndexing).not.toHaveBeenCalled()
			expect(provider.postMessageToWebview).not.toHaveBeenCalled()
		},
	)
})
