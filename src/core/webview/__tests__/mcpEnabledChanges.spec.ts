import { changeMcpEnabled, reconcileMcpEnabled } from "../mcpEnabledChanges"

type McpOwner = Parameters<typeof reconcileMcpEnabled>[1]

const createHub = () => {
	const releases: Array<() => void> = []
	const hub = {
		handleMcpEnabledChange: vi.fn((_enabled: boolean) => new Promise<void>((resolve) => releases.push(resolve))),
	}
	return { hub, releases }
}

/** A provider, as far as a reconciliation asks of it: the stored setting, and whether it was closed. */
const ownerOf = (stored: () => boolean, disposed = false): McpOwner => ({
	isDisposed: disposed,
	contextProxy: { getValue: () => stored() },
})

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

	describe("a save that gives up on the change that waits for its turn", () => {
		it("drops the change when it is the only save that asked for it, so it does not start later", async () => {
			const { hub, releases } = createHub()
			const giveUp = new AbortController()

			void changeMcpEnabled(hub, true) // stalled
			const waiting = changeMcpEnabled(hub, false, giveUp.signal) // behind it
			const rejected = expect(waiting).rejects.toThrow("save timed out")
			giveUp.abort(new Error("save timed out"))
			await rejected
			await vi.waitFor(() => expect(releases).toHaveLength(1))
			releases[0]() // the stalled change lands at last
			await new Promise((resolve) => setTimeout(resolve, 20))

			expect(hub.handleMcpEnabledChange.mock.calls).toEqual([[true]]) // the disable never starts
		})

		it("keeps the change that another save still waits for, with the value of the one that is left", async () => {
			const { hub, releases } = createHub()
			const first = new AbortController()
			const second = new AbortController()

			void changeMcpEnabled(hub, true) // stalled
			const a = changeMcpEnabled(hub, false, first.signal)
			const b = changeMcpEnabled(hub, true, second.signal) // the latest value that is asked for ...
			// Each caller has its own promise: one that gives up is answered at once, the other goes on waiting.
			expect(b).not.toBe(a)
			const aLeft = a.catch(() => undefined)
			const bGaveUp = expect(b).rejects.toThrow("gave up") // answered at once, and not left unhandled
			second.abort(new Error("gave up")) // ... is given up on: the value of the other save is what waits
			await bGaveUp

			await vi.waitFor(() => expect(releases).toHaveLength(1))
			releases[0]()
			await vi.waitFor(() => expect(releases).toHaveLength(2))
			releases[1]()
			await aLeft

			expect(hub.handleMcpEnabledChange.mock.calls).toEqual([[true], [false]])
		})

		it("drops the change only when every save that asked for it has given up", async () => {
			const { hub, releases } = createHub()
			const first = new AbortController()
			const second = new AbortController()

			void changeMcpEnabled(hub, true)
			const waiting = changeMcpEnabled(hub, false, first.signal)
			const other = changeMcpEnabled(hub, false, second.signal)
			const otherGaveUp = expect(other).rejects.toThrow("gave up")
			const rejected = expect(waiting).rejects.toThrow("gave up")
			first.abort(new Error("gave up"))
			await Promise.resolve()
			expect(hub.handleMcpEnabledChange).toHaveBeenCalledTimes(1) // one save is still waiting for it
			second.abort(new Error("gave up"))
			await rejected
			await otherGaveUp

			releases[0]()
			await new Promise((resolve) => setTimeout(resolve, 20))
			expect(hub.handleMcpEnabledChange.mock.calls).toEqual([[true]])
		})

		it("cannot take back a change that has started: the caller that gave up is answered, and the change goes on", async () => {
			const { hub, releases } = createHub()
			const giveUp = new AbortController()

			const running = changeMcpEnabled(hub, false, giveUp.signal) // starts at once
			await vi.waitFor(() => expect(releases).toHaveLength(1))
			const rejected = expect(running).rejects.toThrow("gave up")
			giveUp.abort(new Error("gave up"))
			await rejected // the caller is not held by it
			releases[0]() // the change itself lands

			await new Promise((resolve) => setTimeout(resolve, 10))
			expect(hub.handleMcpEnabledChange.mock.calls).toEqual([[false]])
		})

		it("does not take back a change that has started when its save gives up: the save is answered, the change lands", async () => {
			const { hub, releases } = createHub()
			const giveUp = new AbortController()

			void changeMcpEnabled(hub, true) // stalled
			const waiting = changeMcpEnabled(hub, false, giveUp.signal)
			await vi.waitFor(() => expect(releases).toHaveLength(1))
			releases[0]() // it lands, and the waiting change starts
			await vi.waitFor(() => expect(releases).toHaveLength(2))
			const rejected = expect(waiting).rejects.toThrow("gave up")
			giveUp.abort(new Error("gave up")) // too late to take it back: it is under way
			await rejected
			releases[1]()
			await new Promise((resolve) => setTimeout(resolve, 10))

			expect(hub.handleMcpEnabledChange.mock.calls).toEqual([[true], [false]])
		})

		it("lets go of the signal of every save that gives up, while the shared change stays stalled", async () => {
			const { hub, releases } = createHub()
			void changeMcpEnabled(hub, true) // stalled
			const staying = changeMcpEnabled(hub, false) // a save that stays: it waits for the change behind it

			for (let i = 0; i < 200; i++) {
				const giveUp = new AbortController()
				const add = vi.spyOn(giveUp.signal, "addEventListener")
				const remove = vi.spyOn(giveUp.signal, "removeEventListener")
				const waiting = changeMcpEnabled(hub, i % 2 === 0, giveUp.signal) // joins the running or the waiting one
				const rejected = expect(waiting).rejects.toThrow("gave up")
				giveUp.abort(new Error("gave up"))
				await rejected

				// The listener that the save put on its signal is the one that was taken off again.
				const added = add.mock.calls.filter(([type]) => type === "abort").map(([, listener]) => listener)
				const removed = remove.mock.calls.filter(([type]) => type === "abort").map(([, listener]) => listener)
				expect(added).toHaveLength(1)
				expect(removed).toEqual(added)
			}

			// And the change they gave up on goes on for the save that stayed.
			releases[0]()
			await vi.waitFor(() => expect(releases).toHaveLength(2))
			releases[1]()
			await expect(staying).resolves.toBeUndefined()
			expect(hub.handleMcpEnabledChange.mock.calls).toEqual([[true], [false]])
		})

		it("answers a save that gives up at once, while another save still waits for the same change, which goes on", async () => {
			const { hub, releases } = createHub()
			const first = new AbortController()
			const second = new AbortController()

			void changeMcpEnabled(hub, true) // stalled: the providers of both saves wait behind it
			const a = changeMcpEnabled(hub, false, first.signal)
			const b = changeMcpEnabled(hub, false, second.signal)
			const aLeft = expect(a).rejects.toThrow("provider of the first save was disposed")
			first.abort(new Error("provider of the first save was disposed"))
			await aLeft // answered at once, though the change is stalled and the second save still waits for it

			await vi.waitFor(() => expect(releases).toHaveLength(1))
			releases[0]()
			await vi.waitFor(() => expect(releases).toHaveLength(2))
			releases[1]()
			await expect(b).resolves.toBeUndefined() // the change that the other save needs was not cancelled
			expect(hub.handleMcpEnabledChange.mock.calls).toEqual([[true], [false]])
		})

		it("makes no change for a signal that has already been aborted", async () => {
			const { hub } = createHub()
			const giveUp = new AbortController()
			giveUp.abort(new Error("already gone"))

			await expect(changeMcpEnabled(hub, false, giveUp.signal)).rejects.toThrow("already gone")

			expect(hub.handleMcpEnabledChange).not.toHaveBeenCalled()
		})

		it("removes the listener that it added to the signal once the change is done", async () => {
			const { hub, releases } = createHub()
			const controller = new AbortController()
			const add = vi.spyOn(controller.signal, "addEventListener")
			const remove = vi.spyOn(controller.signal, "removeEventListener")

			void changeMcpEnabled(hub, true)
			const waiting = changeMcpEnabled(hub, false, controller.signal)
			await vi.waitFor(() => expect(releases).toHaveLength(1))
			releases[0]()
			await vi.waitFor(() => expect(releases).toHaveLength(2))
			releases[1]()
			await waiting

			const listeners = (calls: typeof add.mock.calls) =>
				calls.filter(([type]) => type === "abort").map(([, listener]) => listener)
			await vi.waitFor(() => expect(listeners(remove.mock.calls)).toHaveLength(listeners(add.mock.calls).length))
			expect(listeners(add.mock.calls).length).toBeGreaterThan(0)
			// Every listener that was added is the one that is removed.
			expect(new Set(listeners(remove.mock.calls))).toEqual(new Set(listeners(add.mock.calls)))
		})
	})

	describe("reconcileMcpEnabled", () => {
		it("applies the stored value once the changes in line have settled, and only once for several saves that gave up", async () => {
			const { hub, releases } = createHub()
			void changeMcpEnabled(hub, false) // a save whose change stalled
			await vi.waitFor(() => expect(releases).toHaveLength(1))

			const getStored = vi.fn(() => true)
			const owner = ownerOf(getStored)
			const reconciles = Array.from({ length: 20 }, () => reconcileMcpEnabled(hub, owner))
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
			const reconcile = reconcileMcpEnabled(
				hub,
				ownerOf(() => stored),
			)
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
			const owner = ownerOf(() => true) // MCP stays stored as enabled: a later save that asked for false never stored it

			const reconcile = reconcileMcpEnabled(hub, owner) // nothing was applied before: it applies true, which stalls
			await vi.waitFor(() => expect(releases).toHaveLength(1))
			const timedOut = changeMcpEnabled(hub, false) // a second save: queued behind it
			const second = reconcileMcpEnabled(hub, owner) // and its reconciliation joins the one that runs
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

			const owner = ownerOf(() => true)
			await reconcileMcpEnabled(flaky, owner) // fails
			await reconcileMcpEnabled(flaky, owner) // the same stored value: tried again, and it lands
			await reconcileMcpEnabled(flaky, owner) // and now the hub is known to have it

			expect(flaky.handleMcpEnabledChange.mock.calls).toEqual([[true], [true]])
		})

		it("does not repeat a change that failed, so it cannot loop", async () => {
			const failing = { handleMcpEnabledChange: vi.fn(async () => Promise.reject(new Error("transport stuck"))) }

			await reconcileMcpEnabled(
				failing,
				ownerOf(() => true),
			)

			expect(failing.handleMcpEnabledChange).toHaveBeenCalledTimes(1)
		})

		it("applies nothing when the stored value is the one the hub got last", async () => {
			const { hub, releases } = createHub()
			void changeMcpEnabled(hub, false)
			await vi.waitFor(() => expect(releases).toHaveLength(1))

			const reconcile = reconcileMcpEnabled(
				hub,
				ownerOf(() => false),
			)
			releases[0]()
			await reconcile

			expect(hub.handleMcpEnabledChange).toHaveBeenCalledTimes(1)
		})

		it("asks no provider that has been closed, and applies nothing for it", async () => {
			const { hub, releases } = createHub()
			void changeMcpEnabled(hub, false)
			await vi.waitFor(() => expect(releases).toHaveLength(1))
			const closed = ownerOf(() => true, true)

			const reconcile = reconcileMcpEnabled(hub, closed) // the provider that asked was closed meanwhile
			releases[0]()
			await reconcile

			expect(hub.handleMcpEnabledChange.mock.calls).toEqual([[false]]) // nothing that a closed provider stores is applied
		})

		it("uses a provider that is still open when the one that asked first was closed, with a shared hub", async () => {
			const { hub, releases } = createHub()
			void changeMcpEnabled(hub, false)
			await vi.waitFor(() => expect(releases).toHaveLength(1))
			let closedNow = false
			const first: McpOwner = {
				get isDisposed() {
					return closedNow
				},
				contextProxy: { getValue: () => true },
			}
			const second = ownerOf(() => true)

			const a = reconcileMcpEnabled(hub, first)
			const b = reconcileMcpEnabled(hub, second) // the call is joined by the one that runs
			closedNow = true // the first provider is closed while the change is stalled
			releases[0]()
			await vi.waitFor(() => expect(releases).toHaveLength(2))
			releases[1]()
			await Promise.all([a, b])

			expect(hub.handleMcpEnabledChange.mock.calls).toEqual([[false], [true]]) // the open provider's setting is applied
		})

		it("does not keep a provider that asked: only a weak reference to it is held", () => {
			const { hub } = createHub()
			const owner = ownerOf(() => true)
			const refs: WeakRef<object>[] = []
			const original = globalThis.WeakRef
			globalThis.WeakRef = class<T extends object> extends original<T> {
				constructor(target: T) {
					super(target)
					refs.push(this)
				}
			} as unknown as typeof WeakRef
			try {
				void reconcileMcpEnabled(hub, owner)
			} finally {
				globalThis.WeakRef = original
			}

			expect(refs).toHaveLength(1)
			expect(refs[0].deref()).toBe(owner)
		})

		it("goes on when the change that it waits for fails, and applies what is stored", async () => {
			const rejects: Array<(error: unknown) => void> = []
			const hub = {
				handleMcpEnabledChange: vi
					.fn<(enabled: boolean) => Promise<void>>()
					.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => rejects.push(reject)))
					.mockResolvedValue(undefined),
			}
			void changeMcpEnabled(hub, true).catch(() => undefined) // stalls, and then fails
			await vi.waitFor(() => expect(rejects).toHaveLength(1))
			const owner = ownerOf(() => false)

			const reconcile = reconcileMcpEnabled(hub, owner)
			rejects[0](new Error("transport stuck"))
			await reconcile

			expect(hub.handleMcpEnabledChange.mock.calls).toEqual([[true], [false]])
		})

		it("can be started again after it is done", async () => {
			const { hub, releases } = createHub()
			const first = reconcileMcpEnabled(
				hub,
				ownerOf(() => true),
			) // nothing was ever applied: the stored value is applied
			await vi.waitFor(() => expect(releases).toHaveLength(1))
			releases[0]()
			await first

			const again = reconcileMcpEnabled(
				hub,
				ownerOf(() => false),
			)
			await vi.waitFor(() => expect(releases).toHaveLength(2))
			releases[1]()
			await again

			expect(hub.handleMcpEnabledChange.mock.calls).toEqual([[true], [false]])
		})
	})
})
