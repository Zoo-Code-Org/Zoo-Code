import { CodeIndexRun, CodeIndexRunState } from "../code-index-run"
import { StateHolder } from "../../../utils/StateHolder"

function createRun(): CodeIndexRun {
	return new CodeIndexRun(new AbortController(), new StateHolder<CodeIndexRunState>("running"))
}

describe("CodeIndexRun", () => {
	it("uses the injected controller and state holder", async () => {
		const controller = new AbortController()
		const stateHolder = new StateHolder<CodeIndexRunState>("running")
		const run = new CodeIndexRun(controller, stateHolder)
		expect(run.signal).toBe(controller.signal)
		expect(run.state).toBe(stateHolder)
		run.cancel()
		expect(controller.signal.aborted).toBe(true)
		expect(stateHolder.value).toBe("cancelling")
		run.finish()
		expect(stateHolder.value).toBe("finished")
		await expect(run.waitUntilFinished()).resolves.toBeUndefined()
	})

	it("starts without cancellation or destructive cleanup eligibility", () => {
		const run = createRun()
		expect(run.signal.aborted).toBe(false)
		expect(run.fullScanStarted).toBe(false)
	})

	it.each(["full", "incremental"] as const)("records when a %s scan starts", (mode) => {
		const run = createRun()
		run.markScanStarted(mode)
		expect(run.fullScanStarted).toBe(mode === "full")
	})

	it("keeps completion pending after cancellation until cleanup finishes", async () => {
		const run = createRun()
		const finished = vi.fn()
		const completion = run.waitUntilFinished().then(finished)
		const aborted = vi.fn()
		run.signal.addEventListener("abort", aborted)

		run.cancel()
		run.cancel()
		await Promise.resolve()
		expect(run.signal.aborted).toBe(true)
		expect(aborted).toHaveBeenCalledOnce()
		expect(finished).not.toHaveBeenCalled()

		run.finish()
		run.finish()
		await completion
		expect(finished).toHaveBeenCalledOnce()
	})

	it("finishes a successful run without cancelling it", async () => {
		const run = createRun()
		run.finish()
		await expect(run.waitUntilFinished()).resolves.toBeUndefined()
		expect(run.signal.aborted).toBe(false)
	})

	it("isolates cancellation, scan mode and completion between runs", async () => {
		const first = createRun()
		const second = createRun()
		const secondFinished = vi.fn()
		const completion = second.waitUntilFinished().then(secondFinished)
		first.markScanStarted("full")
		first.cancel()
		first.finish()
		await first.waitUntilFinished()

		expect(second.signal.aborted).toBe(false)
		expect(second.fullScanStarted).toBe(false)
		expect(secondFinished).not.toHaveBeenCalled()
		second.finish()
		await completion
	})

	it("notifies all waiters and releases their subscriptions", async () => {
		const run = createRun()
		const firstNotified = vi.fn()
		const secondNotified = vi.fn()
		const first = run.waitUntilFinished().then(firstNotified)
		const second = run.waitUntilFinished().then(secondNotified)
		await Promise.resolve()
		expect(firstNotified).not.toHaveBeenCalled()
		expect(secondNotified).not.toHaveBeenCalled()

		run.finish()
		await Promise.all([first, second])
		expect(firstNotified).toHaveBeenCalledOnce()
		expect(secondNotified).toHaveBeenCalledOnce()

		await expect(run.waitUntilFinished()).resolves.toBeUndefined()
		expect(run.state.value).toBe("finished")
	})

	it("replays state and publishes cancellation followed by completion", () => {
		const run = createRun()
		const states: string[] = []
		const subscription = run.state.subscribe((state) => states.push(state))
		run.cancel()
		run.cancel()
		run.finish()
		run.finish()
		run.cancel()
		expect(states).toEqual(["running", "cancelling", "finished"])
		subscription.unsubscribe()
	})
})
