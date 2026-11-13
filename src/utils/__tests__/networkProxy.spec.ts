import * as vscode from "vscode"
import { NodeHttpHandler } from "@smithy/node-http-handler"
import { HttpProxyAgent } from "http-proxy-agent"
import { HttpsProxyAgent } from "https-proxy-agent"
import { makeWorkspaceConfiguration } from "../../test-utils/vscode"
import {
	initializeNetworkProxy,
	getProxyConfig,
	isProxyEnabled,
	isDebugMode,
	getSystemProxyUrl,
	createProxyRoutingRequestHandler,
} from "../networkProxy"

// Mock global-agent and undici: the real bootstrap()/setGlobalDispatcher() write
// process-global state every later test would inherit, and the real ProxyAgent owns sockets.
const mocks = vi.hoisted(() => {
	const closeSpy = vi.fn().mockResolvedValue(undefined)
	// undici's global dispatcher slot always holds a dispatcher (it lazily creates the
	// default one), so the double's slot starts with a sentinel object rather than
	// undefined: a captured "previous dispatcher" must be a real object, as in undici.
	const defaultDispatcher = { close: vi.fn().mockResolvedValue(undefined) }
	const dispatcherSlot: { current: unknown } = { current: defaultDispatcher }
	return {
		bootstrap: vi.fn(),
		// mockImplementation with a plain function keeps the double constructible: the
		// production path calls `new ProxyAgent(...)`, which an arrow implementation rejects.
		proxyAgent: vi.fn().mockImplementation(function () {
			return { close: closeSpy }
		}),
		proxyAgentClose: closeSpy,
		// A scriptable slot mirrors undici's global dispatcher state: get returns what set
		// last wrote, so a test can install a third-party dispatcher between install and
		// teardown and observe which dispatcher survives.
		setGlobalDispatcher: vi.fn((dispatcher: unknown) => {
			dispatcherSlot.current = dispatcher
		}),
		getGlobalDispatcher: vi.fn(() => dispatcherSlot.current),
		dispatcherSlot,
		defaultDispatcher,
		undiciFetch: vi.fn(),
	}
})

vi.mock("global-agent", () => ({ bootstrap: mocks.bootstrap }))

vi.mock("undici", () => ({
	ProxyAgent: mocks.proxyAgent,
	setGlobalDispatcher: mocks.setGlobalDispatcher,
	getGlobalDispatcher: mocks.getGlobalDispatcher,
	fetch: mocks.undiciFetch,
}))

vi.mock("@smithy/node-http-handler", () => ({
	NodeHttpHandler: vi.fn().mockImplementation(function (options?: unknown) {
		return {
			options,
			handle: vi.fn(),
			updateHttpClientConfig: vi.fn(),
			httpHandlerConfigs: vi.fn().mockReturnValue({}),
			destroy: vi.fn(),
		}
	}),
}))
vi.mock("http-proxy-agent", () => ({ HttpProxyAgent: vi.fn() }))
vi.mock("https-proxy-agent", () => ({ HttpsProxyAgent: vi.fn() }))

// Mock vscode
vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(),
		onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
	},
	ExtensionMode: {
		Development: 2,
		Production: 1,
		Test: 3,
	},
}))

