import type { WebviewMessage } from "@roo-code/types"
import type { ClineProvider } from "../../core/webview/ClineProvider"
import type { CodeIndexManager } from "./manager"

/** Saves global settings and applies them to the owning workspace. */
export class WorkspaceIndexingSettingsManager {
	public constructor(private readonly manager: CodeIndexManager) {}

	public async saveSettings(
		settings: NonNullable<WebviewMessage["codeIndexSettings"]>,
		provider: Pick<ClineProvider, "contextProxy" | "log" | "postMessageToWebview" | "postStateToWebview">,
	): Promise<void> {
		try {
			// Check if embedder provider has changed
			const currentConfig = provider.contextProxy.getValue("codebaseIndexConfig") || {}
			const embedderProviderChanged =
				currentConfig.codebaseIndexEmbedderProvider !== settings.codebaseIndexEmbedderProvider

			// Save global state settings atomically
			const globalStateConfig = {
				...currentConfig,
				codebaseIndexEnabled: settings.codebaseIndexEnabled,
				codebaseIndexQdrantUrl: settings.codebaseIndexQdrantUrl,
				codebaseIndexEmbedderProvider: settings.codebaseIndexEmbedderProvider,
				codebaseIndexEmbedderBaseUrl: settings.codebaseIndexEmbedderBaseUrl,
				codebaseIndexEmbedderModelId: settings.codebaseIndexEmbedderModelId,
				codebaseIndexEmbedderModelDimension: settings.codebaseIndexEmbedderModelDimension, // Generic dimension
				codebaseIndexOpenAiCompatibleBaseUrl: settings.codebaseIndexOpenAiCompatibleBaseUrl,
				codebaseIndexBedrockRegion: settings.codebaseIndexBedrockRegion,
				codebaseIndexBedrockProfile: settings.codebaseIndexBedrockProfile,
				codebaseIndexSearchMaxResults: settings.codebaseIndexSearchMaxResults,
				codebaseIndexSearchMinScore: settings.codebaseIndexSearchMinScore,
				codebaseIndexOpenRouterSpecificProvider: settings.codebaseIndexOpenRouterSpecificProvider,
			}

			// Save global state first
			await provider.contextProxy.setValue("codebaseIndexConfig", globalStateConfig)

			// Save secrets directly using context proxy
			if (settings.codeIndexOpenAiKey !== undefined) {
				await provider.contextProxy.storeSecret("codeIndexOpenAiKey", settings.codeIndexOpenAiKey)
			}
			if (settings.codeIndexQdrantApiKey !== undefined) {
				await provider.contextProxy.storeSecret("codeIndexQdrantApiKey", settings.codeIndexQdrantApiKey)
			}
			if (settings.codebaseIndexOpenAiCompatibleApiKey !== undefined) {
				await provider.contextProxy.storeSecret(
					"codebaseIndexOpenAiCompatibleApiKey",
					settings.codebaseIndexOpenAiCompatibleApiKey,
				)
			}
			if (settings.codebaseIndexGeminiApiKey !== undefined) {
				await provider.contextProxy.storeSecret("codebaseIndexGeminiApiKey", settings.codebaseIndexGeminiApiKey)
			}
			if (settings.codebaseIndexMistralApiKey !== undefined) {
				await provider.contextProxy.storeSecret(
					"codebaseIndexMistralApiKey",
					settings.codebaseIndexMistralApiKey,
				)
			}
			if (settings.codebaseIndexVercelAiGatewayApiKey !== undefined) {
				await provider.contextProxy.storeSecret(
					"codebaseIndexVercelAiGatewayApiKey",
					settings.codebaseIndexVercelAiGatewayApiKey,
				)
			}
			if (settings.codebaseIndexOpenRouterApiKey !== undefined) {
				await provider.contextProxy.storeSecret(
					"codebaseIndexOpenRouterApiKey",
					settings.codebaseIndexOpenRouterApiKey,
				)
			}

			// Send success response first - settings are saved regardless of validation
			await provider.postMessageToWebview({
				type: "codeIndexSettingsSaved",
				success: true,
				settings: globalStateConfig,
			})

			// Update webview state
			await provider.postStateToWebview()

			// Then handle validation and initialization for the current workspace
			const currentCodeIndexManager = this.manager
			// If embedder provider changed, perform proactive validation
			if (embedderProviderChanged) {
				try {
					// Force handleSettingsChange which will trigger validation
					await currentCodeIndexManager.handleSettingsChange()
				} catch (error) {
					// Validation failed - the error state is already set by handleSettingsChange
					provider.log(
						`Embedder validation failed after provider change: ${error instanceof Error ? error.message : String(error)}`,
					)
					// Send validation error to webview
					await provider.postMessageToWebview({
						type: "indexingStatusUpdate",
						values: currentCodeIndexManager.getCurrentStatus(),
					})
					// Exit early - don't try to start indexing with invalid configuration
					return
				}
			} else {
				// No provider change, just handle settings normally
				try {
					await currentCodeIndexManager.handleSettingsChange()
				} catch (error) {
					// Log but don't fail - settings are saved
					provider.log(
						`Settings change handling error: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}

			// Wait a bit more to ensure everything is ready
			await new Promise((resolve) => setTimeout(resolve, 200))

			// Auto-start indexing if now enabled and configured
			if (currentCodeIndexManager.isFeatureEnabled && currentCodeIndexManager.isFeatureConfigured) {
				if (!currentCodeIndexManager.isInitialized) {
					try {
						await currentCodeIndexManager.initialize(provider.contextProxy)
						provider.log(`Code index manager initialized after settings save`)
					} catch (error) {
						provider.log(
							`Code index initialization failed: ${error instanceof Error ? error.message : String(error)}`,
						)
						// Send error status to webview
						await provider.postMessageToWebview({
							type: "indexingStatusUpdate",
							values: currentCodeIndexManager.getCurrentStatus(),
						})
					}
				}
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			provider.log(`Error saving code index settings: ${errorMessage}`)
			await provider.postMessageToWebview({
				type: "codeIndexSettingsSaved",
				success: false,
				error: errorMessage || "Failed to save settings",
			})
		}
	}
}
