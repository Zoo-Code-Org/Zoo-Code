import type { ClineProvider } from "../../core/webview/ClineProvider"
import type { CodeIndexManager } from "./manager"

/** Coordinates workspace enablement without owning the underlying indexing services. */
export class WorkspaceIndexingEnablementManager {
	public constructor(
		private readonly manager: Pick<
			CodeIndexManager,
			| "setWorkspaceEnabled"
			| "isFeatureEnabled"
			| "isFeatureConfigured"
			| "initialize"
			| "startIndexing"
			| "stopIndexing"
			| "getCurrentStatus"
		>,
	) {}

	public async setEnabled(
		enabled: boolean,
		provider: Pick<ClineProvider, "contextProxy" | "log" | "postMessageToWebview">,
	): Promise<void> {
		await this.manager.setWorkspaceEnabled(enabled)
		if (enabled && this.manager.isFeatureEnabled && this.manager.isFeatureConfigured) {
			await this.manager.initialize(provider.contextProxy)
			void this.manager.startIndexing().catch((error) => provider.log(`Indexing error: ${error}`))
		} else if (!enabled) {
			this.manager.stopIndexing()
		}
		await provider.postMessageToWebview({
			type: "indexingStatusUpdate",
			values: this.manager.getCurrentStatus(),
		})
	}
}
