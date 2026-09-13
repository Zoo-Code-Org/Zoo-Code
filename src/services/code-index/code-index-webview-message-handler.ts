import type { GlobalState, WebviewMessage } from "@roo-code/types"
import type * as vscode from "vscode"

import type { ClineProvider } from "../../core/webview/ClineProvider"
import type { ContextProxy } from "../../core/config/ContextProxy"
import type { WebviewMessageFeatureHandler } from "../../core/webview/WebviewMessageHandlerRegistry"
import { t } from "../../i18n"
import { CodeIndexManagerRegistry } from "./code-index-manager-registry"
import type { CodeIndexState } from "./models/code-index-state"

type CodeIndexWebviewProvider = Pick<
	ClineProvider,
	"getCurrentWorkspaceCodeIndexScope" | "log" | "postMessageToWebview" | "postStateToWebview"
> & {
	context: { secrets: Pick<vscode.SecretStorage, "get"> }
	contextProxy: ContextProxy
}

const codeIndexWebviewMessageTypes: ReadonlySet<WebviewMessage["type"]> = new Set([
	"saveCodeIndexSettingsAtomic",
	"requestIndexingStatus",
	"requestCodeIndexSecretStatus",
	"startIndexing",
	"stopIndexing",
	"toggleWorkspaceIndexing",
	"setAutoEnableDefault",
	"clearIndexData",
])

export class CodeIndexWebviewMessageHandler implements WebviewMessageFeatureHandler {
	public constructor(private readonly provider: CodeIndexWebviewProvider) {}

	public canHandle(message: WebviewMessage): boolean {
		return codeIndexWebviewMessageTypes.has(message.type)
	}

	public async handle(message: WebviewMessage): Promise<void> {
		switch (message.type) {
			case "saveCodeIndexSettingsAtomic":
				await this.saveCodeIndexSettings(message)
				break
			case "requestIndexingStatus":
				await this.sendIndexingStatus()
				break
			case "requestCodeIndexSecretStatus":
				await this.sendCodeIndexSecretStatus()
				break
			case "startIndexing":
				await this.startIndexing()
				break
			case "stopIndexing":
				await this.stopIndexing()
				break
			case "toggleWorkspaceIndexing":
				await this.toggleWorkspaceIndexing(message.bool ?? false)
				break
			case "setAutoEnableDefault":
				await this.setAutoEnableDefault(message.bool ?? true)
				break
			case "clearIndexData":
				await this.clearIndexData()
				break
		}
	}

	private async saveCodeIndexSettings(message: WebviewMessage): Promise<void> {
		if (!message.codeIndexSettings) return

		const settings = message.codeIndexSettings
		try {
			const currentConfig = this.provider.contextProxy.getValue("codebaseIndexConfig") || {}
			const embedderProviderChanged =
				currentConfig.codebaseIndexEmbedderProvider !== settings.codebaseIndexEmbedderProvider
			const globalStateConfig: NonNullable<GlobalState["codebaseIndexConfig"]> = {
				...currentConfig,
				codebaseIndexEnabled: settings.codebaseIndexEnabled,
				codebaseIndexQdrantUrl: settings.codebaseIndexQdrantUrl,
				codebaseIndexEmbedderProvider: settings.codebaseIndexEmbedderProvider,
				codebaseIndexEmbedderBaseUrl: settings.codebaseIndexEmbedderBaseUrl,
				codebaseIndexEmbedderModelId: settings.codebaseIndexEmbedderModelId,
				codebaseIndexEmbedderModelDimension: settings.codebaseIndexEmbedderModelDimension,
				codebaseIndexOpenAiCompatibleBaseUrl: settings.codebaseIndexOpenAiCompatibleBaseUrl,
				codebaseIndexBedrockRegion: settings.codebaseIndexBedrockRegion,
				codebaseIndexBedrockProfile: settings.codebaseIndexBedrockProfile,
				codebaseIndexSearchMaxResults: settings.codebaseIndexSearchMaxResults,
				codebaseIndexSearchMinScore: settings.codebaseIndexSearchMinScore,
				codebaseIndexOpenRouterSpecificProvider: settings.codebaseIndexOpenRouterSpecificProvider,
			}

			await this.provider.contextProxy.setValue("codebaseIndexConfig", globalStateConfig)
			await this.storeCodeIndexSecrets(settings)
			await this.provider.postMessageToWebview({
				type: "codeIndexSettingsSaved",
				success: true,
				settings: globalStateConfig,
			})
			await this.provider.postStateToWebview()
			await this.applySavedSettings(embedderProviderChanged)
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			this.provider.log(`Error saving code index settings: ${errorMessage}`)
			await this.provider.postMessageToWebview({
				type: "codeIndexSettingsSaved",
				success: false,
				error: errorMessage || "Failed to save settings",
			})
		}
	}

