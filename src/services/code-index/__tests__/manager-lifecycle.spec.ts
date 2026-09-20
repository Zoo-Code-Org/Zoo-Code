import type { ContextProxy } from "../../../core/config/ContextProxy"
import { makeExtensionContext, makeUri } from "../../../test-utils/vscode"
import { CodeIndexManager } from "../manager"
import { SembleProvider } from "../semble"

const mocks = vi.hoisted(() => ({
	loadConfiguration: vi.fn<() => Promise<{ requiresRestart: boolean }>>(),
	initializeCache: vi.fn<() => Promise<void>>(),
	initializeProvider: vi.fn<() => Promise<void>>(),
	startIndexing: vi.fn<() => Promise<void>>(),
	stopIndexing: vi.fn(),
	disposeProvider: vi.fn(),
	disposeState: vi.fn(),
	setSystemState: vi.fn(),
}))

vi.mock("../config-manager", () => ({
	CodeIndexConfigManager: vi.fn().mockImplementation(function () {
		return {
			loadConfiguration: mocks.loadConfiguration,
			isFeatureEnabled: true,
			isFeatureConfigured: true,
			currentEmbedderProvider: "semble",
		}
	}),
}))
vi.mock("../cache-manager", () => ({
	CacheManager: vi.fn().mockImplementation(function () {
		return { initialize: mocks.initializeCache }
	}),
}))
vi.mock("../state-manager", () => ({
	CodeIndexStateManager: vi.fn().mockImplementation(function () {
		return { dispose: mocks.disposeState, setSystemState: mocks.setSystemState }
	}),
}))
vi.mock("../semble", () => ({
	SembleProvider: vi.fn().mockImplementation(function () {
		return {
			initialize: mocks.initializeProvider,
			startIndexing: mocks.startIndexing,
			stopIndexing: mocks.stopIndexing,
			dispose: mocks.disposeProvider,
		}
	}),
}))
vi.mock("../service-factory")
vi.mock("../search-service")
vi.mock("../orchestrator")
vi.mock("../../../core/ignore/RooIgnoreController")

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

