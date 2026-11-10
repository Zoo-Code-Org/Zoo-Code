import { changeMcpEnabled, reconcileMcpEnabled } from "../mcpEnabledChanges"

const createHub = () => {
	const releases: Array<() => void> = []
	const hub = {
		handleMcpEnabledChange: vi.fn((_enabled: boolean) => new Promise<void>((resolve) => releases.push(resolve))),
	}
	return { hub, releases }
}

describe("changeMcpEnabled", () => {
	it("applies a change, and nothing is kept once it is done", async () => {
		const { hub, releases } = createHub()

		const change = changeMcpEnabled(hub, false)
		await vi.waitFor(() => expect(releases).toHaveLength(1))
		releases[0]()
		await change

		expect(hub.handleMcpEnabledChange).toHaveBeenCalledExactlyOnceWith(false)
		// A later change of the same value is a new one: it is applied again.
		const again = changeMcpEnabled(hub, false)
		await vi.waitFor(() => expect(releases).toHaveLength(2))
		releases[1]()
		await again
		expect(hub.handleMcpEnabledChange).toHaveBeenCalledTimes(2)
	})

	it("joins a change of the same value that is still under way, as a retried save does: the disconnect starts once", async () => {
		const { hub, releases } = createHub()

		const first = changeMcpEnabled(hub, false) // stalled: its disconnect has not finished
		const retry = changeMcpEnabled(hub, false) // the save is sent again after the webview gave up on it
		const another = changeMcpEnabled(hub, false)
		await vi.waitFor(() => expect(releases).toHaveLength(1))
		releases[0]()

		await Promise.all([first, retry, another])
		expect(hub.handleMcpEnabledChange).toHaveBeenCalledTimes(1)
		expect(retry).toBe(first)
	})

	it("applies a different value after the one under way, in the order they were made", async () => {
		const { hub, releases } = createHub()

		const disable = changeMcpEnabled(hub, false)
		const enable = changeMcpEnabled(hub, true)
		await vi.waitFor(() => expect(releases).toHaveLength(1))
		expect(hub.handleMcpEnabledChange).toHaveBeenCalledTimes(1) // the second waits for the first
		releases[0]()
		await disable
		await vi.waitFor(() => expect(releases).toHaveLength(2))
		releases[1]()
		await enable

		expect(hub.handleMcpEnabledChange.mock.calls).toEqual([[false], [true]])
	})

	it("starts the next change when the one before it failed, and the failure is seen by whoever waited for it", async () => {
		const failing = {
			handleMcpEnabledChange: vi
				.fn<(enabled: boolean) => Promise<void>>()
				.mockRejectedValueOnce(new Error("transport stuck"))
				.mockResolvedValue(undefined),
		}

		const first = changeMcpEnabled(failing, false)
		const next = changeMcpEnabled(failing, true)

		await expect(first).rejects.toThrow("transport stuck")
		await expect(next).resolves.toBeUndefined()
		expect(failing.handleMcpEnabledChange.mock.calls).toEqual([[false], [true]])
	})

	it("leaves no unhandled rejection for a failure that nobody waited for", async () => {
		const unhandled = vi.fn()
		process.on("unhandledRejection", unhandled)
		try {
			const failing = { handleMcpEnabledChange: vi.fn(async () => Promise.reject(new Error("transport stuck"))) }

			void changeMcpEnabled(failing, false).catch(() => undefined)
			await new Promise((resolve) => setTimeout(resolve, 20))

			expect(unhandled).not.toHaveBeenCalled()
		} finally {
			process.off("unhandledRejection", unhandled)
		}
	})

	it("keeps hubs apart: a change of one does not hold up, or join, a change of another", async () => {
		const a = createHub()
		const b = createHub()

		void changeMcpEnabled(a.hub, false)
		void changeMcpEnabled(b.hub, false)

		await vi.waitFor(() => expect(a.releases).toHaveLength(1))
		await vi.waitFor(() => expect(b.releases).toHaveLength(1))
		expect(a.hub.handleMcpEnabledChange).toHaveBeenCalledTimes(1)
		expect(b.hub.handleMcpEnabledChange).toHaveBeenCalledTimes(1)
	})

	describe("a stalled change", () => {
		it("keeps at most one change waiting, whatever the number of saves that alternate the switch", async () => {
			const { hub, releases } = createHub()

			const first = changeMcpEnabled(hub, false) // stalled
			const waiting = Array.from({ length: 51 }, (_, i) => changeMcpEnabled(hub, i % 2 === 0))
			await vi.waitFor(() => expect(releases).toHaveLength(1))
			expect(hub.handleMcpEnabledChange).toHaveBeenCalledTimes(1)

			releases[0]()
			await first
			await vi.waitFor(() => expect(releases).toHaveLength(2))
			releases[1]()
			await Promise.all(waiting)

			// The stalled change, then only the latest value of the ones that waited (the last one asked for true).
			expect(hub.handleMcpEnabledChange.mock.calls).toEqual([[false], [true]])
			expect(new Set(waiting).size).toBe(1) // every caller of the waiting change is answered by the one that ran
		})

		it("applies nothing for a waiting change whose value turns out to be what was just applied", async () => {
			const { hub, releases } = createHub()

			const first = changeMcpEnabled(hub, false)
			const waiting = changeMcpEnabled(hub, true)
			const latest = changeMcpEnabled(hub, false) // replaces the waiting value: nothing is left to do after the first
			await vi.waitFor(() => expect(releases).toHaveLength(1))
			releases[0]()

			await Promise.all([first, waiting, latest])
			expect(hub.handleMcpEnabledChange).toHaveBeenCalledTimes(1)
		})

		it("applies the waiting value when the change before it failed, even if the value is the same", async () => {
			const failing = {
				handleMcpEnabledChange: vi
					.fn<(enabled: boolean) => Promise<void>>()
					.mockRejectedValueOnce(new Error("transport stuck"))
					.mockResolvedValue(undefined),
			}

			const first = changeMcpEnabled(failing, false)
			const retry = changeMcpEnabled(failing, true)
			const again = changeMcpEnabled(failing, false)

			await expect(first).rejects.toThrow("transport stuck")
			await Promise.all([retry, again])
			expect(failing.handleMcpEnabledChange.mock.calls).toEqual([[false], [false]])
		})
	})

	describe("reconcileMcpEnabled", () => {
		it("applies the stored value once the changes in line have settled, and only once for several saves that gave up", async () => {
			const { hub, releases } = createHub()
			void changeMcpEnabled(hub, false) // a save whose change stalled
			await vi.waitFor(() => expect(releases).toHaveLength(1))

			const getStored = vi.fn(() => true)
			const reconciles = Array.from({ length: 20 }, () => reconcileMcpEnabled(hub, getStored))
			expect(hub.handleMcpEnabledChange).toHaveBeenCalledTimes(1)
			releases[0]()
			await vi.waitFor(() => expect(releases).toHaveLength(2))
			releases[1]()
			await Promise.all(reconciles)

			expect(hub.handleMcpEnabledChange.mock.calls).toEqual([[false], [true]])
			expect(getStored).toHaveBeenCalledTimes(2) // read before the change and checked after it, not once for each of the 20 saves
		})

		it("waits for a change that was queued after the first one, and looks at what is stored then", async () => {
			const { hub, releases } = createHub()
			let stored = true
			void changeMcpEnabled(hub, false)
			const waiting = changeMcpEnabled(hub, true)
			const reconcile = reconcileMcpEnabled(hub, () => stored)
			await vi.waitFor(() => expect(releases).toHaveLength(1))
			releases[0]()
			await vi.waitFor(() => expect(releases).toHaveLength(2))
			stored = false // changed by the time the changes are done
			releases[1]()
			await waiting
			await vi.waitFor(() => expect(releases).toHaveLength(3))
			releases[2]()
			await reconcile

			expect(hub.handleMcpEnabledChange.mock.calls).toEqual([[false], [true], [false]])
		})

		it("checks again after its own change, so a change that joined while it ran does not leave the hub other than what is stored", async () => {
			const { hub, releases } = createHub()
			const stored = () => true // MCP stays stored as enabled: a later save that asked for false never stored it

			const reconcile = reconcileMcpEnabled(hub, stored) // nothing was applied before: it applies true, which stalls
			await vi.waitFor(() => expect(releases).toHaveLength(1))
			const timedOut = changeMcpEnabled(hub, false) // a second save: queued behind it
			const second = reconcileMcpEnabled(hub, stored) // and its reconciliation joins the one that runs
			expect(hub.handleMcpEnabledChange.mock.calls).toEqual([[true]])

			releases[0]() // true settles, and the waiting false starts
			await vi.waitFor(() => expect(releases).toHaveLength(2))
			releases[1]() // false settles
			await timedOut
			await vi.waitFor(() => expect(releases).toHaveLength(3)) // the hub is brought back to the stored value
			releases[2]()
			await Promise.all([reconcile, second])

			expect(hub.handleMcpEnabledChange.mock.calls).toEqual([[true], [false], [true]])
		})

		it("applies the same stored value again after a change that failed: the hub is not known to have it", async () => {
			const flaky = {
				handleMcpEnabledChange: vi
					.fn<(enabled: boolean) => Promise<void>>()
					.mockRejectedValueOnce(new Error("transport stuck"))
					.mockResolvedValue(undefined),
			}

			await reconcileMcpEnabled(flaky, () => true) // fails
			await reconcileMcpEnabled(flaky, () => true) // the same stored value: tried again, and it lands
			await reconcileMcpEnabled(flaky, () => true) // and now the hub is known to have it

			expect(flaky.handleMcpEnabledChange.mock.calls).toEqual([[true], [true]])
		})

		it("does not repeat a change that failed, so it cannot loop", async () => {
			const failing = { handleMcpEnabledChange: vi.fn(async () => Promise.reject(new Error("transport stuck"))) }

			await reconcileMcpEnabled(failing, () => true)

			expect(failing.handleMcpEnabledChange).toHaveBeenCalledTimes(1)
		})

		it("applies nothing when the stored value is the one the hub got last", async () => {
			const { hub, releases } = createHub()
			void changeMcpEnabled(hub, false)
			await vi.waitFor(() => expect(releases).toHaveLength(1))

			const reconcile = reconcileMcpEnabled(hub, () => false)
			releases[0]()
			await reconcile

			expect(hub.handleMcpEnabledChange).toHaveBeenCalledTimes(1)
		})

		it("can be started again after it is done", async () => {
			const { hub, releases } = createHub()
			const first = reconcileMcpEnabled(hub, () => true) // nothing was ever applied: the stored value is applied
			await vi.waitFor(() => expect(releases).toHaveLength(1))
			releases[0]()
			await first

			const again = reconcileMcpEnabled(hub, () => false)
			await vi.waitFor(() => expect(releases).toHaveLength(2))
			releases[1]()
			await again

			expect(hub.handleMcpEnabledChange.mock.calls).toEqual([[true], [false]])
		})
	})
})
