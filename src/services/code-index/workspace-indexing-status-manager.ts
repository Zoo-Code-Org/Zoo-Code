import type { ClineProvider } from "../../core/webview/ClineProvider"
import type { CodeIndexManager } from "./manager"

/** Publishes the current workspace status in response to an explicit request. */
export class WorkspaceIndexingStatusManager {
	public constructor(private readonly manager: CodeIndexManager) {}

	public async postStatus(provider: Pick<ClineProvider, "postMessageToWebview">): Promise<void> {
		await provider.postMessageToWebview({
			type: "indexingStatusUpdate",
			values: this.manager.getCurrentStatus(),
		})
	}
}
