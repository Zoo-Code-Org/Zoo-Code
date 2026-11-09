import { changeMcpEnabled } from "../mcpEnabledChanges"

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
})