describe("networkProxy", () => {
	let mockOutputChannel: vscode.OutputChannel
	let mockConfig: { get: ReturnType<typeof vi.fn> }

	// Helper to create mock context with configurable extensionMode
	function createMockContext(mode: vscode.ExtensionMode = vscode.ExtensionMode.Production): vscode.ExtensionContext {
		return {
			extensionMode: mode,
			subscriptions: [],
			extensionPath: "/test/path",
			globalState: {
				get: vi.fn(),
				update: vi.fn(),
				keys: vi.fn().mockReturnValue([]),
				setKeysForSync: vi.fn(),
			},
			workspaceState: {
				get: vi.fn(),
				update: vi.fn(),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn(),
				store: vi.fn(),
				delete: vi.fn(),
				onDidChange: vi.fn(),
			},
			extensionUri: { fsPath: "/test/path" } as vscode.Uri,
			globalStorageUri: { fsPath: "/test/global" } as vscode.Uri,
			logUri: { fsPath: "/test/logs" } as vscode.Uri,
			storageUri: { fsPath: "/test/storage" } as vscode.Uri,
			storagePath: "/test/storage",
			globalStoragePath: "/test/global",
			logPath: "/test/logs",
			asAbsolutePath: vi.fn((p) => `/test/path/${p}`),
			environmentVariableCollection: {} as vscode.GlobalEnvironmentVariableCollection,
			extension: {} as vscode.Extension<unknown>,
			languageModelAccessInformation: {} as vscode.LanguageModelAccessInformation,
		} as unknown as vscode.ExtensionContext
	}

	beforeEach(() => {
		vi.clearAllMocks()
		// Dispatcher-slot state is process-lifetime in undici; reset it per test so each
		// run captures the same "previous dispatcher".
		mocks.dispatcherSlot.current = mocks.defaultDispatcher

		// Reset environment variables
		delete process.env.GLOBAL_AGENT_HTTP_PROXY
		delete process.env.GLOBAL_AGENT_HTTPS_PROXY
		delete process.env.GLOBAL_AGENT_NO_PROXY
		delete process.env.NODE_TLS_REJECT_UNAUTHORIZED

		mockConfig = {
			get: vi.fn().mockReturnValue(""),
		}

		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
			mockConfig as unknown as vscode.WorkspaceConfiguration,
		)

		mockOutputChannel = {
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
			name: "Test",
			replace: vi.fn(),
		} as unknown as vscode.OutputChannel
	})

	describe("initializeNetworkProxy", () => {
		it("should initialize without proxy when debugProxy.enabled is false", () => {
			mockConfig.get.mockImplementation((key: string) => {
				if (key === "debugProxy.enabled") return false
				if (key === "debugProxy.serverUrl") return "http://127.0.0.1:8888"
				return ""
			})
			const context = createMockContext()

			void initializeNetworkProxy(context, mockOutputChannel)

			expect(process.env.GLOBAL_AGENT_HTTP_PROXY).toBeUndefined()
			expect(process.env.GLOBAL_AGENT_HTTPS_PROXY).toBeUndefined()
		})

		it("should configure proxy environment variables when debugProxy.enabled is true", () => {
			mockConfig.get.mockImplementation((key: string) => {
				if (key === "debugProxy.enabled") return true
				if (key === "debugProxy.serverUrl") return "http://localhost:8080"
				return ""
			})
			// Proxy is only applied in debug mode.
			const context = createMockContext(vscode.ExtensionMode.Development)

			void initializeNetworkProxy(context, mockOutputChannel)

			expect(process.env.GLOBAL_AGENT_HTTP_PROXY).toBe("http://localhost:8080")
			expect(process.env.GLOBAL_AGENT_HTTPS_PROXY).toBe("http://localhost:8080")
		})

		it("should not modify TLS settings in debug mode by default", () => {
			mockConfig.get.mockImplementation((key: string) => {
				if (key === "debugProxy.enabled") return true
				if (key === "debugProxy.serverUrl") return "http://localhost:8080"
				if (key === "debugProxy.tlsInsecure") return false
				return ""
			})
			const context = createMockContext(vscode.ExtensionMode.Development)

			void initializeNetworkProxy(context, mockOutputChannel)

			expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined()
		})

		it("should disable TLS verification when tlsInsecure is enabled (debug mode only)", () => {
			mockConfig.get.mockImplementation((key: string) => {
				if (key === "debugProxy.enabled") return true
				if (key === "debugProxy.serverUrl") return "http://localhost:8080"
				if (key === "debugProxy.tlsInsecure") return true
				return ""
			})
			const context = createMockContext(vscode.ExtensionMode.Development)

			void initializeNetworkProxy(context, mockOutputChannel)

			expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("0")
		})

		it("should register configuration change listener in debug mode", () => {
			const context = createMockContext(vscode.ExtensionMode.Development)

			void initializeNetworkProxy(context, mockOutputChannel)

			expect(vscode.workspace.onDidChangeConfiguration).toHaveBeenCalled()
			expect(context.subscriptions.length).toBeGreaterThan(0)
		})

		it("should not register listeners in production mode (early exit)", () => {
			const context = createMockContext(vscode.ExtensionMode.Production)

			void initializeNetworkProxy(context, mockOutputChannel)

			expect(vscode.workspace.onDidChangeConfiguration).not.toHaveBeenCalled()
			expect(context.subscriptions.length).toBe(0)
		})

		it("should not throw in non-debug mode if proxy deps are not installed", () => {
			mockConfig.get.mockImplementation((key: string) => {
				if (key === "debugProxy.enabled") return true
				if (key === "debugProxy.serverUrl") return "http://localhost:8080"
				return ""
			})
			const context = createMockContext(vscode.ExtensionMode.Production)

			expect(() => {
				void initializeNetworkProxy(context, mockOutputChannel)
			}).not.toThrow()
		})

		// A failed activation does not guarantee deactivate() runs, so the disposable
		// initializeNetworkProxy returns must release every resource that was also registered on
		// context.subscriptions - a retained configuration listener could re-apply proxy and TLS
		// overrides inside a dead extension. The module is re-imported so the debug-mode resource
		// paths (listener, override cleanup, fetch patch) all execute: the latches that keep
		// global-agent bootstrap and the fetch patch one-shot would otherwise be tripped by
		// earlier tests, leaving a one-sided registration invisible to this equivalence check.
		it("should dispose every resource registered on context.subscriptions when the returned disposable is disposed", async () => {
			// Other tests in this file call initializeNetworkProxy without awaiting it, and a
			// debug-mode run patches global fetch only after its dynamic imports settle. Awaiting
			// one debug-mode run and one production-mode run here first: the awaited debug run
			// settles the module's one-shot fetch-patch latch, so any still-pending earlier run
			// skips its patch instead of racing this test's sentinel, and the trailing
			// production-mode run leaves the shared module on the extension context and
			// no-patch state the following tests expect.
			mockConfig.get.mockImplementation((key: string) => {
				if (key === "debugProxy.enabled") return true
				if (key === "debugProxy.serverUrl") return "http://localhost:8080"
				if (key === "debugProxy.tlsInsecure") return true
				return ""
			})
			const fetchBefore = globalThis.fetch
			try {
				await initializeNetworkProxy(createMockContext(vscode.ExtensionMode.Development), mockOutputChannel)
				await initializeNetworkProxy(createMockContext(vscode.ExtensionMode.Production), mockOutputChannel)

				vi.resetModules()
				// The runs above left the TLS override applied; drop it so the run under test
				// captures "unset" as its restore target.
				delete process.env.NODE_TLS_REJECT_UNAUTHORIZED

				// A local sentinel function stands in for the pre-patch global fetch: asserting
				// the restore comes back to this exact reference is deterministic regardless of
				// which fetch implementation is installed at this point.
				const fetchSentinel: typeof fetch = () => Promise.reject(new Error("sentinel fetch"))
				globalThis.fetch = fetchSentinel

				const freshModule = await import("../networkProxy")
				const freshVscode = await import("vscode")
				// resetModules re-runs the vscode mock factory, so the re-imported module reads
				// its configuration through a fresh getConfiguration spy that needs the stub.
				vi.mocked(freshVscode.workspace.getConfiguration).mockReturnValue(
					makeWorkspaceConfiguration({
						"debugProxy.enabled": true,
						"debugProxy.serverUrl": "http://localhost:8080",
						"debugProxy.tlsInsecure": true,
					}),
				)

				const context = createMockContext(vscode.ExtensionMode.Development)
				const returned = await freshModule.initializeNetworkProxy(context, mockOutputChannel)

				// Snapshot the registration side, then observe each registered object's own
				// dispose: the assertion below holds only if the returned aggregate releases the
				// same objects registered on context.subscriptions, which is the invariant.
				const registered = [...context.subscriptions]
				// Configuration listener, override cleanup, and the proxy-agent resource: the
				// scenario must register all three for the equivalence to cover every
				// acquisition.
				expect(registered.length).toBe(3)
				// Both observable overrides are applied before teardown.
				expect(globalThis.fetch).not.toBe(fetchSentinel)
				expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("0")

				const spiedDisposes = registered.map((resource) => vi.spyOn(resource, "dispose"))
				returned.dispose()

				for (const dispose of spiedDisposes) {
					expect(dispose).toHaveBeenCalledOnce()
				}
				// Teardown restores both observable overrides: fetch and the TLS setting.
				expect(globalThis.fetch).toBe(fetchSentinel)
				expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined()
			} finally {
				globalThis.fetch = fetchBefore
			}
		})

		// The proxy agent owns sockets, and both configure* helpers suspend on dynamic imports,
		// so teardown must close the agent and the import continuations must refuse to install
		// process-global state after disposal. Each test re-imports the module after
		// resetModules so the one-shot latches (global-agent bootstrap, fetch patch, dispatcher)
		// start untripped, as the aggregate-invariant test above does.
		describe("undici disposal and post-dispose import races", () => {
			// A dynamic import of a mocked module still resolves asynchronously, so
			// initializeNetworkProxy returns at its first await and the configure* continuations
			// run only once the test awaits it: disposing synchronously in between lands the
			// teardown while both imports are in flight, which is the interleaving the guards
			// must reject.
			function disposeMidFlight(context: vscode.ExtensionContext): void {
				// Only the configuration listener and the override cleanup are registered while
				// the imports are pending; disposing them is what VS Code does item-by-item on
				// unload, and it latches the module's disposed flag.
				expect(context.subscriptions).toHaveLength(2)
				context.subscriptions.forEach((subscription) => subscription.dispose())
			}

			// Re-imported module plus a development-mode context with the debug proxy enabled;
			// resetModules re-runs the vscode mock factory, so the fresh module's configuration
			// spy needs the stub before initializeNetworkProxy reads it. The mock spies are
			// shared across the file, so each test starts from a clean call log.
			async function freshDebugRunContext(): Promise<{
				freshModule: typeof import("../networkProxy")
				context: vscode.ExtensionContext
			}> {
				vi.clearAllMocks()
				mocks.proxyAgent.mockImplementation(function () {
					return { close: mocks.proxyAgentClose }
				})
				const freshModule = await import("../networkProxy")
				const freshVscode = await import("vscode")
				vi.mocked(freshVscode.workspace.getConfiguration).mockReturnValue(
					makeWorkspaceConfiguration({
						"debugProxy.enabled": true,
						"debugProxy.serverUrl": "http://localhost:8080",
						"debugProxy.tlsInsecure": false,
					}),
				)
				return { freshModule, context: createMockContext(vscode.ExtensionMode.Development) }
			}

			it("closes the proxy agent and restores the fetch patch when the returned disposable is disposed", async () => {
				vi.resetModules()
				const fetchBefore = globalThis.fetch
				const fetchSentinel: typeof fetch = () => Promise.reject(new Error("sentinel fetch"))
				globalThis.fetch = fetchSentinel
				try {
					const { freshModule, context } = await freshDebugRunContext()

					const returned = await freshModule.initializeNetworkProxy(context, mockOutputChannel)

					// Accept path: while the extension is alive the disposal guards are
					// transparent, and everything this module can install gets installed.
					expect(mocks.bootstrap).toHaveBeenCalledOnce()
					expect(mocks.setGlobalDispatcher).toHaveBeenCalledWith(
						expect.objectContaining({ close: mocks.proxyAgentClose }),
					)
					expect(globalThis.fetch).not.toBe(fetchSentinel)
					// Configuration listener, override cleanup, and the agent-owning undici
					// resource: the agent must be among the registered subscriptions for the
					// deactivate path to reach its close.
					expect(context.subscriptions).toHaveLength(3)

					returned.dispose()

					expect(mocks.proxyAgentClose).toHaveBeenCalledOnce()
					expect(globalThis.fetch).toBe(fetchSentinel)
				} finally {
					globalThis.fetch = fetchBefore
				}
			})

			it("logs and swallows a rejected agent close during teardown", async () => {
				vi.resetModules()
				const closeFailure = new Error("close failed")
				mocks.proxyAgentClose.mockRejectedValueOnce(closeFailure)
				const fetchBefore = globalThis.fetch
				globalThis.fetch = () => Promise.reject(new Error("sentinel fetch"))
				let returned: vscode.Disposable | undefined
				try {
					const { freshModule, context } = await freshDebugRunContext()

					returned = await freshModule.initializeNetworkProxy(context, mockOutputChannel)

					// A rejected close must not throw out of the synchronous dispose or leave an
					// unhandled rejection: the teardown logs it and continues releasing resources.
					expect(() => returned?.dispose()).not.toThrow()
					// The rejection is logged on the microtask the best-effort close awaits.
					await new Promise((resolve) => setTimeout(resolve, 0))
					expect(vi.mocked(mockOutputChannel.appendLine).mock.calls.flat().join("\n")).toContain(
						"Failed to close undici proxy agent: close failed",
					)
				} finally {
					returned?.dispose()
					globalThis.fetch = fetchBefore
				}
			})

			it("closes the agent only once when disposal runs through both owners", async () => {
				vi.resetModules()
				const fetchBefore = globalThis.fetch
				const fetchSentinel: typeof fetch = () => Promise.reject(new Error("sentinel fetch"))
				globalThis.fetch = fetchSentinel
				try {
					const { freshModule, context } = await freshDebugRunContext()

					const returned = await freshModule.initializeNetworkProxy(context, mockOutputChannel)

					// The undici resource is registered on context.subscriptions AND collected
					// in the aggregate disposable, so an activation-failure teardown can reach
					// it again after VS Code (or a re-disposal) already went through the list;
					// the close must still happen exactly once.
					returned.dispose()
					returned.dispose()
					context.subscriptions.forEach((subscription) => subscription.dispose())

					expect(mocks.proxyAgentClose).toHaveBeenCalledOnce()
					// Install plus the single conditional restore from the first dispose; the
					// once-guard keeps the repeated disposals from restoring or closing again.
					expect(mocks.setGlobalDispatcher).toHaveBeenCalledTimes(2)
					expect(mocks.dispatcherSlot.current).toBe(mocks.defaultDispatcher)
					expect(globalThis.fetch).toBe(fetchSentinel)
				} finally {
					globalThis.fetch = fetchBefore
				}
			})

			// The dispatcher that predates the install must be back in undici's global slot
			// after teardown, or every later fetch in a surviving extension host routes
			// through the closed proxy agent.
			it("restores the dispatcher captured at install time when the returned disposable is disposed", async () => {
				vi.resetModules()
				const fetchBefore = globalThis.fetch
				const fetchSentinel: typeof fetch = () => Promise.reject(new Error("sentinel fetch"))
				globalThis.fetch = fetchSentinel
				try {
					const { freshModule, context } = await freshDebugRunContext()

					const returned = await freshModule.initializeNetworkProxy(context, mockOutputChannel)

					const installed = mocks.dispatcherSlot.current
					expect(installed).not.toBe(mocks.defaultDispatcher)

					returned.dispose()

					// The captured pre-install dispatcher is back, not a fresh default or an
					// unset slot: this is dispatcher restoration, not fetch-function identity.
					expect(mocks.dispatcherSlot.current).toBe(mocks.defaultDispatcher)
					expect(mocks.setGlobalDispatcher).toHaveBeenLastCalledWith(mocks.defaultDispatcher)
					// Restore happens before the close, so no fetch started after teardown can
					// land on the closing agent.
					expect(mocks.setGlobalDispatcher.mock.invocationCallOrder[1]).toBeLessThan(
						mocks.proxyAgentClose.mock.invocationCallOrder[0],
					)
					expect(mocks.proxyAgentClose).toHaveBeenCalledOnce()
					expect(globalThis.fetch).toBe(fetchSentinel)
				} finally {
					globalThis.fetch = fetchBefore
				}
			})

			it("leaves a third-party dispatcher installed after ours untouched when disposal runs", async () => {
				vi.resetModules()
				const fetchBefore = globalThis.fetch
				const fetchSentinel: typeof fetch = () => Promise.reject(new Error("sentinel fetch"))
				globalThis.fetch = fetchSentinel
				try {
					const { freshModule, context } = await freshDebugRunContext()

					const returned = await freshModule.initializeNetworkProxy(context, mockOutputChannel)

					// Another component replaces the global slot after our install; that slot
					// belongs to its installer, so our teardown must leave it alone.
					const thirdPartyDispatcher = { close: vi.fn().mockResolvedValue(undefined) }
					mocks.setGlobalDispatcher(thirdPartyDispatcher)

					returned.dispose()

					expect(mocks.dispatcherSlot.current).toBe(thirdPartyDispatcher)
					// Install + third-party swap only: no restore call on this branch.
					expect(mocks.setGlobalDispatcher).toHaveBeenCalledTimes(2)
					expect(mocks.setGlobalDispatcher).toHaveBeenLastCalledWith(thirdPartyDispatcher)
					// The conditional restore does not skip closing the agent we own.
					expect(mocks.proxyAgentClose).toHaveBeenCalledOnce()
					expect(globalThis.fetch).toBe(fetchSentinel)
				} finally {
					globalThis.fetch = fetchBefore
				}
			})

			it("skips the global-agent bootstrap when disposal runs before the import settles", async () => {
				vi.resetModules()
				const fetchBefore = globalThis.fetch
				const fetchSentinel: typeof fetch = () => Promise.reject(new Error("sentinel fetch"))
				globalThis.fetch = fetchSentinel
				try {
					const { freshModule, context } = await freshDebugRunContext()

					const init = freshModule.initializeNetworkProxy(context, mockOutputChannel)
					disposeMidFlight(context)
					await init

					// Reject path for the global-agent suspension point: the late continuation
					// must not bootstrap global-agent for a disposed extension.
					expect(mocks.bootstrap).not.toHaveBeenCalled()
					expect(vi.mocked(mockOutputChannel.appendLine).mock.calls.flat().join("\n")).toContain(
						"global-agent import completed after disposal; skipping bootstrap",
					)
					expect(globalThis.fetch).toBe(fetchSentinel)
				} finally {
					globalThis.fetch = fetchBefore
				}
			})

			it("closes a late proxy agent without installing it when disposal runs before the undici import settles", async () => {
				vi.resetModules()
				const fetchBefore = globalThis.fetch
				const fetchSentinel: typeof fetch = () => Promise.reject(new Error("sentinel fetch"))
				globalThis.fetch = fetchSentinel
				try {
					const { freshModule, context } = await freshDebugRunContext()

					const init = freshModule.initializeNetworkProxy(context, mockOutputChannel)
					disposeMidFlight(context)
					await init

					// Reject path for the undici suspension point: the agent is constructed only
					// once the import settles - after teardown - so the guard must close it and
					// install nothing: no dispatcher swap, no fetch patch for a dead extension.
					expect(mocks.proxyAgent).toHaveBeenCalledOnce()
					expect(mocks.proxyAgentClose).toHaveBeenCalledOnce()
					expect(mocks.setGlobalDispatcher).not.toHaveBeenCalled()
					expect(vi.mocked(mockOutputChannel.appendLine).mock.calls.flat().join("\n")).toContain(
						"undici import completed after disposal; closing the late proxy agent without installing it",
					)
					expect(globalThis.fetch).toBe(fetchSentinel)
				} finally {
					globalThis.fetch = fetchBefore
				}
			})
		})

		// When the proxy is disabled at activation, only the configuration-change listener
		// can build the dispatcher agent later; the aggregate disposable must own that
		// listener-created resource too, or a mid-session enable survives the teardown a
		// failed activation performs. Each test runs on a reset module instance so the
		// shared latches start untripped, as in the disposal tests.
		describe("listener-path agent ownership", () => {
			// Fresh module instance whose activation starts with the proxy disabled; the
			// configuration record is mutable so a test can flip debugProxy.enabled before
			// firing the captured configuration-change listener.
			async function freshToggledRunContext(): Promise<{
				freshModule: typeof import("../networkProxy")
				context: vscode.ExtensionContext
				configValues: Record<string, unknown>
				fireConfigChange: () => void
			}> {
				vi.clearAllMocks()
				const configValues: Record<string, unknown> = {
					"debugProxy.enabled": false,
					"debugProxy.serverUrl": "http://localhost:8080",
					"debugProxy.tlsInsecure": false,
				}
				const freshModule = await import("../networkProxy")
				const freshVscode = await import("vscode")
				vi.mocked(freshVscode.workspace.getConfiguration).mockReturnValue(
					makeWorkspaceConfiguration(configValues),
				)
				let configListener:
					((event: { affectsConfiguration: (section: string) => boolean }) => void) | undefined
				vi.mocked(freshVscode.workspace.onDidChangeConfiguration).mockImplementation((listener) => {
					configListener = listener as typeof configListener
					return { dispose: vi.fn() }
				})
				const context = createMockContext(vscode.ExtensionMode.Development)
				return {
					freshModule,
					context,
					configValues,
					fireConfigChange: () => configListener?.({ affectsConfiguration: () => true }),
				}
			}

			it("closes the listener-created agent exactly once when the aggregate disposable is disposed", async () => {
				vi.resetModules()
				const fetchBefore = globalThis.fetch
				const fetchSentinel: typeof fetch = () => Promise.reject(new Error("sentinel fetch"))
				globalThis.fetch = fetchSentinel
				try {
					const { freshModule, context, configValues, fireConfigChange } = await freshToggledRunContext()

					const returned = await freshModule.initializeNetworkProxy(context, mockOutputChannel)

					// Activation with the proxy disabled registers only the listener and the
					// override cleanup; no agent is built yet.
					expect(context.subscriptions).toHaveLength(2)
					expect(mocks.proxyAgent).not.toHaveBeenCalled()

					configValues["debugProxy.enabled"] = true
					fireConfigChange()
					// The listener's configure* calls resolve on their own microtasks.
					await vi.waitFor(() => expect(mocks.proxyAgent).toHaveBeenCalledOnce())
					expect(mocks.setGlobalDispatcher).toHaveBeenCalledOnce()
					expect(mocks.dispatcherSlot.current).not.toBe(mocks.defaultDispatcher)
					expect(globalThis.fetch).not.toBe(fetchSentinel)

					returned.dispose()

					// The aggregate owns the agent the listener created: its close and the
					// dispatcher restore run here, not at toggle time.
					expect(mocks.proxyAgentClose).toHaveBeenCalledOnce()
					expect(mocks.dispatcherSlot.current).toBe(mocks.defaultDispatcher)
					expect(globalThis.fetch).toBe(fetchSentinel)

					// Re-disposal through the same owner must not close a second time.
					returned.dispose()
					expect(mocks.proxyAgentClose).toHaveBeenCalledOnce()
				} finally {
					globalThis.fetch = fetchBefore
				}
			})

			it("closes an agent created by a post-dispose listener event without installing it", async () => {
				vi.resetModules()
				const fetchBefore = globalThis.fetch
				const fetchSentinel: typeof fetch = () => Promise.reject(new Error("sentinel fetch"))
				globalThis.fetch = fetchSentinel
				try {
					const { freshModule, context, configValues, fireConfigChange } = await freshToggledRunContext()

					await freshModule.initializeNetworkProxy(context, mockOutputChannel)
					configValues["debugProxy.enabled"] = true

					// Disposing first, then toggling, is the interleaving that a settings
					// event can still deliver after a failed activation tore everything down.
					context.subscriptions.forEach((subscription) => subscription.dispose())
					fireConfigChange()

					// The disposal latch rejects the late continuation: the agent is closed
					// without ever being installed, so no new agent leaks into the process.
					await vi.waitFor(() => expect(mocks.proxyAgent).toHaveBeenCalledOnce())
					expect(mocks.proxyAgentClose).toHaveBeenCalledOnce()
					expect(mocks.setGlobalDispatcher).not.toHaveBeenCalled()
					expect(mocks.dispatcherSlot.current).toBe(mocks.defaultDispatcher)
					expect(mocks.bootstrap).not.toHaveBeenCalled()
					expect(vi.mocked(mockOutputChannel.appendLine).mock.calls.flat().join("\n")).toContain(
						"undici import completed after disposal; closing the late proxy agent without installing it",
					)
					expect(globalThis.fetch).toBe(fetchSentinel)
				} finally {
					globalThis.fetch = fetchBefore
				}
			})

			// Two debugProxy config events fired inside the `await import("undici")` window both
			// pass the already-configured check ahead of the import. Only the first may install:
			// a second install would capture the first agent as its "previous dispatcher", and
			// that teardown would then restore a closed agent into undici's global slot.
			// doMock keeps the undici factory pending so the first event is verifiably parked
			// at its import while the second event passes the latch check; the file-level static
			// mock cannot provide that window because its module is already resolved in every
			// later test.
			it("closes the second of two config events fired inside the undici import window", async () => {
				vi.resetModules()
				const fetchBefore = globalThis.fetch
				const fetchSentinel: typeof fetch = () => Promise.reject(new Error("sentinel fetch"))
				globalThis.fetch = fetchSentinel
				let releaseImport: () => void = () => {}
				const importPending = new Promise<void>((resolve) => {
					releaseImport = resolve
				})
				vi.doMock("undici", () =>
					importPending.then(() => ({
						ProxyAgent: mocks.proxyAgent,
						setGlobalDispatcher: mocks.setGlobalDispatcher,
						getGlobalDispatcher: mocks.getGlobalDispatcher,
						fetch: mocks.undiciFetch,
					})),
				)
				try {
					const { freshModule, context, configValues, fireConfigChange } = await freshToggledRunContext()
					// Once-implementations so the per-agent close spies do not leak past this
					// test: the shared file-level spy cannot say *which* of the two agents a
					// close came from, and this witness turns on that distinction. Exactly two
					// constructions occur, consuming both queued implementations.
					const agents: Array<{ close: ReturnType<typeof vi.fn> }> = []
					const recordAgent = function (this: unknown) {
						const close = vi.fn().mockResolvedValue(undefined)
						const agent = { close }
						agents.push(agent)
						return agent
					}
					mocks.proxyAgent.mockImplementationOnce(recordAgent).mockImplementationOnce(recordAgent)

					const returned = await freshModule.initializeNetworkProxy(context, mockOutputChannel)
					configValues["debugProxy.enabled"] = true

					fireConfigChange()
					// The first event is now parked in configureUndiciProxy's import: the pending
					// factory keeps it suspended while the module registration settles, so the
					// second event demonstrably passes the latch check mid-flight.
					await new Promise((resolve) => setTimeout(resolve, 10))
					expect(mocks.proxyAgent).not.toHaveBeenCalled()
					fireConfigChange()
					releaseImport()

					await vi.waitFor(() => expect(mocks.proxyAgent).toHaveBeenCalledTimes(2))
					expect(agents).toHaveLength(2)

					// Accept path: the first event installs and owns the global slot.
					expect(mocks.dispatcherSlot.current).toBe(agents[0])
					expect(mocks.setGlobalDispatcher).toHaveBeenCalledOnce()
					expect(mocks.setGlobalDispatcher).toHaveBeenCalledWith(agents[0])

					// Reject path: the second event aborts at the post-import latch re-check —
					// it never reaches the previous-dispatcher capture (one getGlobalDispatcher
					// call: the first capture; dispose below adds the restore check), and its
					// agent is closed without ever entering the dispatcher slot.
					expect(mocks.getGlobalDispatcher).toHaveBeenCalledTimes(1)
					expect(agents[1].close).toHaveBeenCalledOnce()
					// The aborted call registers no resource, so the first install's disposable
					// remains the only teardown path for the slot.
					expect(context.subscriptions).toHaveLength(3)

					returned.dispose()

					// The owning disposable restores the dispatcher it captured (the default),
					// not the closed agent a double install would have recorded.
					expect(agents[0].close).toHaveBeenCalledOnce()
					expect(mocks.dispatcherSlot.current).toBe(mocks.defaultDispatcher)
					expect(mocks.setGlobalDispatcher).toHaveBeenLastCalledWith(mocks.defaultDispatcher)
				} finally {
					// Re-register a synchronous factory with the same spies and drop the cached
					// module: tests running after this one then resolve undici exactly as they
					// do through the file-level mock (unmocking instead would expose the real
					// package to those tests, and the pending-import factory above is now
					// permanently bypassed).
					vi.doMock("undici", () => ({
						ProxyAgent: mocks.proxyAgent,
						setGlobalDispatcher: mocks.setGlobalDispatcher,
						getGlobalDispatcher: mocks.getGlobalDispatcher,
						fetch: mocks.undiciFetch,
					}))
					vi.resetModules()
					globalThis.fetch = fetchBefore
				}
			})
		})

		// The configuration-change listener re-runs the configure* helpers when the debug proxy
		// is toggled on mid-session. Both helpers are latched (bootstrap and dispatcher are
		// one-shot), so after a successful activation the listener path re-enters them and
		// returns through their already-configured branches; without this test those call
		// sites would never execute. Runs on a reset module instance so the shared latches
		// start untripped, as in the disposal tests.
		it("re-runs both configure paths without re-installing when the proxy is toggled on again", async () => {
			vi.resetModules()
			const freshModule = await import("../networkProxy")
			const freshVscode = await import("vscode")
			vi.mocked(freshVscode.workspace.getConfiguration).mockReturnValue(
				makeWorkspaceConfiguration({
					"debugProxy.enabled": true,
					"debugProxy.serverUrl": "http://localhost:8080",
					"debugProxy.tlsInsecure": false,
				}),
			)
			let configListener: ((event: { affectsConfiguration: (section: string) => boolean }) => void) | undefined
			vi.mocked(freshVscode.workspace.onDidChangeConfiguration).mockImplementation((listener) => {
				configListener = listener as typeof configListener
				return { dispose: vi.fn() }
			})
			const context = createMockContext(vscode.ExtensionMode.Development)

			await freshModule.initializeNetworkProxy(context, mockOutputChannel)
			vi.clearAllMocks()

			expect(configListener).toBeTypeOf("function")
			configListener?.({ affectsConfiguration: () => true })
			// The re-entrant calls resolve on their own microtasks.
			await new Promise((resolve) => setTimeout(resolve, 0))

			// Nothing is installed twice: bootstrap and the dispatcher swap stay one-shot, and
			// the log records both "already configured" branches rather than a failure.
			expect(mocks.bootstrap).not.toHaveBeenCalled()
			expect(mocks.setGlobalDispatcher).not.toHaveBeenCalled()
			const logged = vi.mocked(mockOutputChannel.appendLine).mock.calls.flat().join("\n")
			expect(logged).toContain("Proxy already initialized, updating env vars only")
			expect(logged).toContain("undici global dispatcher already configured")
		})

		// A second initialize on the same module instance reaches configureUndiciProxy through
		// the already-configured latch, which returns no resource: the aggregate then collects
		// only the listener and the override cleanup, and disposing it must not touch the agent
		// owned by the first activation.
		it("collects no agent resource on a re-initialization while the dispatcher latch is tripped", async () => {
			vi.resetModules()
			vi.clearAllMocks()
			const fetchBefore = globalThis.fetch
			globalThis.fetch = () => Promise.reject(new Error("sentinel fetch"))
			try {
				const freshModule = await import("../networkProxy")
				const freshVscode = await import("vscode")
				vi.mocked(freshVscode.workspace.getConfiguration).mockReturnValue(
					makeWorkspaceConfiguration({
						"debugProxy.enabled": true,
						"debugProxy.serverUrl": "http://localhost:8080",
						"debugProxy.tlsInsecure": false,
					}),
				)

				const context = createMockContext(vscode.ExtensionMode.Development)
				const first = await freshModule.initializeNetworkProxy(context, mockOutputChannel)
				expect(context.subscriptions).toHaveLength(3)

				const secondContext = createMockContext(vscode.ExtensionMode.Development)
				const second = await freshModule.initializeNetworkProxy(secondContext, mockOutputChannel)

				// configureUndiciProxy returned undefined for the second run, so only the listener
				// and the override cleanup are registered there.
				expect(secondContext.subscriptions).toHaveLength(2)

				second.dispose()
				// The first activation still owns the agent; the second teardown must not close it.
				expect(mocks.proxyAgentClose).not.toHaveBeenCalled()

				first.dispose()
				expect(mocks.proxyAgentClose).toHaveBeenCalledOnce()
			} finally {
				globalThis.fetch = fetchBefore
			}
		})
	})

	describe("getProxyConfig", () => {
		it("should return default config before initialization", () => {
			// Reset the module to clear internal state
			vi.resetModules()

			const config = getProxyConfig()

			expect(config.enabled).toBe(false)
			expect(config.serverUrl).toBe("http://127.0.0.1:8888") // default value
			expect(config.isDebugMode).toBe(false)
		})

		it("should return correct config after initialization", () => {
			mockConfig.get.mockImplementation((key: string) => {
				if (key === "debugProxy.enabled") return true
				if (key === "debugProxy.serverUrl") return "http://proxy.example.com:3128"
				if (key === "debugProxy.tlsInsecure") return true
				return ""
			})
			const context = createMockContext(vscode.ExtensionMode.Production)

			void initializeNetworkProxy(context, mockOutputChannel)
			const config = getProxyConfig()

			expect(config.enabled).toBe(true)
			expect(config.serverUrl).toBe("http://proxy.example.com:3128")
			expect(config.tlsInsecure).toBe(true)
			expect(config.isDebugMode).toBe(false)
		})

		it("should trim whitespace from server URL", () => {
			mockConfig.get.mockImplementation((key: string) => {
				if (key === "debugProxy.serverUrl") return "  http://proxy.example.com:3128  "
				return ""
			})
			const context = createMockContext()

			void initializeNetworkProxy(context, mockOutputChannel)
			const config = getProxyConfig()

			expect(config.serverUrl).toBe("http://proxy.example.com:3128")
		})

		it("should return default URL for empty server URL", () => {
			mockConfig.get.mockImplementation((key: string) => {
				if (key === "debugProxy.serverUrl") return "   "
				return ""
			})
			const context = createMockContext()

			void initializeNetworkProxy(context, mockOutputChannel)
			const config = getProxyConfig()

			expect(config.serverUrl).toBe("http://127.0.0.1:8888") // falls back to default
		})
	})

	describe("isProxyEnabled", () => {
		it("should return false when proxy is not enabled", () => {
			mockConfig.get.mockImplementation((key: string) => {
				if (key === "debugProxy.enabled") return false
				return ""
			})
			const context = createMockContext()

			void initializeNetworkProxy(context, mockOutputChannel)

			expect(isProxyEnabled()).toBe(false)
		})

		it("should return true when proxy is enabled in debug mode", () => {
			mockConfig.get.mockImplementation((key: string) => {
				if (key === "debugProxy.enabled") return true
				if (key === "debugProxy.serverUrl") return "http://localhost:8080"
				return ""
			})
			// Proxy is only applied in debug mode.
			const context = createMockContext(vscode.ExtensionMode.Development)

			void initializeNetworkProxy(context, mockOutputChannel)

			expect(isProxyEnabled()).toBe(true)
		})
	})

	describe("isDebugMode", () => {
		it("should return false in production mode", () => {
			const context = createMockContext(vscode.ExtensionMode.Production)

			void initializeNetworkProxy(context, mockOutputChannel)

			expect(isDebugMode()).toBe(false)
		})

		it("should return true in development mode", () => {
			const context = createMockContext(vscode.ExtensionMode.Development)

			void initializeNetworkProxy(context, mockOutputChannel)

			expect(isDebugMode()).toBe(true)
		})

		// Note: This test is skipped because module state persists across tests.
		// In a real scenario, isDebugMode() returns false before any initialization.
		// The actual behavior is verified in integration testing.
		it.skip("should return false before initialization", () => {
			// This would require full module isolation which isn't practical here
			expect(isDebugMode()).toBe(false)
		})
	})

	describe("security", () => {
		it("should not disable TLS verification unless tlsInsecure is enabled", () => {
			mockConfig.get.mockImplementation((key: string) => {
				if (key === "debugProxy.enabled") return true
				if (key === "debugProxy.serverUrl") return "http://localhost:8080"
				if (key === "debugProxy.tlsInsecure") return false
				return ""
			})
			const context = createMockContext(vscode.ExtensionMode.Development)

			void initializeNetworkProxy(context, mockOutputChannel)

			expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined()
		})
	})

	describe("getSystemProxyUrl", () => {
		beforeEach(() => {
			vi.clearAllMocks()
			// Clear all proxy env vars and VS Code setting before each test
			delete process.env.HTTPS_PROXY
			delete process.env.https_proxy
			delete process.env.HTTP_PROXY
			delete process.env.http_proxy
			delete process.env.NO_PROXY
			delete process.env.no_proxy
			mockConfig.get.mockReturnValue(undefined)
		})

		it("should return proxy from HTTPS_PROXY env var", () => {
			process.env.HTTPS_PROXY = "http://proxy.corp:3128"
			const result = getSystemProxyUrl()
			expect(result).toBe("http://proxy.corp:3128")
		})

		it("should return proxy from https_proxy env var when HTTPS_PROXY not set", () => {
			process.env.https_proxy = "http://proxy.corp:3128"
			const result = getSystemProxyUrl()
			expect(result).toBe("http://proxy.corp:3128")
		})

		it("should return proxy from HTTP_PROXY env var as fallback", () => {
			process.env.HTTP_PROXY = "http://proxy.corp:8080"
			const result = getSystemProxyUrl()
			expect(result).toBe("http://proxy.corp:8080")
		})

		it("should return trimmed proxy from VS Code setting", () => {
			mockConfig.get.mockImplementation((key: string) => {
				if (key === "proxy") return "  http://proxy.corp:3128  "
				return ""
			})
			const result = getSystemProxyUrl()
			expect(result).toBe("http://proxy.corp:3128")
		})

		it("should return undefined when no proxy configured", () => {
			mockConfig.get.mockReturnValue(undefined)
			const result = getSystemProxyUrl()
			expect(result).toBeUndefined()
		})

		it("should handle VS Code API errors gracefully", () => {
			vi.mocked(vscode.workspace.getConfiguration).mockImplementation(() => {
				throw new Error("VS Code API unavailable")
			})
			const result = getSystemProxyUrl()
			expect(result).toBeUndefined()
		})

		it("should not return empty string proxy", () => {
			mockConfig.get.mockReturnValue("")
			const result = getSystemProxyUrl()
			expect(result).toBeUndefined()
		})

		it("should prioritize env vars over VS Code settings", () => {
			process.env.HTTPS_PROXY = "http://env-proxy:3128"
			mockConfig.get.mockReturnValue("http://vscode-proxy:8080")
			const result = getSystemProxyUrl()
			expect(result).toBe("http://env-proxy:3128")
		})

		it("should trim whitespace from env var proxy values", () => {
			process.env.HTTPS_PROXY = "  http://proxy.corp:3128  "
			const result = getSystemProxyUrl()
			expect(result).toBe("http://proxy.corp:3128")
		})

		it("should reject whitespace-only proxy values", () => {
			process.env.HTTPS_PROXY = "   "
			const result = getSystemProxyUrl()
			expect(result).toBeUndefined()
		})

		it("should skip empty env var and try next fallback", () => {
			process.env.HTTP_PROXY = "  http://http-proxy:3128  "
			const result = getSystemProxyUrl()
			expect(result).toBe("http://http-proxy:3128")
		})

		it("should use VS Code setting when all env vars are empty", () => {
			mockConfig.get.mockReturnValue("  http://vscode-proxy:8080  ")
			const result = getSystemProxyUrl()
			expect(result).toBe("http://vscode-proxy:8080")
		})

		describe("NO_PROXY handling", () => {
			it("should bypass proxy when NO_PROXY exactly matches the target host", () => {
				process.env.HTTPS_PROXY = "http://proxy.corp:3128"
				process.env.NO_PROXY = "bedrock.vpce.internal"
				const result = getSystemProxyUrl("https://bedrock.vpce.internal")
				expect(result).toBeUndefined()
			})

			it("should bypass proxy when NO_PROXY is a domain suffix of the target host", () => {
				process.env.HTTPS_PROXY = "http://proxy.corp:3128"
				process.env.NO_PROXY = "amazonaws.com"
				const result = getSystemProxyUrl("https://bedrock-runtime.us-east-1.amazonaws.com")
				expect(result).toBeUndefined()
			})

			it("should bypass proxy for all hosts when NO_PROXY is '*'", () => {
				process.env.HTTPS_PROXY = "http://proxy.corp:3128"
				process.env.NO_PROXY = "*"
				const result = getSystemProxyUrl("https://bedrock-runtime.us-east-1.amazonaws.com")
				expect(result).toBeUndefined()
			})

			it("should use the proxy when NO_PROXY does not match the target host", () => {
				process.env.HTTPS_PROXY = "http://proxy.corp:3128"
				process.env.NO_PROXY = "example.com"
				const result = getSystemProxyUrl("https://bedrock-runtime.us-east-1.amazonaws.com")
				expect(result).toBe("http://proxy.corp:3128")
			})

			it("should handle leading dot and trailing port in NO_PROXY entries", () => {
				process.env.HTTPS_PROXY = "http://proxy.corp:3128"
				process.env.NO_PROXY = ".amazonaws.com:443"
				const result = getSystemProxyUrl("https://bedrock-runtime.us-east-1.amazonaws.com")
				expect(result).toBeUndefined()
			})

			it("should match one entry out of a comma-separated NO_PROXY list", () => {
				process.env.HTTPS_PROXY = "http://proxy.corp:3128"
				process.env.NO_PROXY = "example.com, amazonaws.com, other.net"
				const result = getSystemProxyUrl("https://bedrock-runtime.us-east-1.amazonaws.com")
				expect(result).toBeUndefined()
			})

			it("should use the proxy when no entry in a comma-separated NO_PROXY list matches", () => {
				process.env.HTTPS_PROXY = "http://proxy.corp:3128"
				process.env.NO_PROXY = "example.com, foo.net, other.org"
				const result = getSystemProxyUrl("https://bedrock-runtime.us-east-1.amazonaws.com")
				expect(result).toBe("http://proxy.corp:3128")
			})

			it("should also bypass the VS Code proxy when NO_PROXY matches", () => {
				process.env.NO_PROXY = "amazonaws.com"
				mockConfig.get.mockReturnValue("http://vscode-proxy:8080")
				const result = getSystemProxyUrl("https://bedrock-runtime.us-east-1.amazonaws.com")
				expect(result).toBeUndefined()
			})

			it("should ignore NO_PROXY when no target URL is provided", () => {
				process.env.HTTPS_PROXY = "http://proxy.corp:3128"
				process.env.NO_PROXY = "*"
				const result = getSystemProxyUrl()
				expect(result).toBe("http://proxy.corp:3128")
			})

			it("should not bypass when target URL is malformed", () => {
				process.env.HTTPS_PROXY = "http://proxy.corp:3128"
				process.env.NO_PROXY = "amazonaws.com"
				const result = getSystemProxyUrl("not-a-valid-url")
				expect(result).toBe("http://proxy.corp:3128")
			})
		})
	})

	describe("createProxyRoutingRequestHandler", () => {
		type Handler = NonNullable<ReturnType<typeof createProxyRoutingRequestHandler>>

		// The handler reads only these fields off the request. Building a real HttpRequest would
		// pull in @smithy/protocol-http, which is not a direct dependency, so a literal stands in.
		const requestTo = (hostname: string, port?: number) =>
			({ protocol: "https:", hostname, port }) as unknown as Parameters<Handler["handle"]>[0]

		// The two inner handlers are told apart by how they were built: only the proxied one
		// receives agents.
		const innerHandlers = () => {
			const built = vi.mocked(NodeHttpHandler).mock.results.map((r) => r.value)
			return {
				direct: built.find((h) => h.options === undefined),
				proxied: built.find((h) => h.options?.httpsAgent),
			}
		}

		beforeEach(() => {
			vi.clearAllMocks()
			delete process.env.HTTPS_PROXY
			delete process.env.https_proxy
			delete process.env.HTTP_PROXY
			delete process.env.http_proxy
			delete process.env.NO_PROXY
			delete process.env.no_proxy
			mockConfig.get.mockReturnValue(undefined)
		})

		it("should return undefined when no proxy is configured", () => {
			expect(createProxyRoutingRequestHandler()).toBeUndefined()
			expect(NodeHttpHandler).not.toHaveBeenCalled()
		})

		it("should build both proxy agents with the keep-alive defaults of the direct route", () => {
			process.env.HTTPS_PROXY = "http://proxy.corp:3128"

			expect(createProxyRoutingRequestHandler()).toBeDefined()

			const agentOptions = { keepAlive: true, maxSockets: 50 }
			expect(HttpProxyAgent).toHaveBeenCalledWith("http://proxy.corp:3128", agentOptions)
			expect(HttpsProxyAgent).toHaveBeenCalledWith("http://proxy.corp:3128", agentOptions)
			const { proxied } = innerHandlers()
			expect(proxied?.options?.httpAgent).toBe(vi.mocked(HttpProxyAgent).mock.instances[0])
			expect(proxied?.options?.httpsAgent).toBe(vi.mocked(HttpsProxyAgent).mock.instances[0])
		})

		it("should send a request through the proxy when NO_PROXY does not cover it", async () => {
			process.env.HTTPS_PROXY = "http://proxy.corp:3128"
			process.env.NO_PROXY = "example.com"

			const handler = createProxyRoutingRequestHandler()
			const { direct, proxied } = innerHandlers()
			const response = { response: { statusCode: 200 } }
			proxied?.handle.mockResolvedValue(response)

			// The request options carry the abort signal and timeout, so they must reach the route.
			const request = requestTo("bedrock-runtime.us-east-1.amazonaws.com")
			const requestOptions = { abortSignal: new AbortController().signal, requestTimeout: 1234 }
			const result = handler?.handle(request, requestOptions)

			expect(proxied?.handle).toHaveBeenCalledWith(request, requestOptions)
			expect(direct?.handle).not.toHaveBeenCalled()
			await expect(result).resolves.toBe(response)
		})

		it("should send a request directly when NO_PROXY covers its host", async () => {
			process.env.HTTPS_PROXY = "http://proxy.corp:3128"
			process.env.NO_PROXY = "amazonaws.com"

			const handler = createProxyRoutingRequestHandler()
			const { direct, proxied } = innerHandlers()
			const response = { response: { statusCode: 200 } }
			direct?.handle.mockResolvedValue(response)

			// The host is only known per request, which is the point of deciding here: indexed
			// file contents must not reach a proxy the user excluded.
			const request = requestTo("bedrock-runtime.eu-west-1.amazonaws.com")
			const requestOptions = { abortSignal: new AbortController().signal, requestTimeout: 1234 }
			const result = handler?.handle(request, requestOptions)

			expect(direct?.handle).toHaveBeenCalledWith(request, requestOptions)
			expect(proxied?.handle).not.toHaveBeenCalled()
			await expect(result).resolves.toBe(response)
		})

		it("should send every request directly when NO_PROXY is '*'", () => {
			process.env.HTTPS_PROXY = "http://proxy.corp:3128"
			process.env.NO_PROXY = "*"

			const handler = createProxyRoutingRequestHandler()
			handler?.handle(requestTo("bedrock-runtime.us-east-1.amazonaws.com"))

			const { direct, proxied } = innerHandlers()
			expect(direct?.handle).toHaveBeenCalledOnce()
			expect(proxied?.handle).not.toHaveBeenCalled()
		})

		it("should match NO_PROXY against the host when the request carries a port", () => {
			process.env.HTTPS_PROXY = "http://proxy.corp:3128"
			process.env.NO_PROXY = "amazonaws.com"

			const handler = createProxyRoutingRequestHandler()
			handler?.handle(requestTo("bedrock-runtime.us-east-1.amazonaws.com", 8443))

			const { direct, proxied } = innerHandlers()
			expect(direct?.handle).toHaveBeenCalledOnce()
			expect(proxied?.handle).not.toHaveBeenCalled()
		})

		it("should forward configuration updates and teardown to both routes", () => {
			process.env.HTTPS_PROXY = "http://proxy.corp:3128"

			const handler = createProxyRoutingRequestHandler()
			handler?.updateHttpClientConfig("requestTimeout", 1234)
			handler?.destroy()

			const { direct, proxied } = innerHandlers()
			expect(direct?.updateHttpClientConfig).toHaveBeenCalledWith("requestTimeout", 1234)
			expect(proxied?.updateHttpClientConfig).toHaveBeenCalledWith("requestTimeout", 1234)
			expect(direct?.destroy).toHaveBeenCalledOnce()
			expect(proxied?.destroy).toHaveBeenCalledOnce()
		})
	})
})
