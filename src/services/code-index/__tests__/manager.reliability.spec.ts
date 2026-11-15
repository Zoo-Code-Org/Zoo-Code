import * as path from "path"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"
import type * as vscode from "vscode"
import { CodeIndexManager } from "../manager"
import { CodeIndexStateManager } from "../state-manager"
import { CacheManager, CacheReadError } from "../cache-manager"
import type { CodeIndexOrchestrator } from "../orchestrator"
import { WorkspaceIndexingEnablementManager } from "../workspace-indexing-enablement-manager"

vi.mock("vscode", () => {
	const emitter = function () {
		const listeners = new Set<(value: unknown) => void>()
		return {
			event: (listener: (value: unknown) => void) => {
				listeners.add(listener)
				return { dispose: () => listeners.delete(listener) }
			},
			fire: (value: unknown) => listeners.forEach((listener) => listener(value)),
			dispose: () => listeners.clear(),
		}
	}
	return {
		EventEmitter: vi.fn().mockImplementation(emitter),
		Uri: { joinPath: vi.fn(() => ({ fsPath: "/storage/cache.json" })) },
		workspace: { fs: { readFile: vi.fn() } },
	}
})
vi.mock("@roo-code/telemetry", () => ({ TelemetryService: { instance: { captureEvent: vi.fn() } } }))
const replacementOrder = vi.hoisted(() => [] as string[])
vi.mock("../semble", () => ({
	SembleProvider: vi.fn().mockImplementation(function () {
		replacementOrder.push("recreate")
		return { initialize: vi.fn(async () => {}), dispose: vi.fn(), stopIndexing: vi.fn() }
	}),
}))
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))
// Real service recreation runs in CI-MG-07; these doubles stand in for the services it builds.
vi.mock("../service-factory", () => ({
	CodeIndexServiceFactory: vi.fn().mockImplementation(function () {
		return { createServices: () => ({ embedder: {}, vectorStore: {}, scanner: {}, fileWatcher: {} }) }
	}),
}))
vi.mock("../orchestrator", () => ({
	CodeIndexOrchestrator: vi.fn().mockImplementation(function () {
		return { stopIndexing: async () => {}, startIndexing: async () => {}, isScanning: false }
	}),
}))
vi.mock("../search-service", () => ({
	CodeIndexSearchService: vi.fn().mockImplementation(function () {
		return {}
	}),
}))
vi.mock("../../../core/ignore/RooIgnoreController", () => ({
	RooIgnoreController: vi.fn().mockImplementation(function () {
		return { initialize: async () => {} }
	}),
}))
vi.mock("../config-manager", () => ({
	CodeIndexConfigManager: vi.fn().mockImplementation(function (contextProxy: unknown) {
		return {
			isFeatureEnabled: true,
			isFeatureConfigured: true,
			currentEmbedderProvider: providerIdentifiers.openai,
			loadConfiguration: async () => ({ requiresRestart: false }),
			getContextProxy: () => contextProxy,
		}
	}),
}))

const workspacePath = path.join(path.sep, "test", "workspace")

type OrchestratorDouble = Pick<CodeIndexOrchestrator, "startIndexing" | "stopIndexing" | "isScanning" | "state">

function makeManager() {
	const store = new Map<string, unknown>()
	const memento = {
		get: (key: string, fallback?: unknown) => (store.has(key) ? store.get(key) : fallback),
		update: async (key: string, value: unknown) => void store.set(key, value),
	}
	// The double provides only the context members the manager and cache manager read.
	const context = {
		workspaceState: memento,
		globalState: memento,
		globalStorageUri: { fsPath: "/storage" },
	} as unknown as vscode.ExtensionContext
	const folderUri = { toString: () => `file://${workspacePath}` } as unknown as vscode.Uri
	const stateManager = new CodeIndexStateManager()
	const manager = new CodeIndexManager(workspacePath, folderUri, context, stateManager)
	// Feature enablement is read from the config manager; these tests only need it to report enabled.
	manager["_configManager"] = {
		isFeatureEnabled: true,
		isFeatureConfigured: true,
	} as unknown as (typeof manager)["_configManager"]
	manager["_cacheManager"] = {} as unknown as CacheManager
	manager["_searchService"] = {} as unknown as (typeof manager)["_searchService"]
	return { manager, stateManager }
}

