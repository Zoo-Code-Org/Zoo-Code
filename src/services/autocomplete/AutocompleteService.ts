import type { AutocompleteModelSummary, AutocompleteProviderId, ResolvedAutocompleteConfig } from "@roo-code/types"
import { resolveAutocompleteConfig } from "@roo-code/types"
import * as vscode from "vscode"

import { RooIgnoreController } from "../../core/ignore/RooIgnoreController"
import { AutocompleteLogger } from "./AutocompleteLogger"
import { ContextGatherer } from "./context/ContextGatherer"
import { FileHeaderSource } from "./context/sources/FileHeaderSource"
import { OpenTabsSource } from "./context/sources/OpenTabsSource"
import { AutocompleteConfigService } from "./config/AutocompleteConfigService"
import { CompletionEngine } from "./CompletionEngine"
import { OllamaFimHandler } from "./providers/OllamaFimHandler"
import { OpenAiCompatibleFimHandler } from "./providers/OpenAiCompatibleFimHandler"
import type { FimCompletionHandler } from "./providers/FimCompletionHandler"
import { prefilterDocument, shouldBailForWidget, shouldSuppressAutomaticTrigger } from "./prefilters"
import type { AutocompleteServiceLike, AutocompleteServiceState } from "./types"
import { AutocompleteStatusBar, AUTOCOMPLETE_OPEN_SETTINGS_COMMAND } from "./ui/AutocompleteStatusBar"
import { ZooInlineCompletionProvider } from "./ZooInlineCompletionProvider"

export interface AutocompleteServiceOptions {
	context: vscode.ExtensionContext
	/** Freshly resolved global config; re-read whenever settings change. */
	getGlobalConfig: () => ResolvedAutocompleteConfig
	/** The persisted API key from SecretStorage, or undefined when none is set. */
	getApiKey: () => string | undefined
	/** Opens the settings panel on the autocomplete section. */
	openSettings: () => void
	/** Persists the global enable flag (routed through ContextProxy by the caller). */
	setEnabled: (enabled: boolean) => Promise<void>
}

/**
 * Owns the lifecycle of the inline-completion feature: config merge, the
 * workspace-level kill switch, the `.rooignore` gate, the status bar and the
 * registration of the inline completion provider.
 */
export class AutocompleteService implements AutocompleteServiceLike {
	private readonly configService: AutocompleteConfigService
	private readonly statusBar: AutocompleteStatusBar
	private readonly provider: ZooInlineCompletionProvider
	private readonly rooIgnoreController: RooIgnoreController
	private readonly context: vscode.ExtensionContext
	private readonly openSettingsHandler: () => void
	private readonly setEnabledHandler: (enabled: boolean) => Promise<void>
	private readonly getApiKey: () => string | undefined
	private readonly logger: AutocompleteLogger
	private readonly contextGatherer: ContextGatherer

	private constructor(options: AutocompleteServiceOptions) {
		this.context = options.context
		this.openSettingsHandler = options.openSettings
		this.setEnabledHandler = options.setEnabled
		this.getApiKey = options.getApiKey
		this.configService = new AutocompleteConfigService(options.getGlobalConfig)
		this.logger = new AutocompleteLogger(() => this.configService.isDebugLogging())
		// Ordered cheapest-first; the gatherer races them under one budget anyway.
		this.contextGatherer = new ContextGatherer([new FileHeaderSource(), new OpenTabsSource()])

		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ""
		this.rooIgnoreController = new RooIgnoreController(cwd)

		const engine = this.buildEngine()

		this.provider = new ZooInlineCompletionProvider({
			getConfig: () => this.configService.getConfig(),
			validateAccess: (filePath) => this.rooIgnoreController.validateAccess(filePath),
			engine,
			logger: this.logger,
		})

		this.statusBar = new AutocompleteStatusBar(this)
	}

	/** Builds the completion engine with the handler for the current provider. */
	private buildEngine(): CompletionEngine {
		const handler = this.buildHandler()

		return new CompletionEngine({
			getConfig: () => this.configService.getConfig(),
			getApiKey: () => this.getApiKey(),
			handler,
			logger: this.logger,
			contextGatherer: this.contextGatherer,
		})
	}

	/**
	 * Resolves the FIM handler for the configured provider. Phase 2 ships Ollama;
	 * Phase 3 adds OpenAI-compatible (LM Studio / llama.cpp / vLLM). Codestral and
	 * chat-fallback land later in Phase 3.
	 */
	private buildHandler(overrides?: {
		provider?: AutocompleteProviderId
		baseUrl?: string
		apiKey?: string
	}): FimCompletionHandler {
		const config = this.configService.getConfig()
		const provider = overrides?.provider ?? config.provider

		// Model listing runs against values the user is still editing, so the
		// override wins over persisted config when present.
		const getConfig = () => ({
			...this.configService.getConfig(),
			...(overrides?.baseUrl ? { baseUrl: overrides.baseUrl } : {}),
		})
		const getApiKey = () => overrides?.apiKey ?? this.getApiKey()

		if (provider === "ollama") {
			return new OllamaFimHandler({ getConfig, getApiKey })
		}

		if (provider === "openai-compatible") {
			return new OpenAiCompatibleFimHandler({ getConfig, getApiKey })
		}

		// Any other provider id comes from the Providers tab. Those are reached over
		// an OpenAI-compatible surface too, so the same handler serves them once a
		// base URL is configured; without one there is nothing to call.
		if (this.configService.getConfig().baseUrl) {
			return new OpenAiCompatibleFimHandler({ getConfig, getApiKey })
		}

		return NOOP_HANDLER
	}