	private async storeCodeIndexSecrets(settings: NonNullable<WebviewMessage["codeIndexSettings"]>): Promise<void> {
		const secrets = [
			["codeIndexOpenAiKey", settings.codeIndexOpenAiKey],
			["codeIndexQdrantApiKey", settings.codeIndexQdrantApiKey],
			["codebaseIndexOpenAiCompatibleApiKey", settings.codebaseIndexOpenAiCompatibleApiKey],
			["codebaseIndexGeminiApiKey", settings.codebaseIndexGeminiApiKey],
			["codebaseIndexMistralApiKey", settings.codebaseIndexMistralApiKey],
			["codebaseIndexVercelAiGatewayApiKey", settings.codebaseIndexVercelAiGatewayApiKey],
			["codebaseIndexOpenRouterApiKey", settings.codebaseIndexOpenRouterApiKey],
		] as const

		for (const [key, value] of secrets) {
			if (value !== undefined) await this.provider.contextProxy.storeSecret(key, value)
		}
	}

	private async applySavedSettings(embedderProviderChanged: boolean): Promise<void> {
		const codeIndexScope = this.provider.getCurrentWorkspaceCodeIndexScope()
		if (!codeIndexScope) {
			this.provider.log("Cannot save code index settings: No workspace folder open")
			await this.sendWorkspaceRequiredStatus()
			return
		}

		const { codeIndexManager, codeIndexController } = codeIndexScope
		try {
			await codeIndexController.handleSettingsChange()
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			this.provider.log(
				embedderProviderChanged
					? `Embedder validation failed after provider change: ${errorMessage}`
					: `Settings change handling error: ${errorMessage}`,
			)
			if (embedderProviderChanged) {
				await this.postCodeIndexState(codeIndexController.codeIndexState)
				return
			}
		}

		await new Promise((resolve) => setTimeout(resolve, 200))
		if (
			codeIndexManager.isFeatureEnabled &&
			codeIndexManager.isFeatureConfigured &&
			!codeIndexManager.isInitialized
		) {
			try {
				await codeIndexController.initialize(this.provider.contextProxy)
				this.provider.log("Code index manager initialized after settings save")
			} catch (error) {
				this.provider.log(
					`Code index initialization failed: ${error instanceof Error ? error.message : String(error)}`,
				)
				await this.postCodeIndexState(codeIndexController.codeIndexState)
			}
		}
	}

	private async sendIndexingStatus(): Promise<void> {
		const codeIndexScope = this.provider.getCurrentWorkspaceCodeIndexScope()
		if (!codeIndexScope) {
			await this.sendWorkspaceRequiredStatus()
			return
		}
		await this.postCodeIndexState(codeIndexScope.codeIndexController.codeIndexState)
	}

	private async sendCodeIndexSecretStatus(): Promise<void> {
		const getSecret = (key: string) => this.provider.context.secrets.get(key)
		const [
			openAiKey,
			qdrantApiKey,
			openAiCompatibleApiKey,
			geminiApiKey,
			mistralApiKey,
			vercelApiKey,
			openRouterKey,
		] = await Promise.all([
			getSecret("codeIndexOpenAiKey"),
			getSecret("codeIndexQdrantApiKey"),
			getSecret("codebaseIndexOpenAiCompatibleApiKey"),
			getSecret("codebaseIndexGeminiApiKey"),
			getSecret("codebaseIndexMistralApiKey"),
			getSecret("codebaseIndexVercelAiGatewayApiKey"),
			getSecret("codebaseIndexOpenRouterApiKey"),
		])
		await this.provider.postMessageToWebview({
			type: "codeIndexSecretStatus",
			values: {
				hasOpenAiKey: !!openAiKey,
				hasQdrantApiKey: !!qdrantApiKey,
				hasOpenAiCompatibleApiKey: !!openAiCompatibleApiKey,
				hasGeminiApiKey: !!geminiApiKey,
				hasMistralApiKey: !!mistralApiKey,
				hasVercelAiGatewayApiKey: !!vercelApiKey,
				hasOpenRouterApiKey: !!openRouterKey,
			},
		})
	}