function attach(manager: CodeIndexManager, orchestrator: OrchestratorDouble) {
	// The double provides only start/stop/isScanning/state.
	manager["_orchestrator"] = orchestrator as unknown as CodeIndexOrchestrator
}

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => (resolve = done))
	return { promise, resolve }
}

describe("CodeIndexManager reliability", () => {
	it("CI-MG-01: a repeated start joins the running start", async () => {
		const { manager } = makeManager()
		const running = deferred()
		const orchestrator: OrchestratorDouble = {
			startIndexing: vi.fn(() => running.promise),
			stopIndexing: vi.fn(async () => {}),
			isScanning: true,
			state: "Indexing",
		}
		attach(manager, orchestrator)

		const first = manager.startIndexing()
		const second = manager.startIndexing()
		running.resolve()
		await Promise.all([first, second])
		expect(orchestrator.startIndexing).toHaveBeenCalledOnce()
	})

	it("CI-MG-01: a start while stopping waits for the stop, then starts", async () => {
		const { manager } = makeManager()
		const stopping = deferred()
		const order: string[] = []
		let stopPromise: Promise<void> | undefined
		const orchestrator: OrchestratorDouble = {
			// Mirrors the orchestrator contract: a start while stopping awaits the stop first.
			startIndexing: vi.fn(async () => {
				if (stopPromise) await stopPromise
				order.push("start")
			}),
			stopIndexing: vi.fn(() => {
				stopPromise = stopping.promise.then(() => void order.push("stopped"))
				return stopPromise
			}),
			isScanning: false,
			state: "Stopping",
		}
		attach(manager, orchestrator)

		const stop = manager.stopIndexing()
		const start = manager.startIndexing()
		stopping.resolve()
		await Promise.all([stop, start])
		expect(order).toEqual(["stopped", "start"])
	})

	it("CI-MG-01: a second start during an Error-path start joins it", async () => {
		const { manager, stateManager } = makeManager()
		const contextProxy = {}
		manager["_configManager"] = {
			isFeatureEnabled: true,
			isFeatureConfigured: true,
			loadConfiguration: async () => ({ requiresRestart: false }),
			getContextProxy: () => contextProxy,
		} as unknown as (typeof manager)["_configManager"]
		const stale: OrchestratorDouble = {
			startIndexing: vi.fn(async () => {}),
			// The stop settles later, leaving a window where the first start is still recovering.
			stopIndexing: vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 0))),
			isScanning: false,
			state: "Error",
		}
		attach(manager, stale)
		stateManager.setSystemState("Error", "scan failed")
		const fresh: OrchestratorDouble = {
			startIndexing: vi.fn(async () => {}),
			stopIndexing: vi.fn(async () => {}),
			isScanning: false,
			state: "Standby",
		}
		vi.spyOn(CacheManager.prototype, "initialize").mockResolvedValue(undefined)
		const recreate = vi
			.spyOn(manager as unknown as { _recreateServices(): Promise<void> }, "_recreateServices")
			.mockImplementation(async () => {
				attach(manager, fresh)
				manager["_searchService"] = {} as unknown as (typeof manager)["_searchService"]
			})

		const first = manager.startIndexing()
		const second = manager.startIndexing()
		await Promise.all([first, second])

		expect(stale.stopIndexing).toHaveBeenCalledOnce()
		expect(recreate).toHaveBeenCalledOnce()
		expect(fresh.startIndexing).toHaveBeenCalledOnce()
	})

	it.each(["handleSettingsChange", "recoverFromError"] as const)(
		"CI-MG-02: %s stops the scan and watcher before services are recreated",
		async (entry) => {
			const { manager } = makeManager()
			replacementOrder.length = 0
			// The stop settles a tick later, so replacement work that does not await it would run first.
			const orchestrator: OrchestratorDouble = {
				startIndexing: vi.fn(async () => {}),
				stopIndexing: vi.fn(async () => {
					await new Promise((resolve) => setTimeout(resolve, 0))
					replacementOrder.push("stop")
				}),
				isScanning: false,
				state: "Indexed",
			}
			attach(manager, orchestrator)
			manager["_configManager"] = {
				isFeatureEnabled: true,
				isFeatureConfigured: true,
				currentEmbedderProvider: "semble",
				loadConfiguration: async () => ({ requiresRestart: true }),
			} as unknown as (typeof manager)["_configManager"]

			await manager[entry]()

			expect(replacementOrder[0]).toBe("stop")
			if (entry === "handleSettingsChange") expect(replacementOrder).toEqual(["stop", "recreate"])
			else expect(manager["_orchestrator"]).toBeUndefined()
		},
	)

	it("CI-MG-02: one start from Error recovers, re-initializes and starts indexing", async () => {
		const { manager, stateManager } = makeManager()
		const contextProxy = {}
		manager["_configManager"] = {
			isFeatureEnabled: true,
			isFeatureConfigured: true,
			getContextProxy: () => contextProxy,
		} as unknown as (typeof manager)["_configManager"]
		const stale: OrchestratorDouble = {
			startIndexing: vi.fn(async () => {}),
			// Settles a tick later, as the real stop does, so a same-tick caller check would miss recovery.
			stopIndexing: vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 0))),
			isScanning: false,
			state: "Error",
		}
		attach(manager, stale)
		stateManager.setSystemState("Error", "scan failed")
		const fresh: OrchestratorDouble = {
			startIndexing: vi.fn(async () => void stateManager.setSystemState("Indexing", "scanning")),
			stopIndexing: vi.fn(async () => {}),
			isScanning: false,
			state: "Standby",
		}
		vi.spyOn(CacheManager.prototype, "initialize").mockResolvedValue(undefined)
		vi.spyOn(manager as unknown as { _recreateServices(): Promise<void> }, "_recreateServices").mockImplementation(
			async () => {
				attach(manager, fresh)
				manager["_searchService"] = {} as unknown as (typeof manager)["_searchService"]
			},
		)

		await manager.startIndexing()

		expect(stale.stopIndexing).toHaveBeenCalledOnce()
		expect(stale.startIndexing).not.toHaveBeenCalled()
		expect(fresh.startIndexing).toHaveBeenCalledOnce()
		expect(manager.isInitialized).toBe(true)
		expect(stateManager.state).toBe("Indexing")
	})

	it("CI-MG-02: a replacement failure ends in Error and stays restartable", async () => {
		const { manager, stateManager } = makeManager()
		manager["_configManager"] = {
			isFeatureEnabled: true,
			isFeatureConfigured: true,
			loadConfiguration: async () => ({ requiresRestart: true }),
		} as unknown as (typeof manager)["_configManager"]
		vi.spyOn(manager as unknown as { _recreateServices(): Promise<void> }, "_recreateServices").mockRejectedValue(
			new Error("bad config"),
		)
		await expect(manager.handleSettingsChange()).rejects.toThrow("bad config")
		expect(stateManager.state).toBe("Error")
	})

	describe("CI-MG-03: status precedence", () => {
		const limited = Object.assign(new Error("limited"), { status: 429, retryAfterMs: 60_000 })

		async function withWait(manager: CodeIndexManager) {
			const controller = new AbortController()
			const pending = manager["pacers"]
				.get("openai:1")
				.run("w.ts", controller.signal, () => Promise.reject(limited))
				.catch(() => {})
			await new Promise((resolve) => setTimeout(resolve, 0))
			return async () => {
				controller.abort()
				await pending
			}
		}

		function withFailure(manager: CodeIndexManager) {
			manager["failureRegistry"].renew("f.ts", "h")
			manager["failureRegistry"].record("f.ts", "h", "embed", "down", 3, "exhausted")
		}

		it.each([
			{ base: "Error", wait: true, failure: true, expected: "Error" },
			{ base: "Stopping", wait: true, failure: true, expected: "Stopping" },
			{ base: "Indexed", wait: true, failure: true, expected: "Indexing" },
			{ base: "Indexing", wait: false, failure: true, expected: "Indexing" },
			{ base: "Indexed", wait: false, failure: true, expected: "Standby" },
			{ base: "Indexed", wait: false, failure: false, expected: "Indexed" },
			{ base: "Standby", wait: false, failure: false, expected: "Standby" },
		] as const)(
			"$base with wait=$wait failure=$failure is $expected",
			async ({ base, wait, failure, expected }) => {
				const { manager, stateManager } = makeManager()
				stateManager.setSystemState(base, "base")
				if (failure) withFailure(manager)
				const release = wait ? await withWait(manager) : async () => {}
				try {
					const status = manager.getCurrentStatus()
					expect(status.systemStatus).toBe(expected)
					expect(status.failedFiles).toHaveLength(failure ? 1 : 0)
					expect(status.providerWaits).toHaveLength(wait ? 1 : 0)
				} finally {
					await release()
				}
			},
		)
	})

	describe("fatal parser latch", () => {
		const fatalMessage = "parser timed out on src/hang.ts"

		function withFatalFailure(manager: CodeIndexManager, stateManager: CodeIndexStateManager) {
			manager["failureRegistry"].renew("src/hang.ts", "h")
			manager["failureRegistry"].record("src/hang.ts", "h", "parse", "timeout", 1, "awaiting-retry")
			stateManager.setSystemState("Error", fatalMessage)
		}

		function configure(manager: CodeIndexManager, options: { requiresRestart?: boolean; enabled?: boolean } = {}) {
			const contextProxy = {}
			manager["_configManager"] = {
				isFeatureEnabled: options.enabled ?? true,
				isFeatureConfigured: true,
				currentEmbedderProvider: providerIdentifiers.openai,
				loadConfiguration: async () => ({ requiresRestart: options.requiresRestart ?? false }),
				getContextProxy: () => contextProxy,
			} as unknown as (typeof manager)["_configManager"]
			return contextProxy
		}

		function orchestratorDouble(order: string[], name: string, state: OrchestratorDouble["state"] = "Error") {
			return {
				startIndexing: vi.fn(async () => void order.push(`${name}.start`)),
				stopIndexing: vi.fn(async () => void order.push(`${name}.stop`)),
				isScanning: false,
				state,
			} satisfies OrchestratorDouble
		}

		/** Replaces service recreation with one that attaches `fresh`, as the real one builds a new orchestrator. */
		function recreateWith(manager: CodeIndexManager, fresh: OrchestratorDouble) {
			vi.spyOn(CacheManager.prototype, "initialize").mockResolvedValue(undefined)
			return vi
				.spyOn(manager as unknown as { _recreateServices(): Promise<void> }, "_recreateServices")
				.mockImplementation(async () => {
					attach(manager, fresh)
					// The double provides no members; these tests never search.
					manager["_searchService"] = {} as unknown as (typeof manager)["_searchService"]
				})
		}

		it("CI-MG-05: with awaiting-retry set, initialize() starts nothing", async () => {
			const { manager, stateManager } = makeManager()
			const order: string[] = []
			const contextProxy = configure(manager)
			withFatalFailure(manager, stateManager)
			const recreate = recreateWith(manager, orchestratorDouble(order, "fresh", "Standby"))

			await manager.initialize(contextProxy as Parameters<CodeIndexManager["initialize"]>[0])

			expect(recreate).toHaveBeenCalledOnce()
			expect(order).toEqual([])
			expect(manager["failureRegistry"].hasAwaitingRetry()).toBe(true)
		})

		it("CI-MG-05: Start Indexing clears the latch and starts once after the failed attempt stops", async () => {
			const { manager, stateManager } = makeManager()
			const order: string[] = []
			configure(manager)
			const stale = orchestratorDouble(order, "stale")
			attach(manager, stale)
			withFatalFailure(manager, stateManager)
			const fresh = orchestratorDouble(order, "fresh", "Standby")
			recreateWith(manager, fresh)

			await Promise.all([manager.startIndexing(), manager.startIndexing()])

			expect(order).toEqual(["stale.stop", "fresh.start"])
			expect(manager["failureRegistry"].hasAwaitingRetry()).toBe(false)
			expect(manager.getCurrentStatus().failedFiles).toEqual([])
		})

		it("CI-MG-05: Start Indexing after a fatal failure does not join a start still awaiting a write", async () => {
			const { manager, stateManager } = makeManager()
			const order: string[] = []
			configure(manager)
			const stale = orchestratorDouble(order, "stale")
			// The failed start never settles, as when the completion-marker upsert outlives the fatal abort.
			stale.startIndexing.mockImplementation(() => new Promise<void>(() => {}))
			attach(manager, stale)
			void manager.startIndexing()
			withFatalFailure(manager, stateManager)
			const fresh = orchestratorDouble(order, "fresh", "Standby")
			recreateWith(manager, fresh)

			await manager.startIndexing()

			expect(order).toEqual(["stale.stop", "fresh.start"])
			expect(stale.startIndexing).toHaveBeenCalledOnce()
		})

		it("CI-MG-05: Start Indexing clears the latch with the Semble provider", async () => {
			const { manager, stateManager } = makeManager()
			configure(manager)
			withFatalFailure(manager, stateManager)
			const startSemble = vi.fn(async () => {})
			// The double provides only startIndexing, the one Semble member a start uses.
			const semble = { startIndexing: startSemble } as unknown as (typeof manager)["_sembleProvider"]
			manager["_sembleProvider"] = semble

			await manager.startIndexing()

			expect(startSemble).toHaveBeenCalledOnce()
			expect(manager["failureRegistry"].hasAwaitingRetry()).toBe(false)
		})

		it("CI-MG-06: the summary prefers awaiting-retry over retrying and exhausted", () => {
			const { manager } = makeManager()
			const registry = manager["failureRegistry"]
			for (const [path, state] of [
				["a.ts", "retrying"],
				["b.ts", "exhausted"],
				["c.ts", "awaiting-retry"],
			] as const) {
				registry.renew(path, "h")
				registry.record(path, "h", "parse", `${state} reason`, 1, state)
			}
			expect(manager.getCurrentStatus().failedFileSummary).toEqual({
				path: "c.ts",
				activity: "parse",
				reason: "awaiting-retry reason",
				state: "awaiting-retry",
				count: 3,
			})
		})

		it.each([true, false])(
			"CI-MG-07: a settings change that recreates services keeps the fatal Error only while latched (latch set: %s)",
			async (latched) => {
				const { manager, stateManager } = makeManager()
				configure(manager, { requiresRestart: true })
				attach(manager, orchestratorDouble([], "stale"))
				stateManager.setSystemState("Error", fatalMessage)
				if (latched) withFatalFailure(manager, stateManager)

				await manager.handleSettingsChange()

				expect(stateManager.getCurrentStatus()).toMatchObject(
					latched ? { systemStatus: "Error", message: fatalMessage } : { systemStatus: "Standby" },
				)
			},
		)

		it.each(["global", "workspace"] as const)(
			"CI-MG-08: %s disable after a fatal failure shows Standby with the failed file listed",
			async (scope) => {
				const { manager, stateManager } = makeManager()
				attach(manager, orchestratorDouble([], "stale"))
				withFatalFailure(manager, stateManager)
				if (scope === "global") {
					configure(manager, { enabled: false })
					await manager.handleSettingsChange()
				} else {
					await manager.setWorkspaceEnabled(false)
					await manager.stopIndexing()
				}

				const status = manager.getCurrentStatus()
				expect(status.systemStatus).toBe("Standby")
				expect(status.message).toBe("embeddings:orchestrator.indexingFilesFailed")
				expect(status.failedFiles).toEqual([expect.objectContaining({ state: "awaiting-retry" })])
			},
		)

		describe("CI-WV-02: workspace enablement after a fatal failure", () => {
			function enablement(manager: CodeIndexManager) {
				// The double provides only the provider members setEnabled() uses.
				const provider = {
					contextProxy: {},
					log: vi.fn(),
					postMessageToWebview: vi.fn(async () => {}),
				} as unknown as Parameters<WorkspaceIndexingEnablementManager["setEnabled"]>[1]
				return { indexing: new WorkspaceIndexingEnablementManager(manager), provider }
			}

			it("enabling runs initialize() then one start that clears the latch", async () => {
				const { manager, stateManager } = makeManager()
				const order: string[] = []
				configure(manager)
				// The double provides no members; it only marks the services as created.
				manager["_serviceFactory"] = {} as unknown as (typeof manager)["_serviceFactory"]
				attach(manager, orchestratorDouble(order, "stale"))
				withFatalFailure(manager, stateManager)
				const fresh = orchestratorDouble(order, "fresh", "Standby")
				recreateWith(manager, fresh)
				const { indexing, provider } = enablement(manager)

				await indexing.setEnabled(true, provider)
				await vi.waitFor(() => expect(fresh.startIndexing).toHaveBeenCalledOnce())

				expect(order).toEqual(["stale.stop", "fresh.start"])
				expect(manager["failureRegistry"].hasAwaitingRetry()).toBe(false)
			})

			it("toggling the workspace off and on starts exactly one attempt and clears the latch", async () => {
				const { manager, stateManager } = makeManager()
				const order: string[] = []
				configure(manager)
				// The double provides no members; it only marks the services as created.
				manager["_serviceFactory"] = {} as unknown as (typeof manager)["_serviceFactory"]
				const stale = orchestratorDouble(order, "stale")
				attach(manager, stale)
				withFatalFailure(manager, stateManager)
				const { indexing, provider } = enablement(manager)

				await indexing.setEnabled(false, provider)
				expect(stateManager.state).toBe("Standby")
				await indexing.setEnabled(true, provider)
				await vi.waitFor(() => expect(stale.startIndexing).toHaveBeenCalledOnce())

				expect(order).toEqual(["stale.stop", "stale.start"])
				expect(manager["failureRegistry"].hasAwaitingRetry()).toBe(false)
			})
		})
	})

	it("CI-MG-04: a CacheReadError from initialize() ends in Error and keeps existing data", async () => {
		const { manager, stateManager } = makeManager()
		manager["_cacheManager"] = undefined
		const clear = vi.spyOn(CacheManager.prototype, "clearCacheFile")
		vi.spyOn(CacheManager.prototype, "initialize").mockRejectedValue(new CacheReadError(new Error("EACCES")))
		const recreate = vi.spyOn(manager as unknown as { _recreateServices(): Promise<void> }, "_recreateServices")
		manager["_configManager"] = {
			isFeatureEnabled: true,
			isFeatureConfigured: true,
			loadConfiguration: async () => ({ requiresRestart: false }),
		} as unknown as (typeof manager)["_configManager"]

		// The double stands in for ContextProxy; initialize() only passes it to an existing config manager.
		await manager.initialize({} as unknown as Parameters<CodeIndexManager["initialize"]>[0])

		expect(stateManager.state).toBe("Error")
		expect(recreate).not.toHaveBeenCalled()
		expect(clear).not.toHaveBeenCalled()
		expect(manager["_cacheManager"]).toBeUndefined()
	})
})
