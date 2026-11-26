import { describe, expect, it, vi } from "vitest"
import { snapshotHistory } from "../historySnapshot"

describe("snapshotHistory", () => {
	it("copies nested JSON containers without native string-copy serialization", () => {
		const native = vi.spyOn(globalThis, "structuredClone")
		try {
			const original = [{ text: "large immutable payload".repeat(10000), blocks: [{ values: [1, null, true] }] }]
			const snapshot = snapshotHistory(original)
			expect(snapshot).toEqual(original)
			original[0].blocks[0].values.push(2)
			expect(snapshot[0].blocks[0].values).toEqual([1, null, true])
			expect(native).not.toHaveBeenCalled()
		} finally {
			native.mockRestore()
		}
	})

	it("preserves aliases and cycles while isolating the graph", () => {
		const shared = { entries: ["first"] }
		const original: { left: typeof shared; right: typeof shared; self?: unknown } = { left: shared, right: shared }
		original.self = original
		const snapshot = snapshotHistory(original)
		expect(snapshot.left).toBe(snapshot.right)
		expect(snapshot.left).not.toBe(shared)
		expect(snapshot.self).toBe(snapshot)
	})

	it("preserves holes, explicit undefined, extra array properties and primitive values", () => {
		const original = new Array<unknown>(5)
		original[2] = undefined
		original[4] = { number: NaN, big: 123n, zero: -0 }
		Object.defineProperty(original, "extra", { value: { label: "legacy" }, enumerable: true })
		const snapshot = snapshotHistory(original)
		expect(snapshot).toEqual(original)
		expect(snapshot.length).toBe(5)
		expect(0 in snapshot).toBe(false)
		expect(2 in snapshot).toBe(true)
		expect(Object.getOwnPropertyDescriptor(snapshot, "extra")?.value).not.toBe(
			Object.getOwnPropertyDescriptor(original, "extra")?.value,
		)
	})

	it("preserves null prototypes and safely copies an own __proto__ property", () => {
		const original = JSON.parse('{"__proto__":{"polluted":true},"text":"legacy"}') as Record<string, unknown>
		Object.setPrototypeOf(original, null)
		const snapshot = snapshotHistory(original)
		expect(Object.getPrototypeOf(snapshot)).toBe(null)
		expect(Object.hasOwn(snapshot, "__proto__")).toBe(true)
		expect(snapshot["__proto__"]).toEqual({ polluted: true })
		expect(snapshot["__proto__"]).not.toBe(original["__proto__"])
		expect(Object.getPrototypeOf(snapshot["__proto__"])).toBe(Object.prototype)
	})

	it("falls back for the whole graph so special objects can refer back into plain containers", () => {
		const shared = { values: ["first"] }
		const buffer = new ArrayBuffer(8)
		const original: {
			shared: typeof shared
			map: Map<unknown, unknown>
			set: Set<unknown>
			date: Date
			buffer: ArrayBuffer
			view: Uint8Array
		} = {
			shared,
			map: new Map([[shared, shared]]),
			set: new Set([shared]),
			date: new Date(1234),
			buffer,
			view: new Uint8Array(buffer),
		}
		original.map.set("root", original)
		const snapshot = snapshotHistory(original)
		expect(snapshot).toEqual(structuredClone(original))
		expect(snapshot.map.get(snapshot.shared)).toBe(snapshot.shared)
		expect(snapshot.map.get("root")).toBe(snapshot)
		expect(snapshot.set.has(snapshot.shared)).toBe(true)
		expect(snapshot.view.buffer).toBe(snapshot.buffer)
		expect(snapshot.buffer).not.toBe(buffer)
		shared.values.push("changed")
		expect(snapshot.shared.values).toEqual(["first"])
	})

	it("uses native handling for accessors without evaluating a getter twice", () => {
		const getter = vi.fn(() => ({ text: "value" }))
		const original = {
			get field() {
				return getter()
			},
			date: new Date(0),
		}
		expect(snapshotHistory(original)).toEqual({ field: { text: "value" }, date: new Date(0) })
		expect(getter).toHaveBeenCalledTimes(1)
	})

	it.each([() => {}, Symbol("uncloneable")])("preserves native clone errors for unsupported values", (value) => {
		expect(() => snapshotHistory({ value })).toThrow()
	})

	it("does not treat a proxy as a plain serializable record", () => {
		expect(() => snapshotHistory({ value: new Proxy({ text: "value" }, {}) })).toThrow()
	})
})
