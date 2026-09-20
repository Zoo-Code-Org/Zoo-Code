import type { CodeIndexManager } from "../../../services/code-index/manager"
import type { CodeIndexWorkspaceScope } from "../../../services/code-index/code-index-workspace-scope"
import { codeIndexWorkspaceScopeRegistry as registry } from "../../../services/code-index/code-index-workspace-scope-registry"
import type { ContextProxy } from "../../config/ContextProxy"
import type { ClineProvider } from "../ClineProvider"
import { webviewMessageHandler } from "../webviewMessageHandler"

vi.mock("../ClineProvider", () => ({ ClineProvider: vi.fn() }))
vi.mock("../../../services/code-index/code-index-workspace-scope-registry", () => ({
	codeIndexWorkspaceScopeRegistry: { getAllScopes: vi.fn() },
}))

describe("webviewMessageHandler global auto-enable across workspace scopes", () => {
	let autoEnable: boolean
	const contextProxy = {} as ContextProxy

	function makeScope(workspacePath: string, explicit?: boolean, configured = true) {
		const manager = {
			get isWorkspaceEnabled() {
				return explicit ?? autoEnable
			},
			isFeatureEnabled: true,
			isFeatureConfigured: configured,
			setAutoEnableDefault: vi.fn(async (enabled: boolean) => {
				autoEnable = enabled
			}),
			initialize: vi.fn<CodeIndexManager["initialize"]>().mockResolvedValue({ requiresRestart: false }),
			startIndexing: vi.fn<CodeIndexManager["startIndexing"]>().mockResolvedValue(undefined),
			stopIndexing: vi.fn<CodeIndexManager["stopIndexing"]>(),
			getCurrentStatus: vi.fn<CodeIndexManager["getCurrentStatus"]>().mockImplementation(() => ({
				systemStatus: "Standby",
				message: workspacePath,
				processedItems: 0,
				totalItems: 0,
				currentItemUnit: "files",
				workspacePath,
				workspaceEnabled: explicit ?? autoEnable,
				autoEnableDefault: autoEnable,
			})),
		} satisfies Partial<CodeIndexManager>
		const scope: CodeIndexWorkspaceScope = {
			// Private manager infrastructure prevents structural assignment; this double implements only the consumer boundary.
			codeIndexManager: manager as unknown as CodeIndexManager,
			initialize: manager.initialize,
			dispose: vi.fn(),
		}
		return { scope, manager }
	}

	function makeProvider(scope?: CodeIndexWorkspaceScope) {
		const provider = {
			contextProxy,
			getCurrentWorkspaceCodeIndexScope: vi.fn(() => scope),
			postMessageToWebview: vi.fn<ClineProvider["postMessageToWebview"]>().mockResolvedValue(undefined),
			log: vi.fn<ClineProvider["log"]>(),
		}
		return provider
	}

	async function setDefault(provider: ReturnType<typeof makeProvider>, bool?: boolean) {
		// ClineProvider has private extension infrastructure; the handler branch only needs these four typed members.
		await webviewMessageHandler(provider as unknown as ClineProvider, { type: "setAutoEnableDefault", bool })
	}

	beforeEach(() => {
		vi.clearAllMocks()
		autoEnable = false
	})

	it.each([true, undefined])(
		"starts every newly enabled configured scope when bool=%s, isolating start rejection",
		async (bool) => {
			const failing = makeScope("/failing")
			const healthy = makeScope("/healthy")
			const optedOut = makeScope("/opted-out", false)
			const alreadyEnabled = makeScope("/already-enabled", true)
			const unconfigured = makeScope("/unconfigured", undefined, false)
			const scopes = [failing, healthy, optedOut, alreadyEnabled, unconfigured]
			vi.mocked(registry.getAllScopes).mockReturnValue(scopes.map(({ scope }) => scope))
			failing.manager.startIndexing.mockRejectedValue(new Error("first scope failed"))
			const provider = makeProvider(healthy.scope)

			await setDefault(provider, bool)

			expect(healthy.manager.setAutoEnableDefault).toHaveBeenCalledWith(true)
			for (const { manager } of [failing, healthy]) {
				expect(manager.initialize).toHaveBeenCalledWith(contextProxy)
				expect(manager.startIndexing).toHaveBeenCalledOnce()
				expect(manager.stopIndexing).not.toHaveBeenCalled()
			}
			for (const { manager } of [optedOut, alreadyEnabled, unconfigured]) {
				expect(manager.initialize).not.toHaveBeenCalled()
				expect(manager.startIndexing).not.toHaveBeenCalled()
				expect(manager.stopIndexing).not.toHaveBeenCalled()
			}
			expect(provider.log).toHaveBeenCalledWith("Indexing error: Error: first scope failed")
			expect(provider.postMessageToWebview).toHaveBeenCalledWith({
				type: "indexingStatusUpdate",
				values: healthy.manager.getCurrentStatus(),
			})
		},
	)

	it("stops all scopes disabled by the global default but preserves explicit workspace choices", async () => {
		autoEnable = true
		const first = makeScope("/first")
		const second = makeScope("/second")
		const optedIn = makeScope("/opted-in", true)
		const optedOut = makeScope("/opted-out", false)
		const scopes = [first, second, optedIn, optedOut]
		vi.mocked(registry.getAllScopes).mockReturnValue(scopes.map(({ scope }) => scope))
		const provider = makeProvider(second.scope)

		await setDefault(provider, false)

		expect(second.manager.setAutoEnableDefault).toHaveBeenCalledWith(false)
		for (const { manager } of [first, second]) expect(manager.stopIndexing).toHaveBeenCalledOnce()
		for (const { manager } of [optedIn, optedOut]) expect(manager.stopIndexing).not.toHaveBeenCalled()
		for (const { manager } of scopes) {
			expect(manager.initialize).not.toHaveBeenCalled()
			expect(manager.startIndexing).not.toHaveBeenCalled()
		}
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "indexingStatusUpdate",
			values: second.manager.getCurrentStatus(),
		})
	})

	it("does not enumerate scopes or update status when there is no current workspace scope", async () => {
		const provider = makeProvider()

		await setDefault(provider, true)

		expect(provider.log).toHaveBeenCalledWith("Cannot set auto-enable default: No workspace folder open")
		expect(registry.getAllScopes).not.toHaveBeenCalled()
		expect(provider.postMessageToWebview).not.toHaveBeenCalled()
	})
})
