import { IndexWriteGate, LATE_WRITE_GRACE_MS } from "../index-write-gate"

function deferred() {
	let resolve!: () => void
	let reject!: (error: Error) => void
	const promise = new Promise<void>((complete, fail) => {
		resolve = complete
		reject = fail
	})
	return { promise, resolve, reject }
}

describe("IndexWriteGate", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(100_000)
	})

	afterEach(() => {
		vi.clearAllTimers()
		vi.useRealTimers()
	})

	it.each(["already aborted", "aborted before issue"])("refuses %s writes without uncertainty", async (timing) => {
		const gate = new IndexWriteGate()
		const attempt = new AbortController()
		const write = vi.fn()
		if (timing === "already aborted") attempt.abort()
		const rejected = expect(gate.run(attempt.signal, write, ["file.ts"])).rejects.toMatchObject({
			name: "AbortError",
		})
		attempt.abort()
		await rejected
		expect(write).not.toHaveBeenCalled()
		expect(gate.uncertainFiles(attempt.signal)).toEqual([])
		expect(gate.needsReconciliation("file.ts")).toBe(false)
		expect(gate.hasPending(attempt.signal)).toBe(false)
	})

	it.each(["resolve", "reject"] as const)(
		"never waits across attempts when an old write will %s",
		async (outcome) => {
			const gate = new IndexWriteGate()
			const oldAttempt = new AbortController()
			const nextAttempt = new AbortController()
			const held = deferred()
			const oldWrite = vi.fn(() => held.promise)
			const pending = gate.run(oldAttempt.signal, oldWrite, ["file.ts"]).catch((error) => error)
			await Promise.resolve()
			expect(oldWrite).toHaveBeenCalledOnce()
			oldAttempt.abort()
			const newWrite = vi.fn(() => "current")
			await expect(gate.run(nextAttempt.signal, newWrite, ["retry.ts"])).resolves.toBe("current")
			expect(newWrite).toHaveBeenCalledOnce()
			expect(gate.hasPending(oldAttempt.signal)).toBe(true)
			expect(gate.hasPending(nextAttempt.signal)).toBe(false)
			if (outcome === "resolve") held.resolve()
			else held.reject(new Error("Request timeout"))
			await pending
			expect(gate.uncertainFiles(oldAttempt.signal)).toEqual(outcome === "reject" ? ["file.ts"] : [])
			expect(gate.needsReconciliation("file.ts")).toBe(outcome === "reject")
			expect(gate.needsReconciliation("retry.ts")).toBe(false)
		},
	)

	it("discards a successful write after abort without extending an existing uncertainty deadline", async () => {
		const gate = new IndexWriteGate()
		const attempt = new AbortController()
		gate.recover(["file.ts"])
		const deadline = gate.graceDeadline("file.ts")
		await vi.advanceTimersByTimeAsync(1000)
		await expect(
			gate.run(
				attempt.signal,
				async () => {
					attempt.abort()
					return "remote success"
				},
				["file.ts"],
			),
		).rejects.toMatchObject({ name: "AbortError" })
		expect(gate.uncertainFiles(attempt.signal)).toEqual([])
		expect(gate.graceDeadline("file.ts")).toBe(deadline)
	})

	it.each([new Error("Transport failure"), new DOMException("Cancelled remotely", "AbortError")])(
		"marks issued rejection uncertain even for $name",
		async (failure) => {
			const gate = new IndexWriteGate()
			const attempt = new AbortController()
			await expect(
				gate.run(attempt.signal, () => Promise.reject(failure), ["first.ts", "second.ts"]),
			).rejects.toBe(failure)
			expect(gate.uncertainFiles(attempt.signal)).toEqual(["first.ts", "second.ts"])
			const done = vi.fn()
			const grace = gate.waitForGrace("first.ts", attempt.signal).then(done)
			await vi.advanceTimersByTimeAsync(LATE_WRITE_GRACE_MS - 1)
			expect(done).not.toHaveBeenCalled()
			await vi.advanceTimersByTimeAsync(1)
			await grace
			expect(done).toHaveBeenCalledOnce()
			expect(gate.needsReconciliation("first.ts")).toBe(true)
			gate.reconciled("first.ts")
			expect(gate.needsReconciliation("first.ts")).toBe(false)
		},
	)

	it("starts rejection grace when rejection is observed, not when the request was issued", async () => {
		const gate = new IndexWriteGate()
		const attempt = new AbortController()
		const held = deferred()
		const pending = gate.run(attempt.signal, () => held.promise, ["file.ts"]).catch(() => {})
		await vi.advanceTimersByTimeAsync(50_000)
		held.reject(new Error("Timeout"))
		await pending
		const done = vi.fn()
		const grace = gate.waitForGrace("file.ts", attempt.signal).then(done)
		await vi.advanceTimersByTimeAsync(LATE_WRITE_GRACE_MS - 1)
		expect(done).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		await grace
	})

	it("starts stop-expiry grace on abandon and tracks only pending writes from that attempt", async () => {
		const gate = new IndexWriteGate()
		const oldAttempt = new AbortController()
		const otherAttempt = new AbortController()
		const held = deferred()
		const otherHeld = deferred()
		const pending = gate.run(oldAttempt.signal, () => held.promise, ["old.ts"]).catch(() => {})
		const otherPending = gate.run(otherAttempt.signal, () => otherHeld.promise, ["other.ts"])
		await vi.advanceTimersByTimeAsync(2000)
		oldAttempt.abort()
		gate.abandon(oldAttempt.signal)
		expect(gate.uncertainFiles(oldAttempt.signal)).toEqual(["old.ts"])
		expect(gate.needsReconciliation("other.ts")).toBe(false)
		const done = vi.fn()
		const grace = gate.waitForGrace("old.ts", otherAttempt.signal).then(done)
		await vi.advanceTimersByTimeAsync(LATE_WRITE_GRACE_MS - 1)
		expect(done).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		await grace
		held.resolve()
		otherHeld.resolve()
		await Promise.all([pending, otherPending])
	})

	it("uses cache-load time and extends an active wait without shortening its deadline", async () => {
		const gate = new IndexWriteGate()
		const attempt = new AbortController()
		gate.recover(["file.ts"], Date.now() - 10_000)
		const done = vi.fn()
		const grace = gate.waitForGrace("file.ts", attempt.signal).then(done)
		await vi.advanceTimersByTimeAsync(5000)
		gate.recover(["file.ts"])
		gate.recover(["file.ts"], Date.now() - 50_000)
		await vi.advanceTimersByTimeAsync(LATE_WRITE_GRACE_MS - 1)
		expect(done).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		await grace
		expect(done).toHaveBeenCalledOnce()
	})

	it("cancels grace promptly and cleans up its timer while retaining uncertainty", async () => {
		const gate = new IndexWriteGate()
		const attempt = new AbortController()
		gate.recover(["file.ts"])
		const rejected = expect(gate.waitForGrace("file.ts", attempt.signal)).rejects.toMatchObject({
			name: "AbortError",
		})
		expect(vi.getTimerCount()).toBe(1)
		attempt.abort()
		await rejected
		expect(vi.getTimerCount()).toBe(0)
		expect(gate.needsReconciliation("file.ts")).toBe(true)
		await expect(gate.waitForGrace("unaffected.ts", attempt.signal)).rejects.toMatchObject({ name: "AbortError" })
	})

	it("tracks combined watcher cancellation under its orchestrator attempt", async () => {
		const gate = new IndexWriteGate()
		const owner = new AbortController()
		const local = new AbortController()
		const combined = AbortSignal.any([owner.signal, local.signal])
		gate.own(combined, owner.signal)
		const held = deferred()
		const pending = gate.run(combined, () => held.promise, ["watcher.ts"]).catch(() => {})
		await Promise.resolve()
		expect(gate.hasPending(owner.signal)).toBe(true)
		owner.abort()
		gate.abandon(owner.signal)
		expect(gate.uncertainFiles(owner.signal)).toEqual(["watcher.ts"])
		held.resolve()
		await pending
		await gate.settled(owner.signal)
		expect(gate.hasPending(owner.signal)).toBe(false)
	})

	it("completion excludes its current owner, live attempts and unrelated aborted files", async () => {
		const gate = new IndexWriteGate()
		const current = new AbortController()
		const local = new AbortController()
		const combined = AbortSignal.any([current.signal, local.signal])
		gate.own(combined, current.signal)
		const live = new AbortController()
		const old = new AbortController()
		const held = deferred()
		const writes = [
			gate.run(current.signal, () => held.promise, ["file.ts"]),
			gate.run(live.signal, () => held.promise, ["file.ts"]),
			gate.run(old.signal, () => held.promise, ["unrelated.ts"]).catch(() => {}),
		]
		await Promise.resolve()
		old.abort()
		await expect(gate.waitForPriorWrites("file.ts", combined)).resolves.toBe(false)
		expect(gate.graceDeadline("file.ts")).toBe(0)
		held.resolve()
		await Promise.all(writes)
	})

	it("bounds a prior aborted write without an orchestrator stop and never repeats abandonment", async () => {
		const gate = new IndexWriteGate()
		const old = new AbortController()
		const current = new AbortController()
		const held = deferred()
		const pending = gate.run(old.signal, () => held.promise, ["file.ts"]).catch(() => {})
		await Promise.resolve()
		old.abort()
		const done = vi.fn()
		const wait = gate.waitForPriorWrites("file.ts", current.signal).then(done)
		await vi.advanceTimersByTimeAsync(1999)
		expect(done).not.toHaveBeenCalled()
		expect(gate.graceDeadline("file.ts")).toBe(0)
		await vi.advanceTimersByTimeAsync(1)
		await wait
		expect(done).toHaveBeenCalledWith(true)
		expect(gate.graceDeadline("file.ts")).toBe(132_000)
		await vi.advanceTimersByTimeAsync(1000)
		gate.abandon(old.signal)
		await expect(gate.waitForPriorWrites("file.ts", current.signal)).resolves.toBe(false)
		expect(gate.graceDeadline("file.ts")).toBe(132_000)
		held.reject(new Error("Late rejection"))
		await pending
		expect(gate.graceDeadline("file.ts")).toBe(133_000)
	})

	it("uses the orchestrator expiry without rebuilding it on abort", async () => {
		const gate = new IndexWriteGate()
		const old = new AbortController()
		const current = new AbortController()
		const held = deferred()
		const pending = gate.run(old.signal, () => held.promise, ["file.ts"]).catch(() => {})
		await Promise.resolve()
		gate.stopAt(old.signal, Date.now() + 2000)
		await vi.advanceTimersByTimeAsync(500)
		old.abort()
		const done = vi.fn()
		const wait = gate.waitForPriorWrites("file.ts", current.signal).then(done)
		await vi.advanceTimersByTimeAsync(1499)
		expect(done).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		await wait
		expect(gate.graceDeadline("file.ts")).toBe(132_000)
		held.resolve()
		await pending
	})

	it("uses the abort stop deadline even when completion starts after its expiry", async () => {
		const gate = new IndexWriteGate()
		const old = new AbortController()
		const current = new AbortController()
		const held = deferred()
		const pending = gate.run(old.signal, () => held.promise, ["file.ts"]).catch(() => {})
		await Promise.resolve()
		old.abort()
		await vi.advanceTimersByTimeAsync(5000)
		await gate.waitForPriorWrites("file.ts", current.signal)
		expect(gate.graceDeadline("file.ts")).toBe(132_000)
		held.resolve()
		await pending
	})

	it("cancels the prior-outcome wait and clears its timer without creating uncertainty", async () => {
		const gate = new IndexWriteGate()
		const old = new AbortController()
		const current = new AbortController()
		const held = deferred()
		const pending = gate.run(old.signal, () => held.promise, ["file.ts"]).catch(() => {})
		await Promise.resolve()
		old.abort()
		const wait = expect(gate.waitForPriorWrites("file.ts", current.signal)).rejects.toMatchObject({
			name: "AbortError",
		})
		expect(vi.getTimerCount()).toBe(1)
		current.abort()
		await wait
		expect(vi.getTimerCount()).toBe(0)
		expect(gate.graceDeadline("file.ts")).toBe(0)
		held.resolve()
		await pending
	})

	it("settles only its own attempt and successful writes introduce no uncertainty", async () => {
		const gate = new IndexWriteGate()
		const attempt = new AbortController()
		const other = new AbortController()
		const held = deferred()
		const pending = gate.run(other.signal, () => held.promise, ["other.ts"])
		await gate.run(attempt.signal, () => 42, ["file.ts"])
		await gate.settled(attempt.signal)
		expect(gate.hasPending(other.signal)).toBe(true)
		const done = vi.fn()
		const settled = gate.settled(other.signal).then(done)
		await Promise.resolve()
		expect(done).not.toHaveBeenCalled()
		held.resolve()
		await Promise.all([pending, settled])
		expect(gate.needsReconciliation("file.ts")).toBe(false)
		expect(gate.uncertainFiles(other.signal)).toEqual([])
	})
})
