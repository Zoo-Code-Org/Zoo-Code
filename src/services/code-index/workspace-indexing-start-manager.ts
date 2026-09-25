import type { ClineProvider } from "../../core/webview/ClineProvider"
import type { CodeIndexManager } from "./manager"

/** Coordinates explicit indexing requests without owning the underlying indexing services. */
export class WorkspaceIndexingStartManager {
	public constructor(private readonly manager: CodeIndexManager) {}

	public async startIndexing(provider: Pick<ClineProvider, "contextProxy" | "log">): Promise<void> {
		// "Start Indexing" implicitly enables the workspace.
		await this.manager.setWorkspaceEnabled(true)
		await this.startEnabledWorkspace(provider)
	}

	/** Starts an enabled workspace without creating an explicit enablement override. */
	public async startEnabledWorkspace(provider: Pick<ClineProvider, "contextProxy" | "log">): Promise<void> {
		if (!this.manager.isFeatureEnabled || !this.manager.isFeatureConfigured) {
			return
		}

		await this.manager.initialize(provider.contextProxy)
		const state = this.manager.state
		if (state !== "Standby" && state !== "Error") {
			return
		}

		void this.startInBackground(provider)
	}

	private async startInBackground(provider: Pick<ClineProvider, "contextProxy" | "log">): Promise<void> {
		try {
			await this.manager.startIndexing()
			if (this.manager.isInitialized || !this.manager.isWorkspaceEnabled) {
				return
			}

			// Recovery cleared the services. Reinitialize and try once more.
			await this.manager.initialize(provider.contextProxy)
			const state = this.manager.state
			if (state === "Standby" || state === "Error") {
				await this.manager.startIndexing()
			}
		} catch (error) {
			provider.log(`Indexing error: ${error}`)
		}
	}
}
