import type { ClineProvider } from "../../core/webview/ClineProvider"
import type { CodeIndexManager } from "./manager"

/** Coordinates index clearing and its success response without owning indexing services. */
export class WorkspaceIndexingClearManager {
	public constructor(private readonly manager: CodeIndexManager) {}

	public async clearIndexData(provider: Pick<ClineProvider, "postMessageToWebview">): Promise<void> {
		await this.manager.clearIndexData()
		await provider.postMessageToWebview({ type: "indexCleared", values: { success: true } })
	}
}
