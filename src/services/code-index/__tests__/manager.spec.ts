import * as path from "path"
import * as vscode from "vscode"
import { ContextProxy } from "../../../core/config/ContextProxy"
import { CodeIndexManager } from "../manager"
import { CodeIndexConfigManager } from "../config-manager"
import { CodeIndexStateManager } from "../state-manager"
import { CodeIndexServiceFactory } from "../service-factory"
import { CodeIndexOrchestrator } from "../orchestrator"
import { CodeIndexSearchService } from "../search-service"
import { CacheManager } from "../cache-manager"
import { GenerationAllocator } from "../generation-allocator"
import { clearAllMocks, restoreGlobals } from "../../../test-utils/reset"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"
import { SembleProvider } from "../semble"
import { codeIndexLog } from "../code-index-log"
import { ParserFatalError } from "../parser-errors"
import { LATE_WRITE_GRACE_MS } from "../index-write-gate"
import fs from "fs/promises"
import type { IDirectoryScanner, IFileWatcher, IVectorStore } from "../interfaces"
import type { BatchProcessingSummary } from "../interfaces/file-processor"
import { ParseWorkerClient } from "../parse-worker-client"
import { retryWithPolicy } from "../shared/retry-policy"

vi.mock("vscode", () => ({
	EventEmitter: class<Value> {
		private listeners = new Set<(value: Value) => void>()
		event = (listener: (value: Value) => void) => {
			this.listeners.add(listener)
			return {
				dispose: () => {
					this.listeners.delete(listener)
				},
			}
		}
		fire(value: Value) {
			this.listeners.forEach((listener) => listener(value))
		}
		dispose() {
			this.listeners.clear()
		}
	},
	Uri: {
		file: (filePath: string) => ({ fsPath: filePath, toString: () => `file://${filePath}` }),
		joinPath: (uri: { fsPath: string }, suffix: string) => ({ fsPath: `${uri.fsPath}/${suffix}` }),
	},
	workspace: { workspaceFolders: [{ uri: { fsPath: "/workspace" } }] },
}))
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))
vi.mock("../../../core/ignore/RooIgnoreController", () => ({
	RooIgnoreController: class {
		initialize = vi.fn().mockResolvedValue(undefined)
	},
}))
vi.mock("fs/promises", () => ({ default: { readFile: vi.fn().mockResolvedValue("") } }))
vi.mock("ignore", () => ({ default: () => ({ add: vi.fn() }) }))
vi.mock("../code-index-log-host", () => ({ initializeCodeIndexHostLogging: vi.fn() }))
vi.mock("../service-factory")
vi.mock("../orchestrator")
vi.mock("../search-service")
vi.mock("../parse-worker-client")
vi.mock("../cache-manager")
vi.mock("../generation-allocator")
vi.mock("../semble", () => ({ SembleProvider: vi.fn() }))
vi.mock("../code-index-log", () => ({
	codeIndexLog: {
		configure: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
		redact: (value: string) => value.replaceAll("configured-secret", "[REDACTED]"),
	},
}))

function deferred() {
	let resolve!: () => void
	let reject!: (error: Error) => void
	const promise = new Promise<void>((complete, fail) => {
		resolve = complete
		reject = fail
	})
	return { promise, resolve, reject }
}

async function drain() {
	for (let iteration = 0; iteration < 30; iteration++) await Promise.resolve()
}

function memento(): vscode.Memento {
	const values = new Map<string, unknown>()
	return {
		keys: () => [...values.keys()],
		get<Value>(key: string, defaultValue?: Value): Value {
			return (values.has(key) ? values.get(key) : defaultValue) as Value
		},
		update: async (key: string, value: unknown) => {
			values.set(key, value)
		},
	}
}

function extensionContext(): vscode.ExtensionContext {
	// The manager and configuration reader use storage, secrets and extension paths only.
	return {
		workspaceState: memento(),
		globalState: memento(),
		subscriptions: [],
		globalStorageUri: vscode.Uri.file("/storage"),
		extensionPath: "/extension",
		secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn() },
	} as unknown as vscode.ExtensionContext
}

function configuration(context: vscode.ExtensionContext) {
	const proxy = new ContextProxy(context)
	const config = new CodeIndexConfigManager(proxy)
	vi.spyOn(config, "isFeatureEnabled", "get").mockReturnValue(true)
	vi.spyOn(config, "isFeatureConfigured", "get").mockReturnValue(true)
	vi.spyOn(config, "currentEmbedderProvider", "get").mockReturnValue("openai")
	vi.spyOn(config, "getConfig").mockReturnValue({
		isConfigured: true,
		embedderProvider: providerIdentifiers.openai,
		openAiOptions: { openAiNativeApiKey: "configured-secret" },
	})
	const load = vi.spyOn(config, "loadConfiguration").mockResolvedValue({
		requiresRestart: false,
		configSnapshot,
		currentConfig: config.getConfig(),
	})
	return { config, proxy, load }
}

const configSnapshot = {
	enabled: true,
	configured: true,
	embedderProvider: providerIdentifiers.openai,
}

// Factory-only fixtures are never invoked; manager tests verify the dependency identities.
const services = {
	embedder: { rateLimitScope: "embedding:test" },
	vectorStore: {},
	scanner: {},
	fileWatcher: { dispose: vi.fn() },
} as unknown as Omit<ReturnType<CodeIndexServiceFactory["createServices"]>, "parser">

