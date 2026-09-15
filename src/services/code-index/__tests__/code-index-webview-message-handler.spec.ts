import { makeExtensionContext } from "../../../test-utils/vscode"
import { ContextProxy } from "../../../core/config/ContextProxy"

import { CodeIndexWebviewMessageHandler } from "../code-index-webview-message-handler"

vi.mock("vscode", () => ({}))

function createProvider(codeIndexScope?: ReturnType<typeof createCodeIndexScope>) {
	const context = makeExtensionContext()
	const contextProxy = new ContextProxy(context)
	vi.spyOn(contextProxy, "getValue").mockReturnValue({})
	vi.spyOn(contextProxy, "setValue").mockResolvedValue(undefined)
	vi.spyOn(contextProxy, "storeSecret").mockResolvedValue(undefined)
	return {
		context,
		contextProxy,
		getCurrentWorkspaceCodeIndexScope: vi.fn().mockReturnValue(codeIndexScope),
		log: vi.fn(),
		postMessageToWebview: vi.fn().mockResolvedValue(true),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
	}
}

function createCodeIndexScope() {
	const codeIndexState = {
		systemStatus: "Standby" as const,
		message: "Ready",
		processedItems: 0,
		totalItems: 0,
		currentItemUnit: "blocks",
		workspacePath: "/workspace",
		workspaceEnabled: true,
		autoEnableDefault: true,
	}
	return {
		codeIndexManager: {
			isWorkspaceEnabled: true,
			isFeatureEnabled: true,
			isFeatureConfigured: true,
			isInitialized: true,
			state: "Standby" as const,
		},
		codeIndexController: {
			codeIndexState,
			handleSettingsChange: vi.fn().mockResolvedValue(undefined),
			initialize: vi.fn().mockResolvedValue({ requiresRestart: false }),
			startIndexing: vi.fn().mockResolvedValue(undefined),
			stopIndexing: vi.fn(),
			setWorkspaceEnabled: vi.fn().mockResolvedValue(undefined),
			setAutoEnableDefault: vi.fn().mockResolvedValue(undefined),
			clearIndexData: vi.fn().mockResolvedValue(undefined),
		},
	}
}

describe("CodeIndexWebviewMessageHandler", () => {
	it("accepts only code-index messages", () => {
		const handler = new CodeIndexWebviewMessageHandler(createProvider())

		expect(handler.canHandle({ type: "requestIndexingStatus" })).toBe(true)
		expect(handler.canHandle({ type: "clearTask" })).toBe(false)
	})

	it("sends the complete code index state", async () => {
		const codeIndexScope = createCodeIndexScope()
		const provider = createProvider(codeIndexScope)
		const handler = new CodeIndexWebviewMessageHandler(provider)

		await handler.handle({ type: "requestIndexingStatus" })

		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "indexingStatusUpdate",
			values: codeIndexScope.codeIndexController.codeIndexState,
		})
	})

	it("reports that indexing requires a workspace", async () => {
		const provider = createProvider()
		const handler = new CodeIndexWebviewMessageHandler(provider)

		await handler.handle({ type: "startIndexing" })

		expect(provider.log).toHaveBeenCalledWith("Cannot start indexing: No workspace folder open")
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "indexingStatusUpdate",
			values: expect.objectContaining({ systemStatus: "Error" }),
		})
	})

	it("delegates workspace indexing changes and returns the updated state", async () => {
		const codeIndexScope = createCodeIndexScope()
		const provider = createProvider(codeIndexScope)
		const handler = new CodeIndexWebviewMessageHandler(provider)

		await handler.handle({ type: "toggleWorkspaceIndexing", bool: false })

		expect(codeIndexScope.codeIndexController.setWorkspaceEnabled).toHaveBeenCalledWith(false)
		expect(codeIndexScope.codeIndexController.stopIndexing).toHaveBeenCalledTimes(1)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "indexingStatusUpdate",
			values: codeIndexScope.codeIndexController.codeIndexState,
		})
	})

	it("returns successful and failed clear-index results", async () => {
		const codeIndexScope = createCodeIndexScope()
		const provider = createProvider(codeIndexScope)
		const handler = new CodeIndexWebviewMessageHandler(provider)

		await handler.handle({ type: "clearIndexData" })
		codeIndexScope.codeIndexController.clearIndexData.mockRejectedValueOnce(new Error("clear failed"))
		await handler.handle({ type: "clearIndexData" })

		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "indexCleared",
			values: { success: true },
		})
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "indexCleared",
			values: { success: false, error: "clear failed" },
		})
	})
})
