import * as vscode from "vscode"
import type { ClineProvider } from "../core/webview/ClineProvider"
import { UsageStatsService } from "../services/stats"
import { DashboardTaskCatalog } from "../services/stats/DashboardTaskCatalog"
import { buildCustomPricingMap } from "../core/webview/usageStatsMessageHandler"

/**
 * Activates the Dashboard feature services and command handlers non-invasively.
 *
 * @param context ExtensionContext provided during extension activation
 * @param provider ClineProvider reference
 */
export function activateDashboard(context: vscode.ExtensionContext, provider: ClineProvider): void {
	// Register the dashboard button command
	const commandDisposable = vscode.commands.registerCommand("zoo-code.dashboardButtonClicked", async () => {
		await provider.postMessageToWebview({ action: "dashboardButtonClicked" })
	})
	context.subscriptions.push(commandDisposable)

	// Best-effort initialization of dashboard stats service
	try {
		const globalStoragePath = context.globalStorageUri.fsPath
		const taskHistoryStore = provider.getTaskHistoryStore()
		if (!taskHistoryStore) return

		const taskCatalog = new DashboardTaskCatalog(taskHistoryStore)
		context.subscriptions.push(taskCatalog)

		const customPricingProvider = () => buildCustomPricingMap(provider.contextProxy)
		const usageStatsService = new UsageStatsService(
			globalStoragePath,
			taskCatalog,
			customPricingProvider,
			provider.providerSettingsManager,
		)

		usageStatsService.initialize().catch((error) => {
			provider.log(`Failed to initialize Usage Stats Service: ${error}`)
		})

		provider.setUsageStatsService(usageStatsService)

		context.subscriptions.push({
			dispose: () => {
				usageStatsService.dispose()
				provider.setUsageStatsService(undefined)
			},
		})

		// Notify webview on cross-window/same-window stats updates
		usageStatsService.onDidChange(() => {
			provider.postMessageToWebview({ type: "usageStatsChanged" }).catch(() => {})
		})
	} catch (error) {
		provider.log(`Failed to activate Dashboard services: ${error}`)
	}
}
