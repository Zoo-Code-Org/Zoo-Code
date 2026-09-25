import type { ClineProvider } from "../../core/webview/ClineProvider"
import { CodeIndexManagerRegistry } from "./code-index-manager-registry"
import type { CodeIndexManager } from "./manager"
import type { CodeIndexWorkspaceScope } from "./code-index-workspace-scope"

/** Applies global auto-enable changes to all existing workspace managers. */
export class WorkspaceIndexingAutoEnableManager {
	public constructor(private readonly manager: Pick<CodeIndexManager, "setAutoEnableDefault" | "getCurrentStatus">) {}

	public async setAutoEnableDefault(
		enabled: boolean,
		provider: Pick<ClineProvider, "contextProxy" | "log" | "postMessageToWebview">,
	): Promise<void> {
		// Capture every workspace's effective enablement before changing the global default.
		const priorStates = this.captureWorkspaceEnablement()
		await this.manager.setAutoEnableDefault(enabled)

		for (const { scope, wasEnabled } of priorStates) {
			await this.applyEnablementChange(scope, wasEnabled, provider)
		}

		await this.postStatus(provider)
	}

	private captureWorkspaceEnablement() {
		return CodeIndexManagerRegistry.getAllScopes().map((scope) => ({
			scope,
			wasEnabled: scope.codeIndexManager.isWorkspaceEnabled,
		}))
	}

	private async applyEnablementChange(
		scope: Pick<CodeIndexWorkspaceScope, "codeIndexManager" | "workspaceIndexingStartManager">,
		wasEnabled: boolean,
		provider: Pick<ClineProvider, "contextProxy" | "log">,
	): Promise<void> {
		const manager = scope.codeIndexManager
		const isNowEnabled = manager.isWorkspaceEnabled
		if (wasEnabled === isNowEnabled) {
			return
		}

		if (!isNowEnabled) {
			manager.stopIndexing()
			return
		}

		await scope.workspaceIndexingStartManager.startEnabledWorkspace(provider)
	}

	private async postStatus(provider: Pick<ClineProvider, "postMessageToWebview">): Promise<void> {
		await provider.postMessageToWebview({
			type: "indexingStatusUpdate",
			values: this.manager.getCurrentStatus(),
		})
	}
}
