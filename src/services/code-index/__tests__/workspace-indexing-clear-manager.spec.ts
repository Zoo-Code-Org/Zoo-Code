import { makeExtensionContext, makeUri } from "../../../test-utils/vscode"
import { CodeIndexManager } from "../manager"
import { CodeIndexStateManager } from "../state-manager"
import { WorkspaceIndexingClearManager } from "../workspace-indexing-clear-manager"

vi.mock("../manager")
vi.mock("../state-manager")

describe("WorkspaceIndexingClearManager", () => {
	function setup() {
		const manager = new CodeIndexManager(
			"/workspace",
			makeUri("/workspace"),
			makeExtensionContext(),
			new CodeIndexStateManager(),
		)
		const clearIndexData = vi.mocked(manager.clearIndexData).mockResolvedValue(undefined)
		const provider = { postMessageToWebview: vi.fn().mockResolvedValue(undefined) }
		return { clearIndexData, provider, clearing: new WorkspaceIndexingClearManager(manager) }
	}

	it("awaits clearing before publishing success", async () => {
		const { clearIndexData, provider, clearing } = setup()
		let finish = () => {}
		clearIndexData.mockReturnValue(
			new Promise<void>((resolve) => {
				finish = resolve
			}),
		)
		const pending = clearing.clearIndexData(provider)
		expect(clearIndexData).toHaveBeenCalledExactlyOnceWith()
		expect(provider.postMessageToWebview).not.toHaveBeenCalled()
		finish()
		await pending
		expect(provider.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "indexCleared",
			values: { success: true },
		})
	})

	it.each([new Error("clear failed"), "clear failed"])("propagates clearing errors: %s", async (error) => {
		const { clearIndexData, provider, clearing } = setup()
		clearIndexData.mockRejectedValue(error)
		await expect(clearing.clearIndexData(provider)).rejects.toBe(error)
		expect(provider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("propagates response failures to the handler", async () => {
		const { provider, clearing } = setup()
		const error = new Error("response failed")
		provider.postMessageToWebview.mockRejectedValue(error)
		await expect(clearing.clearIndexData(provider)).rejects.toBe(error)
	})
})
