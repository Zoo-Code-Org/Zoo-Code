import { Uri } from "vscode"
import type { FileWatcherEvent } from "../../interfaces/file-watcher-event"
import { FileEventAccumulator } from "../file-event-accumulator"

vi.mock("vscode", async () => {
	const { makeEventEmitter, makeUri } = await import("../../../../test-utils/vscode")
	return {
		Uri: { file: makeUri },
		EventEmitter: vi.fn().mockImplementation(function () {
			return makeEventEmitter()
		}),
	}
})

describe("FileEventAccumulator", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => {
		vi.clearAllTimers()
		vi.useRealTimers()
	})

	it("clears pending events and removes the timer on repeated disposal", async () => {
		const onBatch = vi.fn()
		const accumulator = new FileEventAccumulator()
		accumulator.onBatchReady(onBatch)
		accumulator.dispose()
		expect(vi.getTimerCount()).toBe(0)
		accumulator.add({ uri: Uri.file("/workspace/file.ts"), type: "change" })
		expect(vi.getTimerCount()).toBe(1)
		accumulator.dispose()
		accumulator.dispose()
		expect(accumulator.hasPendingEvents).toBe(false)
		expect(vi.getTimerCount()).toBe(0)
		await vi.advanceTimersByTimeAsync(1000)
		expect(onBatch).not.toHaveBeenCalled()
	})

	it("keeps an event added by a batch subscriber for the next debounce window", async () => {
		const uri = Uri.file("/workspace/file.ts")
		const batches: Map<string, FileWatcherEvent>[] = []
		const accumulator = new FileEventAccumulator(25)
		accumulator.onBatchReady((batch) => {
			batches.push(batch)
			expect(accumulator.hasPendingEvents).toBe(false)
			if (batches.length === 1) accumulator.add({ uri, type: "delete" })
		})
		accumulator.add({ uri, type: "create" })
		await vi.advanceTimersByTimeAsync(25)
		expect(batches).toEqual([new Map([[uri.fsPath, { uri, type: "create" }]])])
		expect(accumulator.hasPendingEvents).toBe(true)
		await vi.advanceTimersByTimeAsync(24)
		expect(batches).toHaveLength(1)
		await vi.advanceTimersByTimeAsync(1)
		expect(batches).toEqual([
			new Map([[uri.fsPath, { uri, type: "create" }]]),
			new Map([[uri.fsPath, { uri, type: "delete" }]]),
		])
		expect(accumulator.hasPendingEvents).toBe(false)
		accumulator.dispose()
	})

	it("allows a subscriber to unsubscribe without affecting other subscribers", async () => {
		const accumulator = new FileEventAccumulator()
		const removed = vi.fn()
		const active = vi.fn()
		const subscription = accumulator.onBatchReady(removed)
		accumulator.onBatchReady(active)
		subscription.dispose()
		const uri = Uri.file("/workspace/file.ts")
		accumulator.add({ uri, type: "change" })
		await vi.advanceTimersByTimeAsync(500)
		expect(removed).not.toHaveBeenCalled()
		expect(active).toHaveBeenCalledExactlyOnceWith(new Map([[uri.fsPath, { uri, type: "change" }]]))
		accumulator.dispose()
	})

	it("replaces a deletion with recreation while retaining events for other paths", async () => {
		const onBatch = vi.fn<(events: Map<string, FileWatcherEvent>) => void>()
		const accumulator = new FileEventAccumulator()
		accumulator.onBatchReady(onBatch)
		const uri = Uri.file("/workspace/recreated.ts")
		const otherUri = Uri.file("/workspace/other.ts")
		expect(accumulator.hasPendingEvents).toBe(false)

		accumulator.add({ uri, type: "delete" })
		accumulator.add({ uri: otherUri, type: "change" })
		accumulator.add({ uri, type: "create" })
		expect(accumulator.hasPendingEvents).toBe(true)
		await vi.advanceTimersByTimeAsync(500)

		expect(onBatch).toHaveBeenCalledExactlyOnceWith(
			new Map([
				[uri.fsPath, { uri, type: "create" }],
				[otherUri.fsPath, { uri: otherUri, type: "change" }],
			]),
		)
		expect(accumulator.hasPendingEvents).toBe(false)
		expect(vi.getTimerCount()).toBe(0)
		accumulator.dispose()
	})
})
