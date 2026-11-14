import * as path from "path"
import type * as vscode from "vscode"
import { CodeIndexManager } from "../manager"
import { CodeIndexStateManager } from "../state-manager"
import { CacheManager, CacheReadError } from "../cache-manager"
import type { CodeIndexOrchestrator } from "../orchestrator"

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
