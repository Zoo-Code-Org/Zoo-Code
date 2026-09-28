import { CodeIndexRecovery } from "../code-index-recovery"
import { CodeIndexRun, type CodeIndexRunState } from "../code-index-run"
import { StateHolder } from "../../../utils/StateHolder"

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: { instance: { captureEvent: vi.fn() } },
}))
vi.mock("../../../i18n", () => ({
	t: (key: string, options?: { errorMessage?: unknown }) => `${key}:${options?.errorMessage ?? ""}`,
}))

function setup() {
	const cache = { flush: vi.fn().mockResolvedValue(undefined), clearCacheFile: vi.fn().mockResolvedValue(undefined) }
	const store = { clearCollection: vi.fn().mockResolvedValue(undefined) }
	const state = { setSystemState: vi.fn() }
	const watcher = { stop: vi.fn() }
	const run = new CodeIndexRun(new AbortController(), new StateHolder<CodeIndexRunState>("running"))
	return { cache, store, state, watcher, run, recovery: new CodeIndexRecovery(cache, store, state, watcher) }
}

describe("CodeIndexRecovery", () => {
	it.each([true, undefined])(
		"preserves preexisting or unknown data during full-scan recovery (%s)",
		async (presence) => {
			const { recovery, cache, store, run } = setup()
			run.preexistingCodePoints = presence
			run.markScanStarted("full")
			await recovery.handle(new Error("scan failed"), run)
			expect(store.clearCollection).not.toHaveBeenCalled()
			expect(cache.clearCacheFile).not.toHaveBeenCalled()
		},
	)

	it.each(["preparation", "incremental", "full"] as const)("applies cleanup policy for %s failures", async (mode) => {
		const { recovery, cache, store, state, watcher, run } = setup()
		run.preexistingCodePoints = false
		if (mode !== "preparation") run.markScanStarted(mode)
		await recovery.handle(new Error("scan failed"), run)
		expect(store.clearCollection).toHaveBeenCalledTimes(mode === "full" ? 1 : 0)
		expect(cache.clearCacheFile).toHaveBeenCalledTimes(mode === "full" ? 1 : 0)
		expect(state.setSystemState).toHaveBeenLastCalledWith("Error", expect.stringContaining("scan failed"))
		expect(watcher.stop).toHaveBeenCalledOnce()
		expect(run.state.value).toBe("running")
	})

	it.each(["signal", "AbortError"])("preserves data when cancellation is identified by %s", async (kind) => {
		const { recovery, cache, store, state, watcher, run } = setup()
		run.markScanStarted("full")
		if (kind === "signal") run.cancel()
		const error = kind === "signal" ? new Error("interrupted") : new DOMException("Stopped", "AbortError")
		await recovery.handle(error, run)
		expect(cache.flush).toHaveBeenCalledOnce()
		expect(store.clearCollection).not.toHaveBeenCalled()
		expect(cache.clearCacheFile).not.toHaveBeenCalled()
		expect(watcher.stop).toHaveBeenCalledOnce()
		expect(state.setSystemState).toHaveBeenLastCalledWith("Standby", expect.any(String))
		expect(run.state.value).not.toBe("finished")
	})

	it("finishes cancellation recovery even if flushing fails", async () => {
		const { recovery, cache, state, watcher, run } = setup()
		run.cancel()
		cache.flush.mockRejectedValue(new Error("flush failed"))
		await recovery.handle(new Error("stopped"), run)
		expect(watcher.stop).toHaveBeenCalledOnce()
		expect(state.setSystemState).toHaveBeenLastCalledWith("Standby", expect.any(String))
	})

	it("attempts cache cleanup after collection cleanup fails and preserves the original failure", async () => {
		const { recovery, cache, store, state, watcher, run } = setup()
		run.preexistingCodePoints = false
		run.markScanStarted("full")
		store.clearCollection.mockRejectedValue(new Error("collection cleanup failed"))
		cache.clearCacheFile.mockRejectedValue(new Error("cache cleanup failed"))
		await recovery.handle(new Error("original failure"), run)
		expect(cache.clearCacheFile).toHaveBeenCalledOnce()
		expect(watcher.stop).toHaveBeenCalledOnce()
		expect(state.setSystemState).toHaveBeenLastCalledWith("Error", expect.stringContaining("original failure"))
	})

	it("reports clearing errors without initiating additional destructive cleanup", () => {
		const { recovery, cache, store, state } = setup()
		recovery.handleClearError("delete failed")
		expect(state.setSystemState).toHaveBeenCalledWith("Error", "Failed to clear index data: delete failed")
		expect(store.clearCollection).not.toHaveBeenCalled()
		expect(cache.clearCacheFile).not.toHaveBeenCalled()
	})
})
