import { McpOAuthFlow, type McpOAuthFlowOutcome } from "../McpOAuthFlow"

// Invariants: McpOAuthFlowEnd.OneContinuation and NoOrphanFlow.
describe("McpOAuthFlow ownership", () => {
	it.each<McpOAuthFlowOutcome>(["connected", "cancelled", "timed-out", "removed", "failed"])(
		"one claimant and one completion survive %s",
		async (outcome) => {
			const flow = new McpOAuthFlow()
			const cleanup = vi.fn()
			flow.addCleanup(cleanup)
			expect(flow.claim()).toBe(true)
			expect(flow.claim()).toBe(false)
			flow.finish(outcome)
			flow.finish("failed")
			expect(flow.phase).toBe("ended")
			expect(flow.signal.aborted).toBe(["cancelled", "timed-out", "removed"].includes(outcome))
			expect(await flow.promise).toBe(outcome)
			expect(cleanup).toHaveBeenCalledOnce()
		},
	)

	// Invariant: McpOAuthFlowEnd.TimerOnlyWhileWaiting also applies to terminal exits.
	it.each<McpOAuthFlowOutcome>(["connected", "cancelled", "timed-out", "removed", "failed"])(
		"terminal transition %s clears the approval timer and stays ended",
		async (outcome) => {
			vi.useFakeTimers()
			const flow = new McpOAuthFlow()
			const expired = vi.fn()
			try {
				flow.setWaitingTimeout(expired, 300_000)
				flow.finish(outcome)
				expect(vi.getTimerCount()).toBe(0)
				flow.beginReconnect()
				expect(flow.claim()).toBe(false)
				expect(flow.phase).toBe("ended")
				await vi.advanceTimersByTimeAsync(300_000)
				expect(expired).not.toHaveBeenCalled()
				expect(await flow.promise).toBe(outcome)
			} finally {
				flow.finish("removed")
				vi.useRealTimers()
			}
		},
	)

	it.each(["browser", "reconnect"])("approval timer ends before %s work starts", async (step) => {
		vi.useFakeTimers()
		const flow = new McpOAuthFlow()
		const expired = vi.fn()
		try {
			flow.setWaitingTimeout(expired, 300_000)
			await vi.advanceTimersByTimeAsync(299_999)
			if (step === "browser") expect(flow.claim()).toBe(true)
			else flow.beginReconnect()
			expect(vi.getTimerCount()).toBe(0)
			await vi.advanceTimersByTimeAsync(300_000)
			expect(expired).not.toHaveBeenCalled()
			expect(flow.phase).toBe(step === "browser" ? "authenticating" : "reconnecting")
		} finally {
			flow.finish("removed")
			vi.useRealTimers()
		}
	})

	it("approval still times out while waiting for the user", async () => {
		vi.useFakeTimers()
		const flow = new McpOAuthFlow()
		try {
			flow.setWaitingTimeout(() => flow.finish("timed-out"), 300_000)
			await vi.advanceTimersByTimeAsync(300_000)
			expect(await flow.promise).toBe("timed-out")
			expect(flow.signal.reason).toBe("timed-out")
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			flow.finish("removed")
			vi.useRealTimers()
		}
	})

	it("disposes a listener returned after synchronous cancellation", async () => {
		const flow = new McpOAuthFlow()
		const dispose = vi.fn()
		// A cancellation registration can invoke its callback before returning its disposable.
		flow.finish("cancelled")
		flow.addCleanup(dispose)
		expect(dispose).toHaveBeenCalledOnce()
		expect(await flow.promise).toBe("cancelled")
	})

	it("releases remaining resources and the waiter when a cleanup throws", async () => {
		const flow = new McpOAuthFlow()
		const cleanup = vi.fn()
		const log = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			flow.addCleanup(cleanup)
			flow.addCleanup(() => {
				throw new Error("listener cleanup failed")
			})
			flow.finish("removed")
			expect(await flow.promise).toBe("removed")
			expect(cleanup).toHaveBeenCalledOnce()
			expect(log).toHaveBeenCalledWith("[McpHub] OAuth flow cleanup failed:", expect.any(Error))
		} finally {
			log.mockRestore()
		}
	})
})
