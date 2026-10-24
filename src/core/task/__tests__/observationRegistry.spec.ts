import { describe, it, expect, vi } from "vitest"

import { ObservationRegistry } from "../observationRegistry"

describe("ObservationRegistry", () => {
	it("observe → get returns the recorded version and observedAt", () => {
		const reg = new ObservationRegistry()
		reg.observe("/a/b/c.ts", "1:2:300:4000000000:5000000000")

		const obs = reg.get("/a/b/c.ts")
		expect(obs).toBeDefined()
		expect(obs!.version).toBe("1:2:300:4000000000:5000000000")
		expect(typeof obs!.observedAt).toBe("number")
	})

	it("re-observe replaces the entry with a fresh observedAt", () => {
		vi.useFakeTimers()
		const reg = new ObservationRegistry()
		reg.observe("/a/b/c.ts", "v1")
		const first = reg.get("/a/b/c.ts")!
		expect(first.version).toBe("v1")

		vi.advanceTimersByTime(50)
		reg.observe("/a/b/c.ts", "v2")
		const second = reg.get("/a/b/c.ts")!
		expect(second.version).toBe("v2")
		expect(second.observedAt).toBeGreaterThan(first.observedAt)

		vi.useRealTimers()
	})

	it("has returns true for observed paths, false otherwise", () => {
		const reg = new ObservationRegistry()
		reg.observe("/x.ts", "t1")
		expect(reg.has("/x.ts")).toBe(true)
		expect(reg.has("/y.ts")).toBe(false)
	})

	it("size reflects the number of observed entries", () => {
		const reg = new ObservationRegistry()
		expect(reg.size).toBe(0)
		reg.observe("/a.ts", "t1")
		reg.observe("/b.ts", "t2")
		expect(reg.size).toBe(2)
	})

	it("clear removes all entries and resets size to 0", () => {
		const reg = new ObservationRegistry()
		reg.observe("/a.ts", "t1")
		reg.observe("/b.ts", "t2")
		reg.clear()
		expect(reg.size).toBe(0)
		expect(reg.get("/a.ts")).toBeUndefined()
		expect(reg.has("/b.ts")).toBe(false)
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

	describe("forget", () => {
		it("removes the entry and reports that it removed one", () => {
			const registry = new ObservationRegistry()
			registry.observe("/a.ts", "1:1:1:1:1", true)

			expect(registry.forget("/a.ts")).toBe(true)
			expect(registry.has("/a.ts")).toBe(false)
			expect(registry.get("/a.ts")).toBeUndefined()
			expect(registry.size).toBe(0)
		})

		it("reports false for a path it never observed, and changes nothing", () => {
			const registry = new ObservationRegistry()
			registry.observe("/a.ts", "1:1:1:1:1", true)

			expect(registry.forget("/missing.ts")).toBe(false)
			expect(registry.size).toBe(1)
			expect(registry.get("/a.ts")?.version).toBe("1:1:1:1:1")
		})

		it("leaves the other entries alone - that is why a caller uses forget and not clear", () => {
			// A caller revoking an authorization it did not earn must not discard the
			// observations other reads of the same task still rely on.
			const registry = new ObservationRegistry()
			registry.observe("/a.ts", "1:1:1:1:1", true)
			registry.observe("/b.ts", "2:2:2:2:2", false)

			expect(registry.forget("/a.ts")).toBe(true)
			expect(registry.get("/b.ts")).toEqual({
				version: "2:2:2:2:2",
				observedAt: expect.any(Number),
				complete: false,
			})
			expect(registry.size).toBe(1)
		})
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
})