	/**
	 * Lists the models the configured endpoint offers, so the settings UI can
	 * present a picker instead of asking the user to type an exact model id.
	 *
	 * Builds a handler on demand rather than reusing the engine's: the user is
	 * usually mid-edit (a base URL they just typed, a provider they just switched
	 * to) and has not saved yet, so the engine's handler reflects stale config.
	 */
	async listModels(
		signal: AbortSignal,
		overrides?: { provider?: AutocompleteProviderId; baseUrl?: string; apiKey?: string },
	): Promise<AutocompleteModelSummary[]> {
		return this.buildHandler(overrides).listModels(signal)
	}

	static async create(options: AutocompleteServiceOptions): Promise<AutocompleteService> {
		const service = new AutocompleteService(options)
		await service.rooIgnoreController.initialize()
		service.register()
		return service
	}

	private register(): void {
		this.context.subscriptions.push(
			vscode.languages.registerInlineCompletionItemProvider({ pattern: "**/*" }, this.provider),
			vscode.commands.registerCommand(AUTOCOMPLETE_OPEN_SETTINGS_COMMAND, () => this.openSettingsHandler()),
		)

		// Workspace-scoped kill switch and debug toggle apply without restart.
		this.context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration("zoo-code.autocomplete")) {
					this.handleSettingsChange()
				}
			}),
		)

		this.statusBar.show()
	}

	/** Re-reads global config and re-renders the status bar after a settings save. */
	handleSettingsChange(): void {
		this.statusBar.refresh()
	}

	/** Clears the completion cache; call after a provider/model switch so stale entries don't resurface. */
	clearCache(): void {
		// The engine owns its own cache; expose this once the cache is a service-level
		// field (Phase 3 rebuilds the handler on provider change). For Phase 2 the
		// cache keys include modelId, so a model switch naturally misses.
	}

	/**
	 * Manual trigger: arms the provider for the next call and asks VS Code to
	 * request an inline suggestion. The provider consumes the flag on the next
	 * `provideInlineCompletionItems` invocation regardless of trigger kind.
	 */
	triggerInlineCompletion(): void {
		this.provider.requestForcedTrigger()
		void vscode.commands.executeCommand("editor.action.inlineSuggest.trigger")
	}

	/**
	 * Flips the persisted global enable flag. Persisted through the same path as
	 * the settings panel so the webview state and the service never disagree.
	 */
	async toggleEnabled(): Promise<void> {
		const config = this.configService.getConfig()
		await this.setEnabledHandler(!config.enabled)
		this.handleSettingsChange()
	}

	/** Public for tests: the config the provider would use right now. */
	getConfig(): ResolvedAutocompleteConfig {
		return this.configService.getConfig()
	}

	getState(): AutocompleteServiceState {
		const config = this.configService.getConfig()
		if (!config.enabled) {
			const workspace = AutocompleteConfigService.readWorkspaceConfig()
			return { enabled: false, reason: workspace.disabled ? "workspace-kill-switch" : "disabled" }
		}
		return { enabled: true }
	}

	dispose(): void {
		this.statusBar.dispose()
		this.rooIgnoreController.dispose()
	}
}

let autocompleteService: AutocompleteService | undefined

/** A handler that never produces completions; used until Phase 3 fills in all providers. */
const NOOP_HANDLER: FimCompletionHandler = {
	id: "chat-fallback",
	usesNativeFim: false,
	supportsStreaming: false,
	async *streamFim() {
		yield ""
		return
	},
	async listModels() {
		return []
	},
	async validate() {
		return { ok: false, error: "This provider is not yet supported for inline completion." }
	},
}

/**
 * Registers the single service instance for the extension host. Only
 * `registerAutocomplete` (extension activation) should call this.
 */
export function setAutocompleteService(service: AutocompleteService): void {
	autocompleteService = service
}

/**
 * Returns the active service, or `undefined` when the feature was never
 * registered (e.g. tests, or activation order edge cases). Consumers guard with
 * `?.` — the handler must never crash because autocomplete is unavailable.
 */
export function getAutocompleteService(): AutocompleteService | undefined {
	return autocompleteService
}

export { resolveAutocompleteConfig, prefilterDocument, shouldBailForWidget, shouldSuppressAutomaticTrigger }
