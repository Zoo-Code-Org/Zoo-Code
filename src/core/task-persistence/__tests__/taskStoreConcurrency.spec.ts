import type { HistoryItem } from "@roo-code/types"

import { computeHistoryDelta, DeltaRejectedError, mergeHistoryDelta } from "../taskStoreConcurrency"

function item(status: HistoryItem["status"]): HistoryItem {
	return {
		id: "task",
		number: 1,
		ts: 1,
		task: "task",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		status,
	}
}

describe("mergeHistoryDelta", () => {
	it("rejects an explicit undefined status that would revive a completed task", () => {
		const disk = item("completed")
		const incoming = { ...disk, status: undefined, mode: "must-not-commit" }

		expect(() =>
			mergeHistoryDelta(disk, incoming, { id: disk.id, status: undefined, mode: "must-not-commit" }),
		).toThrow(DeltaRejectedError)
		expect(disk.status).toBe("completed")
		expect("mode" in disk).toBe(false)
	})

	it("normalizes a legacy undefined disk status to explicit active", () => {
		const disk = item(undefined)
		const incoming = { ...disk, status: undefined }

		expect(mergeHistoryDelta(disk, incoming, { id: disk.id, status: undefined }).status).toBe("active")
	})
})

describe("computeHistoryDelta", () => {
	it("leaves out a field that equals the cached one", () => {
		expect(computeHistoryDelta(item("active"), { mode: "code", tokensIn: 0 } as Partial<HistoryItem>)).toEqual({
			mode: "code",
		})
	})

	it("always carries an explicit undefined usageByModel, even when the cache has none either", () => {
		const delta = computeHistoryDelta(item("active"), { usageByModel: undefined, tokensIn: 0 })

		expect(Object.keys(delta)).toEqual(["usageByModel"])
	})

	it("still carries a usageByModel that changed, and leaves out one that did not", () => {
		const usage = [{ apiProvider: "p", modelId: "m", requests: 1, tokensIn: 1, tokensOut: 1, cost: 0 }]
		const cached = { ...item("active"), usageByModel: usage }

		expect(computeHistoryDelta(cached, { usageByModel: usage })).toEqual({})
		expect(computeHistoryDelta(cached, { usageByModel: [] })).toEqual({ usageByModel: [] })
	})

	it("omits an undefined other field when the cache has no value for it either", () => {
		expect(computeHistoryDelta(item("active"), { mode: undefined })).toEqual({})
	})

	it("carries an undefined other field as an ordinary change when the cache has a value for it", () => {
		const cached = { ...item("active"), mode: "code" }

		expect(computeHistoryDelta(cached, { mode: undefined })).toEqual({ mode: undefined })
	})

	it("does not keep an undefined other field on every save: only usageByModel is a standing decision", () => {
		const delta = computeHistoryDelta(item("active"), { mode: undefined, usageByModel: undefined })

		expect(Object.keys(delta)).toEqual(["usageByModel"])
	})

	it("lets mergeHistoryDelta clear the usage another host wrote", () => {
		const onDisk = { ...item("active"), usageByModel: [{ requests: 1 }] }
		const delta = computeHistoryDelta(item("active"), { usageByModel: undefined })

		const merged = mergeHistoryDelta(onDisk, item("active"), delta)

		expect(JSON.parse(JSON.stringify(merged)).usageByModel).toBeUndefined()
	})
})