	private async startIndexing(): Promise<void> {
		try {
			const codeIndexScope = this.provider.getCurrentWorkspaceCodeIndexScope()
			if (!codeIndexScope) {
				await this.sendWorkspaceRequiredStatus()
				this.provider.log("Cannot start indexing: No workspace folder open")
				return
			}
			const { codeIndexManager, codeIndexController } = codeIndexScope
			await codeIndexController.setWorkspaceEnabled(true)
			if (!codeIndexManager.isFeatureEnabled || !codeIndexManager.isFeatureConfigured) return

			await codeIndexController.initialize(this.provider.contextProxy)
			if (codeIndexManager.state === "Standby" || codeIndexManager.state === "Error") {
				this.startIndexingDetached(codeIndexController)
				if (!codeIndexManager.isInitialized) {
					await codeIndexController.initialize(this.provider.contextProxy)
					if (codeIndexManager.state === "Standby" || codeIndexManager.state === "Error") {
						this.startIndexingDetached(codeIndexController)
					}
				}
			}
		} catch (error) {
			this.provider.log(`Error starting indexing: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	private async stopIndexing(): Promise<void> {
		try {
			const codeIndexScope = this.provider.getCurrentWorkspaceCodeIndexScope()
			if (!codeIndexScope) {
				this.provider.log("Cannot stop indexing: No workspace folder open")
				return
			}
			codeIndexScope.codeIndexController.stopIndexing()
			await this.postCodeIndexState(codeIndexScope.codeIndexController.codeIndexState)
		} catch (error) {
			this.provider.log(`Error stopping indexing: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	private async toggleWorkspaceIndexing(enabled: boolean): Promise<void> {
		try {
			const codeIndexScope = this.provider.getCurrentWorkspaceCodeIndexScope()
			if (!codeIndexScope) {
				this.provider.log("Cannot toggle workspace indexing: No workspace folder open")
				return
			}
			const { codeIndexManager, codeIndexController } = codeIndexScope
			await codeIndexController.setWorkspaceEnabled(enabled)
			if (enabled && codeIndexManager.isFeatureEnabled && codeIndexManager.isFeatureConfigured) {
				await codeIndexController.initialize(this.provider.contextProxy)
				this.startIndexingDetached(codeIndexController)
			} else if (!enabled) {
				codeIndexController.stopIndexing()
			}
			await this.postCodeIndexState(codeIndexController.codeIndexState)
		} catch (error) {
			this.provider.log(
				`Error toggling workspace indexing: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	private async setAutoEnableDefault(enabled: boolean): Promise<void> {
		try {
			const currentCodeIndexScope = this.provider.getCurrentWorkspaceCodeIndexScope()
			if (!currentCodeIndexScope) {
				this.provider.log("Cannot set auto-enable default: No workspace folder open")
				return
			}
			const allCodeIndexScopes = CodeIndexManagerRegistry.getAllCodeIndexScopes()
			const priorStates = new Map(
				allCodeIndexScopes.map((codeIndexScope) => [
					codeIndexScope,
					codeIndexScope.codeIndexManager.isWorkspaceEnabled,
				]),
			)
			await currentCodeIndexScope.codeIndexController.setAutoEnableDefault(enabled)
			for (const codeIndexScope of allCodeIndexScopes) {
				const { codeIndexManager, codeIndexController } = codeIndexScope
				const wasEnabled = priorStates.get(codeIndexScope)!
				const isNowEnabled = codeIndexManager.isWorkspaceEnabled
				if (wasEnabled && !isNowEnabled) {
					codeIndexController.stopIndexing()
				} else if (
					!wasEnabled &&
					isNowEnabled &&
					codeIndexManager.isFeatureEnabled &&
					codeIndexManager.isFeatureConfigured
				) {
					await codeIndexController.initialize(this.provider.contextProxy)
					this.startIndexingDetached(codeIndexController)
				}
			}
			await this.postCodeIndexState(currentCodeIndexScope.codeIndexController.codeIndexState)
		} catch (error) {
			this.provider.log(
				`Error setting auto-enable default: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	private async clearIndexData(): Promise<void> {
		try {
			const codeIndexScope = this.provider.getCurrentWorkspaceCodeIndexScope()
			if (!codeIndexScope) {
				this.provider.log("Cannot clear index data: No workspace folder open")
				await this.provider.postMessageToWebview({
					type: "indexCleared",
					values: { success: false, error: t("embeddings:orchestrator.indexingRequiresWorkspace") },
				})
				return
			}
			await codeIndexScope.codeIndexController.clearIndexData()
			await this.provider.postMessageToWebview({ type: "indexCleared", values: { success: true } })
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			this.provider.log(`Error clearing index data: ${errorMessage}`)
			await this.provider.postMessageToWebview({
				type: "indexCleared",
				values: { success: false, error: errorMessage },
			})
		}
	}

	private startIndexingDetached(codeIndexController: { startIndexing(): Promise<void> }): void {
		void codeIndexController.startIndexing().catch((error) => this.provider.log(`Indexing error: ${error}`))
	}

	private async postCodeIndexState(values: CodeIndexState): Promise<void> {
		await this.provider.postMessageToWebview({ type: "indexingStatusUpdate", values })
	}

	private async sendWorkspaceRequiredStatus(): Promise<void> {
		await this.provider.postMessageToWebview({
			type: "indexingStatusUpdate",
			values: {
				systemStatus: "Error",
				message: t("embeddings:orchestrator.indexingRequiresWorkspace"),
				processedItems: 0,
				totalItems: 0,
				currentItemUnit: "items",
			},
		})
	}
}
