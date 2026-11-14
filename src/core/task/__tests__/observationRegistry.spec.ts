import { describe, it, expect, vi } from "vitest"

import { ObservationRegistry } from "../observationRegistry"

describe("ObservationRegistry", () => {
	it("observe → get returns the recorded version and observedAt", () => {
		// typeof number accepts 0 and NaN, so pin the exact timestamp instead: a
		// broken clock that returns some other number must not pass.
		vi.useFakeTimers()
		vi.setSystemTime(new Date(Date.UTC(2025, 0, 1, 0, 0, 0, 0)))
		try {
			const reg = new ObservationRegistry()
			reg.observe("/a/b/c.ts", "1:2:300:4000000000:5000000000")
			const obs = reg.get("/a/b/c.ts")
			expect(obs).toBeDefined()
			expect(obs!.version).toBe("1:2:300:4000000000:5000000000")
			expect(obs!.observedAt).toBe(Date.UTC(2025, 0, 1, 0, 0, 0, 0))
		} finally {
			vi.useRealTimers()
		}
	})

	it("re-observe replaces the entry with a fresh observedAt", () => {
		vi.useFakeTimers()
		try {
			const reg = new ObservationRegistry()
			reg.observe("/a/b/c.ts", "v1")
			const first = reg.get("/a/b/c.ts")!
			expect(first.version).toBe("v1")

			vi.advanceTimersByTime(50)
			reg.observe("/a/b/c.ts", "v2")
			const second = reg.get("/a/b/c.ts")!
			expect(second.version).toBe("v2")
			expect(second.observedAt).toBeGreaterThan(first.observedAt)
		} finally {
			// Teardown in finally so a failing assertion cannot leak fake
			// timers or the mocked Date into subsequent tests.
			vi.useRealTimers()
		}
	})

	it("get on empty registry returns undefined", () => {
		const reg = new ObservationRegistry()
		expect(reg.get("/any.ts")).toBeUndefined()
	})

	it("separate instances are independent — observing in one does not appear in the other", () => {
		const regA = new ObservationRegistry()
		const regB = new ObservationRegistry()
		regA.observe("/shared.ts", "v1")
		expect(regA.get("/shared.ts")).toBeDefined()
		expect(regB.get("/shared.ts")).toBeUndefined()
		regB.observe("/shared.ts", "v2")
		expect(regA.get("/shared.ts")!.version).toBe("v1")
		expect(regB.get("/shared.ts")!.version).toBe("v2")
	})

	describe("completeness scope (S4b follow-up #46)", () => {
		it("defaults to a complete observation when the read scope is not given", () => {
			const reg = new ObservationRegistry()
			reg.observe("/a/b/c.ts", "v1")

			expect(reg.get("/a/b/c.ts")!.complete).toBe(true)
		})

		it("records a partial observation when the read only returned a view of the file", () => {
			const reg = new ObservationRegistry()
			reg.observe("/a/b/c.ts", "v1", false)

			expect(reg.get("/a/b/c.ts")!.complete).toBe(false)
		})

		it("re-observing replaces the entry's completeness with the new read's scope", () => {
			const reg = new ObservationRegistry()
			reg.observe("/a/b/c.ts", "v1", false)
			reg.observe("/a/b/c.ts", "v2")

			const obs = reg.get("/a/b/c.ts")!
			expect(obs.version).toBe("v2")
			expect(obs.complete).toBe(true)
		})

		it("re-observing with a partial scope downgrades a previously complete entry", () => {
			const reg = new ObservationRegistry()
			reg.observe("/a/b/c.ts", "v1")
			reg.observe("/a/b/c.ts", "v2", false)

			const obs = reg.get("/a/b/c.ts")!
			expect(obs.version).toBe("v2")
			expect(obs.complete).toBe(false)
		})
	})

	describe("closure on task disposal", () => {
		it("close drops every entry and reports the registry closed", () => {
			const reg = new ObservationRegistry()
			reg.observe("/a/b/c.ts", "v1")
			expect(reg.closed).toBe(false)

			reg.close()

			expect(reg.get("/a/b/c.ts")).toBeUndefined()
			expect(reg.closed).toBe(true)
		})

		it("observe is a no-op after close, so a read resuming after disposal records nothing", () => {
			const reg = new ObservationRegistry()
			reg.close()

			reg.observe("/late.ts", "v1")
		})
	})

	it("forget drops a warm entry so a later read cannot be guarded by a stale token", () => {
		const reg = new ObservationRegistry()
		reg.observe("/x.ts", "t1")

		// The warm case: an entry from an earlier read must not survive a read that could not
		// compute a token for the current on-disk version.
		expect(reg.forget("/x.ts")).toBe(true)
		expect(reg.get("/x.ts")).toBeUndefined()

		// The cold case: forgetting an unobserved path is a no-op, not an error.
		expect(reg.forget("/y.ts")).toBe(false)
		expect(reg.get("/y.ts")).toBeUndefined()
	})
})
