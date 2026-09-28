import { makeExtensionContext, makeUri } from "../../../test-utils/vscode"
import { CodeIndexManager } from "../manager"
import { CodeIndexStateManager } from "../state-manager"
import { WorkspaceIndexingStatusManager } from "../workspace-indexing-status-manager"

vi.mock("../manager")
vi.mock("../state-manager")

describe("WorkspaceIndexingStatusManager", () => {
	function setup() {
		const manager = new CodeIndexManager(
			"/workspace",
			makeUri("/workspace"),
			makeExtensionContext(),
			new CodeIndexStateManager(),
		)
		const status: ReturnType<CodeIndexManager["getCurrentStatus"]> = {
			systemStatus: "Standby",
			message: "Ready",
			processedItems: 0,
			totalItems: 0,
			currentItemUnit: "blocks",
			workspacePath: "/workspace",
			workspaceEnabled: true,
			autoEnableDefault: false,
		}
		vi.mocked(manager.getCurrentStatus).mockReturnValue(status)
		const provider = { postMessageToWebview: vi.fn().mockResolvedValue(undefined) }
		return { manager, status, provider, publishing: new WorkspaceIndexingStatusManager(manager) }
	}

	it("publishes the current status unchanged and reads it on every request", async () => {
		const { manager, status, provider, publishing } = setup()
		await publishing.postStatus(provider)
		expect(provider.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "indexingStatusUpdate",
			values: status,
		})
		const updated = { ...status, processedItems: 10 }
		vi.mocked(manager.getCurrentStatus).mockReturnValue(updated)
		await publishing.postStatus(provider)
		expect(manager.getCurrentStatus).toHaveBeenCalledTimes(2)
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "indexingStatusUpdate",
			values: updated,
		})
		expect(manager.initialize).not.toHaveBeenCalled()
		expect(manager.startIndexing).not.toHaveBeenCalled()
	})

	it("propagates status retrieval failures without publishing", async () => {
		const { manager, provider, publishing } = setup()
		const error = new Error("status failed")
		vi.mocked(manager.getCurrentStatus).mockImplementation(() => {
			throw error
		})
		await expect(publishing.postStatus(provider)).rejects.toBe(error)
		expect(provider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("awaits publishing and propagates failures", async () => {
		const { provider, publishing } = setup()
		const error = new Error("publish failed")
		provider.postMessageToWebview.mockRejectedValue(error)
		await expect(publishing.postStatus(provider)).rejects.toBe(error)
	})
})
