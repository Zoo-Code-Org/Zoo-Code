import { providerIdentifiers, type WebviewMessage } from "@roo-code/types"
import type { CodeIndexManager } from "../manager"
import { ContextProxy } from "../../../core/config/ContextProxy"
import { makeExtensionContext } from "../../../test-utils/vscode"
import { WorkspaceIndexingSettingsManager } from "../workspace-indexing-settings-manager"

describe("WorkspaceIndexingSettingsManager", () => {
	const settings: NonNullable<WebviewMessage["codeIndexSettings"]> = {
		codebaseIndexEnabled: true,
		codebaseIndexQdrantUrl: "http://localhost:6333",
		codebaseIndexEmbedderProvider: providerIdentifiers.openai,
		codebaseIndexEmbedderModelId: "text-embedding-3-small",
	}

	const setup = () => {
		const manager = {
			handleSettingsChange: vi.fn().mockResolvedValue(undefined),
			isFeatureEnabled: true,
			isFeatureConfigured: true,
			isInitialized: false,
			initialize: vi.fn().mockResolvedValue({ requiresRestart: false }),
			getCurrentStatus: vi.fn<CodeIndexManager["getCurrentStatus"]>().mockReturnValue({
				systemStatus: "Error",
				message: "Validation failed",
				processedItems: 0,
				totalItems: 0,
				currentItemUnit: "items",
				workspacePath: "/workspace",
				workspaceEnabled: true,
				autoEnableDefault: false,
			}),
		}
		const provider = {
			contextProxy: new ContextProxy(makeExtensionContext()),
			log: vi.fn(),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		}
		const setValue = vi.spyOn(provider.contextProxy, "setValue").mockResolvedValue(undefined)
		const storeSecret = vi.spyOn(provider.contextProxy, "storeSecret").mockResolvedValue(undefined)
		// The concrete manager has private service dependencies; this isolated double implements only settings-save operations.
		return {
			manager,
			provider,
			setValue,
			storeSecret,
			indexing: new WorkspaceIndexingSettingsManager(manager as unknown as CodeIndexManager),
		}
	}

	beforeEach(() => vi.useFakeTimers())
	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("saves settings and supplied secrets before acknowledging, validating and initializing", async () => {
		const { indexing, manager, provider, setValue, storeSecret } = setup()
		const secrets = {
			codeIndexOpenAiKey: "openai-key",
			codeIndexQdrantApiKey: "",
			codebaseIndexOpenAiCompatibleApiKey: "compatible-key",
			codebaseIndexGeminiApiKey: "gemini-key",
			codebaseIndexMistralApiKey: "mistral-key",
			codebaseIndexVercelAiGatewayApiKey: "gateway-key",
			codebaseIndexOpenRouterApiKey: "router-key",
		}
		const saving = indexing.saveSettings({ ...settings, ...secrets }, provider)
		await vi.runAllTimersAsync()
		await saving
		expect(setValue).toHaveBeenCalledWith("codebaseIndexConfig", expect.objectContaining(settings))
		for (const [key, value] of Object.entries(secrets)) {
			expect(storeSecret).toHaveBeenCalledWith(key, value)
		}
		expect(storeSecret).toHaveBeenCalledTimes(7)
		expect(setValue).toHaveBeenCalledBefore(storeSecret)
		expect(storeSecret).toHaveBeenCalledBefore(provider.postMessageToWebview)
		expect(provider.postMessageToWebview).toHaveBeenCalledBefore(provider.postStateToWebview)
		expect(provider.postStateToWebview).toHaveBeenCalledBefore(manager.handleSettingsChange)
		expect(manager.handleSettingsChange).toHaveBeenCalledBefore(manager.initialize)
		expect(manager.initialize).toHaveBeenCalledWith(provider.contextProxy)
	})

	it("stops after failed validation when the embedder changes", async () => {
		const { indexing, manager, provider } = setup()
		manager.handleSettingsChange.mockRejectedValue(new Error("invalid embedder"))
		await indexing.saveSettings(settings, provider)
		expect(manager.initialize).not.toHaveBeenCalled()
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "indexingStatusUpdate",
			values: manager.getCurrentStatus(),
		})
	})

	it("continues after settings handling fails if the embedder did not change", async () => {
		const { indexing, manager, provider } = setup()
		vi.spyOn(provider.contextProxy, "getValue").mockReturnValue(settings)
		manager.handleSettingsChange.mockRejectedValue(new Error("settings failure"))
		const saving = indexing.saveSettings(settings, provider)
		await vi.runAllTimersAsync()
		await saving
		expect(manager.initialize).toHaveBeenCalledOnce()
		expect(provider.log).toHaveBeenCalledWith("Settings change handling error: settings failure")
	})

	it.each(["isFeatureEnabled", "isFeatureConfigured", "isInitialized"] as const)(
		"skips initialization according to %s",
		async (flag) => {
			const { indexing, manager, provider } = setup()
			manager[flag] = flag === "isInitialized"
			const saving = indexing.saveSettings(settings, provider)
			await vi.runAllTimersAsync()
			await saving
			expect(manager.initialize).not.toHaveBeenCalled()
		},
	)

	it("reports initialization failures without failing the saved settings", async () => {
		const { indexing, manager, provider } = setup()
		manager.initialize.mockRejectedValue(new Error("initialization failed"))
		const saving = indexing.saveSettings(settings, provider)
		await vi.runAllTimersAsync()
		await saving
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "indexingStatusUpdate",
			values: manager.getCurrentStatus(),
		})
		expect(provider.postMessageToWebview).not.toHaveBeenCalledWith(expect.objectContaining({ success: false }))
	})

	it.each(["state", "secret"])("reports %s persistence failures without validating", async (failure) => {
		const { indexing, manager, provider, setValue, storeSecret } = setup()
		const persist = failure === "state" ? setValue : storeSecret
		persist.mockRejectedValue(new Error("save failed"))
		await indexing.saveSettings({ ...settings, codeIndexOpenAiKey: "key" }, provider)
		expect(manager.handleSettingsChange).not.toHaveBeenCalled()
		expect(provider.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "codeIndexSettingsSaved",
			success: false,
			error: "save failed",
		})
	})
})
