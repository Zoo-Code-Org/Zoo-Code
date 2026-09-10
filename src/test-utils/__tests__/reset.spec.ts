import nock from "nock"
import { describe, expect, it, vi } from "vitest"

import { clearAllMocks, deleteGlobalFetch, resetNock, restoreGlobals } from "../reset"

describe("test reset utilities", () => {
	it("clears and restores Vitest mocks", () => {
		const mock = vi.fn()
		mock()

		clearAllMocks()
		expect(mock).not.toHaveBeenCalled()

		const target = { method: () => "original" }
		vi.spyOn(target, "method").mockReturnValue("mocked")
		expect(target.method()).toBe("mocked")

		restoreGlobals()
		expect(target.method()).toBe("original")
	})

	it("deletes the global fetch override", () => {
		const originalFetch = globalThis.fetch
		Object.defineProperty(globalThis, "fetch", {
			configurable: true,
			writable: true,
			value: vi.fn(),
		})

		deleteGlobalFetch()

		expect("fetch" in globalThis).toBe(false)

		if (originalFetch) {
			Object.defineProperty(globalThis, "fetch", {
				configurable: true,
				writable: true,
				value: originalFetch,
			})
		}
	})

	it("cleans pending nock scopes", () => {
		nock("https://test.example").get("/health").reply(200)
		expect(nock.pendingMocks()).toHaveLength(1)

		resetNock()

		expect(nock.pendingMocks()).toEqual([])
	})
})