function semble() {
	const provider = {
		initialize: vi.fn<SembleProvider["initialize"]>().mockResolvedValue(undefined),
		startIndexing: vi.fn<SembleProvider["startIndexing"]>().mockResolvedValue(undefined),
		stopIndexing: vi.fn<SembleProvider["stopIndexing"]>(),
		searchIndex: vi.fn<SembleProvider["searchIndex"]>().mockResolvedValue([]),
		clearIndexData: vi.fn<SembleProvider["clearIndexData"]>().mockResolvedValue(undefined),
		dispose: vi.fn<SembleProvider["dispose"]>(),
		state: "Indexed" as const,
	}
	// Semble's public lifecycle surface is sufficient; its CLI fields are not used by the manager.
	vi.mocked(SembleProvider).mockImplementation(function () {
		return provider as unknown as SembleProvider
	})
	return provider
}

describe("CodeIndexManager lifecycle", () => {
	let manager: CodeIndexManager
	let state: CodeIndexStateManager
	let context: vscode.ExtensionContext
	let configured: ReturnType<typeof configuration>

	beforeEach(() => {
		clearAllMocks()
		context = extensionContext()
		state = new CodeIndexStateManager()
		manager = new CodeIndexManager("/workspace", vscode.Uri.file("/workspace"), context, state)
		configured = configuration(context)
		manager["_configManager"] = configured.config
		vi.mocked(fs.readFile).mockResolvedValue("")
		vi.mocked(CacheManager.prototype.initialize).mockResolvedValue(undefined)
		vi.mocked(CacheManager.prototype.getOpenFiles).mockReturnValue({})
		vi.mocked(CodeIndexServiceFactory.prototype.createServices).mockImplementation(() => ({
			...services,
			parser: manager["parser"]!,
		}))
		vi.mocked(CodeIndexServiceFactory.prototype.validateEmbedder).mockResolvedValue({ valid: true })
		vi.mocked(CodeIndexOrchestrator).mockImplementation(() => orchestratorDouble())
		semble()
	})

	function orchestratorDouble(): CodeIndexOrchestrator {
		// These tests exercise manager coordination, not the orchestrator's bounded-stop implementation.
		return {
			startupResult: Promise.resolve(),
			stopped: false,
			isScanning: false,
			isActive: true,
			isNaturallySettledPartial: false,
			startIndexing: vi.fn().mockResolvedValue(undefined),
			stopIndexing: vi.fn().mockResolvedValue(undefined),
			stopWatcher: vi.fn().mockResolvedValue(undefined),
			clearIndexData: vi.fn().mockResolvedValue(undefined),
		} as unknown as CodeIndexOrchestrator
	}

	function replaceOnStart(replacement = orchestratorDouble()) {
		const rebuild = vi.fn<CodeIndexManager["_recreateServices"]>().mockImplementation(async () => {
			manager["_orchestrator"] = replacement
			manager["_searchService"] = new CodeIndexSearchService(
				configured.config,
				state,
				services.embedder,
				services.vectorStore,
				manager.fileFailureRegistry,
				manager.providerPacerRegistry,
			)
			manager["servicesStopped"] = false
		})
		manager["_recreateServices"] = rebuild
		return { rebuild, replacement }
	}

	function recordFailure(failureState: "retrying" | "exhausted" = "exhausted") {
		manager.fileFailureRegistry.renew("bad.ts", "revision")
		manager.fileFailureRegistry.record("bad.ts", "revision", "embed", "configured-secret failed", 1, failureState)
	}

	afterEach(() => {
		manager.dispose()
		restoreGlobals()
		vi.useRealTimers()
	})

	describe("configuration readiness", () => {
		function unloadedConfiguration() {
			manager["_configManager"] = undefined
			const proxy = new ContextProxy(context)
			vi.spyOn(proxy, "getGlobalState").mockReturnValue({ codebaseIndexEnabled: false })
			vi.spyOn(proxy, "getSecret").mockReturnValue(undefined)
			return proxy
		}

		it("does not regain readiness when a detached configuration finishes loading", async () => {
			const proxy = unloadedConfiguration()
			const refresh = deferred()
			vi.spyOn(proxy, "refreshSecrets").mockReturnValue(refresh.promise)
			const initialization = manager.initialize(proxy)
			expect(manager.isConfigurationLoaded).toBe(false)
			await manager.recoverFromError()
			refresh.resolve()
			await initialization
			expect(manager.isConfigurationLoaded).toBe(false)
			expect(CodeIndexServiceFactory).not.toHaveBeenCalled()
		})

		it("keeps failed configuration unloaded until a settings refresh succeeds", async () => {
			const proxy = unloadedConfiguration()
			vi.spyOn(proxy, "refreshSecrets")
				.mockRejectedValueOnce(new Error("secrets refresh failed"))
				.mockResolvedValue(undefined)
			await expect(manager.initialize(proxy)).rejects.toThrow("secrets refresh failed")
			expect(manager.isConfigurationLoaded).toBe(false)
			await manager.handleSettingsChange()
			expect(manager.isConfigurationLoaded).toBe(true)
			expect(manager.isInitialized).toBe(false)
		})

		it("marks disabled configuration loaded only after secrets refresh completes", async () => {
			const proxy = unloadedConfiguration()
			const refresh = deferred()
			vi.spyOn(proxy, "refreshSecrets").mockReturnValue(refresh.promise)
			const initialization = manager.initialize(proxy)
			expect(proxy.refreshSecrets).toHaveBeenCalledOnce()
			expect(manager.isConfigurationLoaded).toBe(false)
			refresh.resolve()
			await initialization
			expect(manager.isConfigurationLoaded).toBe(true)
			expect(manager.isFeatureEnabled).toBe(false)
			expect(manager.isInitialized).toBe(false)
			await manager.recoverFromError()
			expect(manager.isConfigurationLoaded).toBe(false)
		})
	})

	it.each(["initialize", "settings"] as const)(
		"loads cache before allocator and recovers load-time grace through %s",
		async (entry) => {
			vi.useFakeTimers()
			vi.setSystemTime(100_000)
			vi.mocked(CacheManager.prototype.initialize).mockImplementation(async function (this: CacheManager) {
				this.loadedAt = Date.now()
				vi.setSystemTime(105_000)
			})
			vi.mocked(CacheManager.prototype.getOpenFiles).mockReturnValue({ "open.ts": true })
			configured.load.mockResolvedValue({
				requiresRestart: true,
				configSnapshot,
				currentConfig: configured.config.getConfig(),
			})
			if (entry === "initialize") await manager.initialize(configured.proxy)
			else await manager.handleSettingsChange()
			expect(manager["writeGate"].graceDeadline("open.ts")).toBe(100_000 + LATE_WRITE_GRACE_MS)
			expect(vi.mocked(CacheManager.prototype.initialize).mock.invocationCallOrder[0]).toBeLessThan(
				vi.mocked(GenerationAllocator).mock.invocationCallOrder[0],
			)
		},
	)

	it("shares startup while rebuilding and resolves before a delayed scan", async () => {
		const held = deferred()
		const scan = deferred()
		const { rebuild, replacement } = replaceOnStart()
		vi.mocked(replacement.startIndexing).mockReturnValue(scan.promise)
		rebuild.mockImplementation(async () => {
			await held.promise
			manager["_orchestrator"] = replacement
		})
		manager["_searchService"] = new CodeIndexSearchService(
			configured.config,
			state,
			services.embedder,
			services.vectorStore,
			manager.fileFailureRegistry,
			manager.providerPacerRegistry,
		)
		const startup = manager.startIndexing()
		expect(manager.startIndexing()).toBe(startup)
		await drain()
		expect(rebuild).toHaveBeenCalledOnce()
		held.resolve()
		await startup
		expect(replacement.startIndexing).toHaveBeenCalledOnce()
		scan.resolve()
	})

	it("joins only a live active scan's exact startup promise", () => {
		const active = orchestratorDouble()
		Object.defineProperty(active, "isScanning", { value: true })
		manager["_orchestrator"] = active
		expect(manager.startIndexing()).toBe(active.startupResult)
		expect(active.startIndexing).not.toHaveBeenCalled()
	})

	it.each(["stopIndexing", "stopWatcher"] as const)(
		"returns the exact shared %s promise without waiting for clear",
		(stop) => {
			const active = orchestratorDouble()
			const shared = deferred()
			vi.mocked(active[stop]).mockReturnValue(shared.promise)
			manager["_orchestrator"] = active
			manager["clearing"] = deferred().promise
			expect(manager[stop]()).toBe(shared.promise)
			expect(manager[stop]()).toBe(shared.promise)
			shared.resolve()
		},
	)

	it("returns a shared idle stop without services", () => {
		expect(manager.stopIndexing()).toBe(manager.stopWatcher())
	})

	it.each(["stopIndexing", "stopWatcher", "disable", "feature-disable"] as const)(
		"fences a late rejected rebuild after %s",
		async (ending) => {
			const held = deferred()
			const { rebuild } = replaceOnStart()
			rebuild.mockReturnValue(held.promise)
			const startup = manager.startIndexing()
			await drain()
			if (ending === "disable") await manager.setWorkspaceEnabled(false)
			else if (ending === "feature-disable") {
				vi.spyOn(configured.config, "isFeatureEnabled", "get").mockReturnValue(false)
				await manager.handleSettingsChange()
			} else await manager[ending]()
			held.reject(new Error("late rebuild"))
			await expect(startup).resolves.toBeUndefined()
			expect(manager.state).not.toBe("Error")
			expect(codeIndexLog.error).not.toHaveBeenCalled()
		},
	)

	it.each(["rebuild", "startup"] as const)("reports and rejects sanitized %s failures", async (phase) => {
		const { rebuild, replacement } = replaceOnStart()
		if (phase === "rebuild") rebuild.mockRejectedValue(new Error("configured-secret failed"))
		else
			vi.mocked(replacement.startIndexing).mockImplementation(() => {
				replacement.startupResult = Promise.reject(new Error("configured-secret failed"))
				return Promise.resolve()
			})
		await expect(manager.startIndexing()).rejects.toThrow("configured-secret failed")
		expect(manager.getCurrentStatus()).toMatchObject({ systemStatus: "Error", message: "[REDACTED] failed" })
		expect(manager["startInFlight"]).toBeUndefined()
	})

	it.each([true, false])("retries startup failure on settings save even if changed=%s", async (requiresRestart) => {
		const { rebuild } = replaceOnStart()
		rebuild.mockRejectedValueOnce(new Error("bad configuration"))
		await expect(manager.startIndexing()).rejects.toThrow("bad configuration")
		configured.load.mockResolvedValue({
			requiresRestart,
			configSnapshot,
			currentConfig: configured.config.getConfig(),
		})
		await manager.handleSettingsChange()
		expect(rebuild).toHaveBeenCalledTimes(2)
		expect(manager["startupFailureMessage"]).toBeUndefined()
	})

	it("drains a settings rebuild before scanning and shares Start throughout", async () => {
		const held = deferred()
		const secondHeld = deferred()
		const { rebuild, replacement } = replaceOnStart()
		rebuild
			.mockImplementationOnce(async () => {
				await held.promise
				manager["_orchestrator"] = replacement
			})
			.mockImplementationOnce(async () => {
				await secondHeld.promise
				manager["_orchestrator"] = replacement
			})
		manager["_searchService"] = new CodeIndexSearchService(
			configured.config,
			state,
			services.embedder,
			services.vectorStore,
			manager.fileFailureRegistry,
			manager.providerPacerRegistry,
		)
		const startup = manager.startIndexing()
		await drain()
		configured.load.mockResolvedValue({
			requiresRestart: true,
			configSnapshot,
			currentConfig: configured.config.getConfig(),
		})
		const settings = manager.handleSettingsChange()
		await drain()
		held.resolve()
		await drain()
		expect(rebuild).toHaveBeenCalledTimes(2)
		expect(manager.startIndexing()).toBe(startup)
		expect(replacement.startIndexing).not.toHaveBeenCalled()
		secondHeld.resolve()
		await Promise.all([startup, settings])
		expect(replacement.startIndexing).toHaveBeenCalledOnce()
	})

	it.each(["stop", "fatal"] as const)("does not drain pending settings after %s", async (ending) => {
		const held = deferred()
		const { rebuild, replacement } = replaceOnStart()
		rebuild.mockImplementation(async () => {
			await held.promise
			manager["_orchestrator"] = replacement
		})
		manager["_searchService"] = new CodeIndexSearchService(
			configured.config,
			state,
			services.embedder,
			services.vectorStore,
			manager.fileFailureRegistry,
			manager.providerPacerRegistry,
		)
		const startup = manager.startIndexing()
		await drain()
		configured.load.mockResolvedValue({
			requiresRestart: true,
			configSnapshot,
			currentConfig: configured.config.getConfig(),
		})
		const settings = manager.handleSettingsChange()
		await drain()
		if (ending === "stop") await manager.stopIndexing()
		else manager["parserFailed"] = true
		held.resolve()
		await Promise.all([startup, settings])
		expect(rebuild).toHaveBeenCalledOnce()
		expect(replacement.startIndexing).not.toHaveBeenCalled()
	})

	it("blocks automatic paths on fatal failure but explicit retry rebuilds without recoverFromError", async () => {
		manager["parserFailed"] = true
		manager["parserFailureMessage"] = "fatal"
		const { rebuild, replacement } = replaceOnStart()
		const recovery = vi.spyOn(manager, "recoverFromError")
		await manager.initialize(configured.proxy)
		await manager.handleSettingsChange()
		expect(rebuild).not.toHaveBeenCalled()
		await manager.startIndexing()
		expect(recovery).not.toHaveBeenCalled()
		expect(manager["parserFailed"]).toBe(false)
		expect(replacement.startIndexing).toHaveBeenCalledOnce()
	})

	it.each(["resolve", "reject"] as const)(
		"waits for clear to %s before recreation, without invalidating the clearing owner",
		async (ending) => {
			await manager.startIndexing()
			const old = manager["_orchestrator"]!
			const held = deferred()
			vi.mocked(old.clearIndexData).mockReturnValue(held.promise)
			const clearing = manager.clearIndexData().catch(() => {})
			const oldAttempt = manager["currentAttempt"]
			const created = vi.mocked(CodeIndexServiceFactory).mock.calls.length
			const startup = manager.startIndexing()
			await drain()
			expect(manager["currentAttempt"]).toBe(oldAttempt)
			expect(vi.mocked(CodeIndexServiceFactory).mock.calls).toHaveLength(created)
			if (ending === "resolve") held.resolve()
			else held.reject(new Error("delete failed"))
			await Promise.all([clearing, startup])
			expect(vi.mocked(CodeIndexServiceFactory).mock.calls).toHaveLength(created + 1)
		},
	)

	it("retains workspace dependencies, retires the old owner, and fences stale fatal callbacks", async () => {
		await manager.startIndexing()
		const first = vi.mocked(CodeIndexOrchestrator).mock.calls.at(-1)!
		const factory = vi.mocked(CodeIndexServiceFactory).mock.calls.at(-1)!
		const old = manager["_orchestrator"]!
		const parser = manager["parser"]!
		await manager.startIndexing()
		const second = vi.mocked(CodeIndexOrchestrator).mock.calls.at(-1)!
		expect(second[8]).toBe(first[8])
		expect(second[9]).toBe(first[9])
		expect(second[10]).toBe(manager.fileFailureRegistry)
		expect(factory[6]).toBe(first[7])
		expect(second[7]).not.toBe(parser)
		expect(parser.stop).toHaveBeenCalled()
		expect(old.stopWatcher).toHaveBeenCalled()
		expect(first[11]!()).toBe(false)
		first[12]!(new ParserFatalError("parser-abort", "old.ts"), "stale failure")
		expect(manager["parserFailed"]).toBe(false)
		expect(CodeIndexServiceFactory.prototype.validateEmbedder).toHaveBeenCalledTimes(2)
		expect(factory[8]).toBe(manager.providerPacerRegistry)
		expect(first[13]).toBe(manager.providerPacerRegistry)
		expect(second[13]).toBe(first[13])
	})

	it("aborts real watcher retry backoff when explicit Start replaces its owner", async () => {
		vi.useFakeTimers()
		await manager.startIndexing()
		const { CodeIndexOrchestrator: ActualOrchestrator } =
			await vi.importActual<typeof import("../orchestrator")>("../orchestrator")
		const batchStarted = new vscode.EventEmitter<string[]>()
		const batchProgress = new vscode.EventEmitter<{
			processedInBatch: number
			totalInBatch: number
			currentFile?: string
		}>()
		const batchFinished = new vscode.EventEmitter<BatchProcessingSummary>()
		let watcherSignal!: AbortSignal
		const watcher: IFileWatcher = {
			initialize: vi.fn(async (signal?: AbortSignal) => {
				watcherSignal = signal!
			}),
			dispose: vi.fn(),
			processFile: vi.fn<IFileWatcher["processFile"]>(),
			onDidStartBatchProcessing: batchStarted.event,
			onBatchProgressUpdate: batchProgress.event,
			onDidFinishBatchProcessing: batchFinished.event,
		}
		const scanner: IDirectoryScanner = {
			scanDirectory: vi.fn<IDirectoryScanner["scanDirectory"]>().mockResolvedValue({
				stats: { processed: 0, skipped: 0 },
				totalBlockCount: 0,
			}),
		}
		// Only startup and completeness writes are used; no vector search or file writes occur.
		const store = {
			initialize: vi.fn().mockResolvedValue(false),
			hasIndexedData: vi.fn().mockResolvedValue(false),
			markIndexingIncomplete: vi.fn().mockResolvedValue(undefined),
			markIndexingComplete: vi.fn().mockResolvedValue(undefined),
		} as unknown as IVectorStore
		// The real orchestrator only retires this worker and waits for physical exit.
		const parser = {
			stop: vi.fn(),
			stopped: Promise.resolve(),
			logStopTimeout: vi.fn(),
		} as unknown as ParseWorkerClient
		const attempt = manager["currentAttempt"]
		const active = new ActualOrchestrator(
			configured.config,
			state,
			"/workspace",
			manager["_cacheManager"]!,
			store,
			scanner,
			watcher,
			parser,
			manager["writeGate"],
			manager["generationAllocator"]!,
			manager.fileFailureRegistry,
			() => manager["currentAttempt"] === attempt,
		)
		manager["_orchestrator"] = active
		await active.startIndexing()
		batchStarted.fire(["bad.ts"])
		expect(active.isScanning).toBe(false)
		expect(manager.state).toBe("Indexing")
		const registry = manager.fileFailureRegistry
		registry.renew("bad.ts", "revision")
		const operation = vi
			.fn<() => Promise<void>>()
			.mockRejectedValue(Object.assign(new Error("unavailable"), { status: 503 }))
		const retry = retryWithPolicy(operation, {
			signal: watcherSignal,
			budget: registry.getRetryBudget("bad.ts", "revision", "embed"),
			onFailure: (failure) =>
				registry.record(
					"bad.ts",
					"revision",
					"embed",
					"unavailable",
					failure.attempt,
					failure.willRetry ? "retrying" : "exhausted",
					failure.classification,
				),
		}).catch((error: unknown) => error)
		await vi.advanceTimersByTimeAsync(0)
		expect(registry.get("bad.ts")).toMatchObject({ state: "retrying", attempt: 1 })
		const startup = manager.startIndexing()
		expect(manager.startIndexing()).toBe(startup)
		await startup
		expect(await retry).toBe(watcherSignal.reason)
		expect(watcherSignal.aborted).toBe(true)
		expect(watcher.dispose).toHaveBeenCalledOnce()
		await vi.advanceTimersByTimeAsync(2_000)
		expect(operation).toHaveBeenCalledOnce()
		expect(registry.getFailure("bad.ts", "revision", "embed")).toBeUndefined()
		batchStarted.dispose()
		batchProgress.dispose()
		batchFinished.dispose()
	})

	it("retains failure budgets on automatic rebuild and resets them only on explicit start or re-enable", async () => {
		await manager.startIndexing()
		recordFailure()
		const registry = manager.fileFailureRegistry
		const reset = vi.spyOn(registry, "resetAllBudgets")
		configured.load.mockResolvedValue({
			requiresRestart: true,
			configSnapshot,
			currentConfig: configured.config.getConfig(),
		})
		await manager.handleSettingsChange()
		expect(reset).not.toHaveBeenCalled()
		expect(registry.hasRevisionFailure("bad.ts", "revision")).toBe(true)
		await manager.startIndexing()
		expect(reset).toHaveBeenCalledOnce()
		await manager.setWorkspaceEnabled(false)
		await manager.setWorkspaceEnabled(true)
		expect(reset).toHaveBeenCalledTimes(2)
		expect(manager.fileFailureRegistry).toBe(registry)
	})

	it.each([
		["Error", false, false, false, "Error"],
		["Stopping", false, false, false, "Stopping"],
		["Standby", true, false, false, "Indexing"],
		["Standby", false, true, false, "Standby"],
		["Indexed", false, false, false, "Indexed"],
		["Indexed", false, false, true, "Standby"],
	] as const)(
		"computes precedence from %s scanning=%s partial=%s stopped=%s",
		(raw, scanning, partial, stopped, expected) => {
			const active = orchestratorDouble()
			Object.defineProperties(active, {
				isScanning: { value: scanning },
				isNaturallySettledPartial: { value: partial },
			})
			manager["_orchestrator"] = active
			manager["servicesStopped"] = stopped
			state.setSystemState(raw, "original")
			expect(manager.state).toBe(expected)
			expect(manager.getCurrentStatus().systemStatus).toBe(expected)
		},
	)

	it("does not render an idle live watcher as active indexing", () => {
		manager["_orchestrator"] = orchestratorDouble()
		state.setSystemState("Indexed", "ready")
		expect(manager.state).toBe("Indexed")
	})

	it("publishes state and sanitized registry updates and preserves stop messages", async () => {
		const update = vi.fn()
		manager.onProgressUpdate(update)
		state.setSystemState("Indexed", "ready")
		expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ systemStatus: "Indexed" }))
		recordFailure("retrying")
		expect(update).toHaveBeenLastCalledWith(
			expect.objectContaining({
				systemStatus: "Indexing",
				failedFiles: [expect.objectContaining({ reason: "[REDACTED] failed" })],
			}),
		)
		await manager.stopIndexing()
		state.setSystemState("Standby", "user stopped")
		expect(manager.getCurrentStatus()).toMatchObject({
			systemStatus: "Standby",
			message: "user stopped",
			failedFiles: [expect.objectContaining({ state: "exhausted" })],
		})
		state.setSystemState("Stopping", "stopping")
		manager["parserFailed"] = true
		manager["parserFailureMessage"] = "configured-secret fatal"
		expect(manager.getCurrentStatus()).toMatchObject({ systemStatus: "Error", message: "[REDACTED] fatal" })
	})

	it("forwards search cancellation and injects registry plus computed status", async () => {
		await manager.startIndexing()
		const search = manager["_searchService"]!
		const response = { results: [], incomplete: true, failedPaths: ["bad.ts"], waitingPaths: [] }
		vi.mocked(search.searchIndex).mockResolvedValue(response)
		const controller = new AbortController()
		expect(await manager.searchIndex("query", "src", controller.signal)).toBe(response)
		expect(search.searchIndex).toHaveBeenCalledWith("query", "src", controller.signal)
		const argumentsUsed = vi.mocked(CodeIndexSearchService).mock.calls.at(-1)!
		expect(argumentsUsed[4]).toBe(manager.fileFailureRegistry)
		manager["parserFailed"] = true
		expect(argumentsUsed[5]).toBe(manager.providerPacerRegistry)
		expect(argumentsUsed[6]!().systemStatus).toBe("Error")
	})

	it("returns a failure envelope while disabled", async () => {
		vi.spyOn(configured.config, "isFeatureEnabled", "get").mockReturnValue(false)
		await expect(manager.searchIndex("query")).resolves.toEqual({
			results: [],
			incomplete: false,
			failedPaths: [],
			waitingPaths: [],
		})
		recordFailure()
		await expect(manager.searchIndex("query")).resolves.toEqual({
			results: [],
			incomplete: true,
			failedPaths: ["bad.ts"],
			waitingPaths: [],
		})
	})

	it("starts newly recreated Semble through the shared helper and ignores query cancellation", async () => {
		vi.spyOn(configured.config, "currentEmbedderProvider", "get").mockReturnValue("semble")
		const provider = semble()
		await manager.initialize(configured.proxy)
		expect(provider.startIndexing).toHaveBeenCalledOnce()
		const controller = new AbortController()
		controller.abort()
		await expect(manager.searchIndex("query", "src", controller.signal)).resolves.toEqual({
			results: [],
			incomplete: false,
			failedPaths: [],
			waitingPaths: [],
		})
		expect(provider.searchIndex).toHaveBeenCalledWith("query", "src")
	})

	it.each(["repeat", "stopIndexing", "stopWatcher", "clear"] as const)(
		"reuses existing Semble and restores status forwarding after %s",
		async (action) => {
			vi.spyOn(configured.config, "currentEmbedderProvider", "get").mockReturnValue("semble")
			const provider = semble()
			await manager.initialize(configured.proxy)
			const providerState = vi.mocked(SembleProvider).mock.calls.at(-1)![2]
			provider.startIndexing.mockImplementation(async () => {
				providerState.setSystemState("Indexed", "Semble ready")
			})
			if (action === "clear") await manager.clearIndexData()
			else if (action !== "repeat") await manager[action]()
			recordFailure()
			const reset = vi.spyOn(manager.fileFailureRegistry, "resetAllBudgets")
			const rebuild = vi.fn<CodeIndexManager["_recreateServices"]>()
			manager["_recreateServices"] = rebuild
			const startup = manager.startIndexing(configured.proxy)
			expect(manager.startIndexing()).toBe(startup)
			await startup
			expect(SembleProvider).toHaveBeenCalledOnce()
			expect(provider.initialize).toHaveBeenCalledOnce()
			expect(provider.dispose).not.toHaveBeenCalled()
			expect(provider.startIndexing).toHaveBeenCalledTimes(2)
			expect(rebuild).not.toHaveBeenCalled()
			expect(reset).not.toHaveBeenCalled()
			expect(manager.getCurrentStatus()).toMatchObject({ systemStatus: "Indexed", message: "Semble ready" })
		},
	)

	it.each(["workspace", "feature"] as const)("does not start existing Semble when %s is disabled", async (scope) => {
		vi.spyOn(configured.config, "currentEmbedderProvider", "get").mockReturnValue("semble")
		const provider = semble()
		await manager.initialize(configured.proxy)
		if (scope === "workspace") await manager.setWorkspaceEnabled(false)
		else vi.spyOn(configured.config, "isFeatureEnabled", "get").mockReturnValue(false)
		await manager.startIndexing()
		expect(provider.startIndexing).toHaveBeenCalledOnce()
		expect(SembleProvider).toHaveBeenCalledOnce()
	})

	it("retries an existing Semble startup failure without rebuilding", async () => {
		vi.spyOn(configured.config, "currentEmbedderProvider", "get").mockReturnValue("semble")
		const provider = semble()
		await manager.initialize(configured.proxy)
		provider.startIndexing.mockRejectedValueOnce(new Error("Semble unavailable"))
		await expect(manager.startIndexing()).rejects.toThrow("Semble unavailable")
		expect(manager.state).toBe("Error")
		const providerState = vi.mocked(SembleProvider).mock.calls.at(-1)![2]
		provider.startIndexing.mockImplementation(async () => {
			providerState.setSystemState("Indexed", "Semble recovered")
		})
		await manager.startIndexing()
		expect(manager.getCurrentStatus()).toMatchObject({ systemStatus: "Indexed", message: "Semble recovered" })
		expect(SembleProvider).toHaveBeenCalledOnce()
		expect(provider.dispose).not.toHaveBeenCalled()
	})

	it("waits for Semble clear before restarting the existing provider", async () => {
		vi.spyOn(configured.config, "currentEmbedderProvider", "get").mockReturnValue("semble")
		const provider = semble()
		await manager.initialize(configured.proxy)
		const held = deferred()
		provider.clearIndexData.mockReturnValue(held.promise)
		const clearing = manager.clearIndexData()
		const startup = manager.startIndexing()
		await drain()
		expect(provider.startIndexing).toHaveBeenCalledOnce()
		await manager.stopIndexing()
		held.resolve()
		await Promise.all([clearing, startup])
		expect(provider.startIndexing).toHaveBeenCalledOnce()
	})

	it("recreates Semble after initialization was retired by stop", async () => {
		vi.spyOn(configured.config, "currentEmbedderProvider", "get").mockReturnValue("semble")
		const held = deferred()
		const retired = semble()
		retired.initialize.mockReturnValue(held.promise)
		const startup = manager.startIndexing()
		await drain()
		await manager.stopIndexing()
		held.resolve()
		await startup
		const replacement = semble()
		await manager.startIndexing()
		expect(retired.dispose).toHaveBeenCalledOnce()
		expect(retired.startIndexing).not.toHaveBeenCalled()
		expect(replacement.initialize).toHaveBeenCalledOnce()
		expect(replacement.startIndexing).toHaveBeenCalledOnce()
	})

	it.each(["before-create", "during-initialize"] as const)("fences Semble after stop %s", async (phase) => {
		vi.spyOn(configured.config, "currentEmbedderProvider", "get").mockReturnValue("semble")
		const held = deferred()
		const provider = semble()
		if (phase === "before-create") manager["clearing"] = held.promise
		else provider.initialize.mockReturnValue(held.promise)
		const startup = manager.startIndexing()
		await drain()
		await manager.stopIndexing()
		held.resolve()
		await startup
		expect(provider.startIndexing).not.toHaveBeenCalled()
		if (phase === "before-create") expect(SembleProvider).not.toHaveBeenCalled()
		else expect(provider.dispose).toHaveBeenCalled()
	})

	it("fences late Semble status publications", async () => {
		vi.spyOn(configured.config, "currentEmbedderProvider", "get").mockReturnValue("semble")
		const held = deferred()
		semble().initialize.mockReturnValue(held.promise)
		const startup = manager.startIndexing()
		await drain()
		const providerState = vi.mocked(SembleProvider).mock.calls.at(-1)![2]
		await manager.stopIndexing()
		providerState.setSystemState("Error", "stale download failure")
		held.resolve()
		await startup
		expect(manager.state).not.toBe("Error")
	})

	it("recoverFromError retires the old attempt and preserves the fatal latch and cache", async () => {
		await manager.startIndexing()
		const cache = manager["_cacheManager"]
		const old = manager["_orchestrator"]!
		const attempt = manager["currentAttempt"]
		manager["parserFailed"] = true
		await manager.recoverFromError()
		expect(old.stopWatcher).toHaveBeenCalled()
		expect(manager["currentAttempt"]).toBeGreaterThan(attempt)
		expect(manager["parserFailed"]).toBe(true)
		expect(manager["_cacheManager"]).toBe(cache)
		expect(manager.isInitialized).toBe(false)
		expect(manager.isConfigurationLoaded).toBe(false)
	})

	it("continues recovery when publishing Standby throws", async () => {
		await manager.startIndexing()
		vi.spyOn(state, "setSystemState").mockImplementation(() => {
			throw new Error("publication failed")
		})
		await expect(manager.recoverFromError()).resolves.toBeUndefined()
		expect(manager["_configManager"]).toBeUndefined()
		expect(manager["_orchestrator"]).toBeUndefined()
	})

	it("aggregates actual configured secrets across workspace owners", async () => {
		const otherContext = extensionContext()
		const otherState = new CodeIndexStateManager()
		const other = new CodeIndexManager("/other", vscode.Uri.file("/other"), otherContext, otherState)
		try {
			other["_configManager"] = configuration(otherContext).config
			await manager.initialize(configured.proxy, false)
			expect(codeIndexLog.configure).toHaveBeenLastCalledWith({
				workspacePaths: ["/workspace", "/other"],
				secrets: ["configured-secret", "configured-secret"],
			})
		} finally {
			other.dispose()
		}
	})

	it("keeps folder URI enablement distinct and honors auto-enable false", async () => {
		const other = new CodeIndexManager(
			"/workspace",
			{ ...vscode.Uri.file("/workspace"), toString: () => "remote:///workspace" },
			context,
			new CodeIndexStateManager(),
		)
		try {
			await manager.setWorkspaceEnabled(false)
			expect(other.isWorkspaceEnabled).toBe(true)
			await manager.setAutoEnableDefault(false)
			expect(other.isWorkspaceEnabled).toBe(false)
		} finally {
			other.dispose()
		}
	})

	it("does not construct external services after stop during ignore loading", async () => {
		const held = deferred()
		vi.mocked(fs.readFile).mockImplementationOnce(async () => {
			await held.promise
			return ""
		})
		const startup = manager.startIndexing()
		await drain()
		await manager.stopWatcher()
		held.resolve()
		await startup
		expect(CodeIndexServiceFactory).not.toHaveBeenCalled()
	})

	it.each(["paused", "429"])(
		"defers %s startup validation and retains one registry across restarts",
		async (kind) => {
			vi.useFakeTimers()
			const { EmbeddingError } = await import("../shared/indexing-errors")
			const registry = manager.providerPacerRegistry
			const pacer = registry.get(services.embedder.rateLimitScope)
			const error = new EmbeddingError("limited", { status: 429 }, { retryAfterMs: 61_000 })
			const validate = vi.mocked(CodeIndexServiceFactory.prototype.validateEmbedder)
			if (kind === "paused") pacer.reportRateLimit(error, pacer.markIssued())
			else validate.mockRejectedValueOnce(error)
			await manager.startIndexing()
			const argumentsUsed = vi.mocked(CodeIndexOrchestrator).mock.calls.at(-1)!
			expect(argumentsUsed[13]).toBe(registry)
			expect(argumentsUsed[14]).toBeTypeOf("function")
			expect(validate).toHaveBeenCalledTimes(kind === "paused" ? 0 : 1)
			const controller = new AbortController()
			const waiting = argumentsUsed[14]!(controller.signal).catch((failure: unknown) => failure)
			await drain()
			expect(manager.state).toBe("Indexing")
			expect(manager.getCurrentStatus().providerWaits).toEqual([
				expect.objectContaining({ resumeAt: Date.now() + 61_000, waitingFiles: [] }),
			])
			controller.abort()
			await expect(waiting).resolves.toBe(controller.signal.reason)
			await manager.stopIndexing()
			await manager.startIndexing()
			expect(manager.providerPacerRegistry).toBe(registry)
			expect(registry.get(services.embedder.rateLimitScope)).toBe(pacer)
			expect(vi.mocked(CodeIndexOrchestrator).mock.calls.at(-1)![14]).toBeTypeOf("function")
		},
	)

	it.each(["resolve", "reject"])("disposes stale parser and watcher after validation %s", async (ending) => {
		const held = deferred()
		vi.mocked(CodeIndexServiceFactory.prototype.validateEmbedder).mockImplementationOnce(async () => {
			await held.promise
			return { valid: true }
		})
		const startup = manager.startIndexing()
		await drain()
		const parser = manager["parser"]!
		await manager.stopIndexing()
		if (ending === "resolve") held.resolve()
		else held.reject(new Error("stale configuration error"))
		await startup
		expect(parser.stop).toHaveBeenCalled()
		expect(services.fileWatcher.dispose).toHaveBeenCalled()
		expect(CodeIndexOrchestrator).not.toHaveBeenCalled()
		expect(CodeIndexSearchService).not.toHaveBeenCalled()
		expect(manager["servicesStopped"]).toBe(true)
		expect(manager["startupFailureMessage"]).toBeUndefined()
	})

	it.each(["invalid", "throw"])("cleans up a non-deferred %s validation failure", async (kind) => {
		const validate = vi.mocked(CodeIndexServiceFactory.prototype.validateEmbedder)
		if (kind === "invalid") validate.mockResolvedValueOnce({ valid: false, error: "invalid configuration" })
		else validate.mockRejectedValueOnce(new Error("invalid configuration"))
		await expect(manager.startIndexing()).rejects.toThrow("invalid configuration")
		expect(services.fileWatcher.dispose).toHaveBeenCalled()
		expect(manager["parser"]!.stop).toHaveBeenCalled()
		expect(manager["startupFailureMessage"]).toBe("invalid configuration")
		expect(manager.state).toBe("Error")
		expect(CodeIndexOrchestrator).not.toHaveBeenCalled()
	})

	it("a deferred permanent validation failure is Error without startup failure, parser latch or clearing", async () => {
		vi.useFakeTimers()
		const { EmbeddingError } = await import("../shared/indexing-errors")
		const { CodeIndexOrchestrator: ActualOrchestrator } =
			await vi.importActual<typeof import("../orchestrator")>("../orchestrator")
		vi.mocked(CodeIndexOrchestrator).mockImplementation(
			(...argumentsUsed) => new ActualOrchestrator(...argumentsUsed),
		)
		const pacer = manager.providerPacerRegistry.get(services.embedder.rateLimitScope)
		pacer.reportRateLimit(
			new EmbeddingError("limited", { status: 429 }, { retryAfterMs: 1000 }),
			pacer.markIssued(),
		)
		vi.mocked(CodeIndexServiceFactory.prototype.validateEmbedder).mockResolvedValueOnce({
			valid: false,
			error: "bad key",
		})
		await manager.startIndexing()
		Object.defineProperty(manager["parser"]!, "stopped", { value: Promise.resolve() })
		expect(manager.state).toBe("Indexing")
		expect(manager["startupFailureMessage"]).toBeUndefined()
		await vi.advanceTimersByTimeAsync(1000)
		await drain()
		expect(manager.state).toBe("Error")
		expect(manager["startupFailureMessage"]).toBeUndefined()
		expect(manager["parserFailed"]).toBe(false)
		expect(CacheManager.prototype.clearCacheFile).not.toHaveBeenCalled()
		expect(manager["_orchestrator"]!["vectorStore"]).toBe(services.vectorStore)
	})

	it.each(["Error", "Stopping", "Indexed"] as const)("keeps %s during a search-only provider pause", async (raw) => {
		vi.useFakeTimers()
		const { EmbeddingError } = await import("../shared/indexing-errors")
		state.setSystemState(raw, "original")
		const pacer = manager.providerPacerRegistry.get(services.embedder.rateLimitScope)
		pacer.reportRateLimit(
			new EmbeddingError("limited", { status: 429 }, { retryAfterMs: 61_000 }),
			pacer.markIssued(),
		)
		expect(manager.getCurrentStatus()).toMatchObject({ systemStatus: raw, message: "original" })
		expect(manager.getCurrentStatus().providerWaits[0].waitingFiles).toEqual([])
	})

	it("publishes redacted relative waiting paths separately from genuine failures", async () => {
		vi.useFakeTimers()
		const { EmbeddingError } = await import("../shared/indexing-errors")
		const update = vi.fn()
		manager.onProgressUpdate(update)
		recordFailure()
		const pacer = manager.providerPacerRegistry.get(services.embedder.rateLimitScope)
		pacer.reportRateLimit(
			new EmbeddingError("limited", { status: 429 }, { retryAfterMs: 61_000 }),
			pacer.markIssued(),
		)
		const controller = new AbortController()
		const pending = pacer
			.run("/workspace/src/configured-secret.ts", controller.signal, async () => {})
			.catch(() => {})
		await drain()
		expect(update).toHaveBeenLastCalledWith(
			expect.objectContaining({
				systemStatus: "Indexing",
				providerWaits: [expect.objectContaining({ waitingFiles: [path.join("src", "[REDACTED].ts")] })],
				failedFiles: [expect.objectContaining({ path: "bad.ts" })],
			}),
		)
		state.setSystemState("Stopping", "stopping")
		controller.abort()
		await pending
		expect(manager.getCurrentStatus()).toMatchObject({ systemStatus: "Stopping", message: "stopping" })
	})
})
