import { StateHolder } from "../StateHolder"

describe("StateHolder", () => {
	it("replays current state, publishes changes and suppresses identical values", () => {
		const holder = new StateHolder(0)
		const listener = vi.fn()
		const subscription = holder.subscribe(listener)
		holder.set(1)
		holder.set(1)
		expect(holder.value).toBe(1)
		expect(listener.mock.calls).toEqual([[0], [1]])
		subscription.unsubscribe()
		subscription.unsubscribe()
		holder.set(2)
		expect(listener).toHaveBeenCalledTimes(2)
	})

	it("registers the same callback independently", () => {
		const holder = new StateHolder(0)
		const listener = vi.fn()
		const first = holder.subscribe(listener)
		const second = holder.subscribe(listener)
		first.unsubscribe()
		listener.mockClear()
		holder.set(1)
		expect(listener).toHaveBeenCalledExactlyOnceWith(1)
		second.unsubscribe()
	})

	it("skips a subscriber removed by an earlier listener during notification", () => {
		const holder = new StateHolder(0)
		const first = holder.subscribe((value) => {
			if (value === 1) second.unsubscribe()
		})
		const removedListener = vi.fn()
		const second = holder.subscribe(removedListener)
		const remainingListener = vi.fn()
		const third = holder.subscribe(remainingListener)
		removedListener.mockClear()
		remainingListener.mockClear()

		holder.set(1)
		holder.set(2)

		expect(removedListener).not.toHaveBeenCalled()
		expect(remainingListener.mock.calls).toEqual([[1], [2]])
		expect(holder.value).toBe(2)
		first.unsubscribe()
		third.unsubscribe()
	})

	it("resolves immediately for matching current state without retaining a listener", async () => {
		const holder = new StateHolder("finished")
		await expect(holder.waitFor((value) => value === "finished")).resolves.toBe("finished")
		expect(holder["listeners"].size).toBe(0)
	})

	it("waits for matching state and removes each completed waiter", async () => {
		const holder = new StateHolder(0)
		const notified = vi.fn()
		const first = holder.waitFor((value) => value === 2).then(notified)
		const second = holder.waitFor((value) => value === 3)
		holder.set(1)
		await Promise.resolve()
		expect(notified).not.toHaveBeenCalled()
		holder.set(2)
		await first
		expect(notified).toHaveBeenCalledExactlyOnceWith(2)
		expect(holder["listeners"].size).toBe(1)
		holder.set(3)
		await expect(second).resolves.toBe(3)
		expect(holder["listeners"].size).toBe(0)
	})

	it.each([0, 1])("rejects and unsubscribes when a predicate throws at state %s", async (failureState) => {
		const holder = new StateHolder(0)
		const error = new Error("predicate failed")
		const waiting = holder.waitFor((value) => {
			if (value === failureState) throw error
			return false
		})
		const assertion = expect(waiting).rejects.toBe(error)
		holder.set(1)
		await assertion
		expect(holder["listeners"].size).toBe(0)
	})

	it("removes a subscription if initial replay throws", () => {
		const holder = new StateHolder(0)
		expect(() =>
			holder.subscribe(() => {
				throw new Error("replay failed")
			}),
		).toThrow("replay failed")
		expect(holder["listeners"].size).toBe(0)
	})
})