describe("CodeIndexManager consumer-owned lifecycle", () => {
	let manager: CodeIndexManager
	// Configuration is mocked, so this dependency is only passed through.
	const contextProxy = {} as ContextProxy

	beforeEach(() => {
		vi.clearAllMocks()
		mocks.loadConfiguration.mockReset()
		mocks.initializeCache.mockReset()
		mocks.initializeProvider.mockReset()
		mocks.loadConfiguration.mockResolvedValue({ requiresRestart: false })
		mocks.initializeCache.mockResolvedValue(undefined)
		mocks.initializeProvider.mockResolvedValue(undefined)
		mocks.startIndexing.mockResolvedValue(undefined)
		const uri = makeUri("/workspace")
		manager = new CodeIndexManager(uri.fsPath, uri, makeExtensionContext())
		vi.spyOn(manager, "isWorkspaceEnabled", "get").mockReturnValue(true)
	})

	it("starts resources before the consumer performs its single disposal", async () => {
		await expect(manager.initialize(contextProxy)).resolves.toEqual({ requiresRestart: false })
		expect(mocks.initializeCache).toHaveBeenCalledOnce()
		expect(mocks.initializeProvider).toHaveBeenCalledOnce()
		expect(mocks.startIndexing).toHaveBeenCalledOnce()
		manager.dispose()
		expect(mocks.stopIndexing).toHaveBeenCalledOnce()
		expect(mocks.disposeProvider).toHaveBeenCalledOnce()
		expect(mocks.disposeState).toHaveBeenCalledOnce()
	})

	it("supports intentional sequential configuration reload without recreating unchanged services", async () => {
		await manager.initialize(contextProxy)
		await expect(manager.initialize(contextProxy)).resolves.toEqual({ requiresRestart: false })
		expect(mocks.loadConfiguration).toHaveBeenCalledTimes(2)
		expect(SembleProvider).toHaveBeenCalledOnce()
		expect(mocks.startIndexing).toHaveBeenCalledOnce()
		manager.dispose()
	})

	it("recreates services for a sequential restart request", async () => {
		await manager.initialize(contextProxy)
		mocks.loadConfiguration.mockResolvedValueOnce({ requiresRestart: true })
		await expect(manager.initialize(contextProxy)).resolves.toEqual({ requiresRestart: true })
		expect(SembleProvider).toHaveBeenCalledTimes(2)
		expect(mocks.disposeProvider).toHaveBeenCalledOnce()
		expect(mocks.startIndexing).toHaveBeenCalledTimes(2)
		manager.dispose()
	})

	it("allows initialization after explicit error recovery", async () => {
		const error = new Error("configuration unavailable")
		mocks.loadConfiguration.mockRejectedValueOnce(error)
		await expect(manager.initialize(contextProxy)).rejects.toBe(error)
		await manager.recoverFromError()
		await expect(manager.initialize(contextProxy)).resolves.toEqual({ requiresRestart: false })
		expect(mocks.startIndexing).toHaveBeenCalledOnce()
		manager.dispose()
	})

	it.each(["configuration", "cache", "provider"] as const)(
		"propagates %s initialization rejection",
		async (stage) => {
			const error = new Error(`${stage} unavailable`)
			const operation = {
				configuration: mocks.loadConfiguration,
				cache: mocks.initializeCache,
				provider: mocks.initializeProvider,
			}[stage]
			operation.mockRejectedValueOnce(error)
			await expect(manager.initialize(contextProxy)).rejects.toBe(error)
			expect(mocks.startIndexing).not.toHaveBeenCalled()
			manager.dispose()
		},
	)

	// Characterize unsupported ordering, not desired safety guarantees. Consumers must
	// await initialization before disposal and must not initialize concurrently.
	it.each(["configuration", "cache"] as const)(
		"documents resources starting after disposal during %s initialization",
		async (stage) => {
			const entered = deferred<void>()
			const release = deferred<void>()
			if (stage === "configuration") {
				mocks.loadConfiguration.mockImplementationOnce(async () => {
					entered.resolve()
					await release.promise
					return { requiresRestart: false }
				})
			} else {
				mocks.initializeCache.mockImplementationOnce(() => {
					entered.resolve()
					return release.promise
				})
			}
			const initialization = manager.initialize(contextProxy)
			await entered.promise
			manager.dispose()
			release.resolve()
			await initialization
			expect(mocks.disposeState).toHaveBeenCalledOnce()
			expect(mocks.startIndexing).toHaveBeenCalledOnce()
			expect(mocks.disposeState.mock.invocationCallOrder[0]).toBeLessThan(
				mocks.startIndexing.mock.invocationCallOrder[0],
			)
			expect(mocks.disposeProvider).not.toHaveBeenCalled()
		},
	)

	it("documents initialization reporting success after disposal clears a pending provider", async () => {
		const entered = deferred<void>()
		const release = deferred<void>()
		mocks.initializeProvider.mockImplementationOnce(() => {
			entered.resolve()
			return release.promise
		})
		const initialization = manager.initialize(contextProxy)
		await entered.promise
		manager.dispose()
		release.resolve()
		await expect(initialization).resolves.toEqual({ requiresRestart: false })
		expect(manager.isInitialized).toBe(false)
		expect(mocks.disposeProvider).toHaveBeenCalledOnce()
		expect(mocks.disposeState).toHaveBeenCalledOnce()
		expect(mocks.startIndexing).not.toHaveBeenCalled()
	})

	it("documents concurrent initialization starting indexing before shared cache readiness", async () => {
		const entered = deferred<void>()
		const release = deferred<void>()
		mocks.initializeCache.mockImplementationOnce(() => {
			entered.resolve()
			return release.promise
		})
		const first = manager.initialize(contextProxy)
		await entered.promise
		await manager.initialize(contextProxy)
		const startedBeforeCacheReady = mocks.startIndexing.mock.calls.length
		release.resolve()
		await first
		manager.dispose()
		expect(startedBeforeCacheReady).toBe(1)
	})
})
