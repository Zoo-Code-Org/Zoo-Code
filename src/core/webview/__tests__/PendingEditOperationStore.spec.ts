import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { PendingEditOperationStore, type PendingEditOperationInput } from "../PendingEditOperationStore.js"

describe("PendingEditOperationStore", () => {
	const editData: PendingEditOperationInput = {
		messageTs: 123,
		editedContent: "edited",
		images: ["image.png"],
		messageIndex: 1,
		apiConversationHistoryIndex: 2,
	}

	let log: ReturnType<typeof vi.fn<(message: string) => void>>
	let store: PendingEditOperationStore

	beforeEach(() => {
		vi.useFakeTimers()
		log = vi.fn<(message: string) => void>()
		store = new PendingEditOperationStore(1_000, log)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("clears a prior operation with the same id", () => {
		store.set("op", editData)
		vi.advanceTimersByTime(500)

		store.set("op", { ...editData, editedContent: "replacement" })
		vi.advanceTimersByTime(500)

		expect(store.get("op")).toMatchObject({ editedContent: "replacement" })
		expect(log).toHaveBeenCalledWith("[PendingEditOperationStore.clear] Cleared pending operation: op")

		vi.advanceTimersByTime(500)

		expect(store.get("op")).toBeUndefined()
	})

	it("returns false on clear miss and true on hit", () => {
		expect(store.clear("missing")).toBe(false)

		store.set("op", editData)

		expect(store.clear("op")).toBe(true)
		expect(store.get("op")).toBeUndefined()
	})

	it("hides timer metadata from get results", () => {
		store.set("op", editData)

		const operation = store.get("op")

		expect(operation).toEqual(editData)
		expect(operation).not.toHaveProperty("timeoutId")
		expect(operation).not.toHaveProperty("createdAt")
	})

	it("protects stored images from external mutation", () => {
		const images = ["before.png"]
		store.set("op", { ...editData, images })

		images.push("input-mutation.png")
		const operation = store.get("op")
		operation?.images?.push("output-mutation.png")

		expect(store.get("op")?.images).toEqual(["before.png"])
	})

	it("auto-clears after timeoutMs and logs", () => {
		store.set("op", editData)

		vi.advanceTimersByTime(1_000)

		expect(store.get("op")).toBeUndefined()
		expect(log).toHaveBeenCalledWith(
			"[PendingEditOperationStore.set] Automatically cleared stale pending operation: op",
		)
	})

	it("clearAll clears timers without later auto-clear logs", () => {
		store.set("op-1", editData)
		store.set("op-2", { ...editData, editedContent: "second" })

		store.clearAll()
		log.mockClear()

		vi.advanceTimersByTime(1_000)

		expect(store.get("op-1")).toBeUndefined()
		expect(store.get("op-2")).toBeUndefined()
		expect(log).not.toHaveBeenCalled()
	})
})
