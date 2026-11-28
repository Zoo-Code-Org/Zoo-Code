import { renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useEventCallback } from "../useEventCallback"

describe("useEventCallback", () => {
	it("keeps its identity while replacing the committed implementation", () => {
		const first = vi.fn((value: string) => `first:${value}`)
		const second = vi.fn((value: string) => `second:${value}`)
		const { result, rerender } = renderHook(({ callback }) => useEventCallback(callback), {
			initialProps: { callback: first },
		})
		const original = result.current
		expect(original("one")).toBe("first:one")
		rerender({ callback: second })
		expect(result.current).toBe(original)
		expect(original("two")).toBe("second:two")
		expect(first).toHaveBeenCalledTimes(1)
		expect(second).toHaveBeenCalledExactlyOnceWith("two")
	})

	it("forwards arguments, promises and errors without swallowing them", async () => {
		const failure = new Error("callback failed")
		const { result } = renderHook(() =>
			useEventCallback((value: number, reject: boolean) => {
				if (reject) throw failure
				return Promise.resolve(value + 1)
			}),
		)
		await expect(result.current(2, false)).resolves.toBe(3)
		expect(() => result.current(2, true)).toThrow(failure)
	})
})
