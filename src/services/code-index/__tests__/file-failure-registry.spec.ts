import { FileFailureRegistry } from "../file-failure-registry"

describe("FileFailureRegistry", () => {
	it("CI-FR-01/02: batches of one revision share a budget; a new revision or reset refills it", () => {
		const registry = new FileFailureRegistry()
		registry.renew("a.ts", "one")
		registry.renew("b.ts", "one")
		const budget = registry.getRetryBudget("a.ts", "one", "embed")
		budget.retriesUsed = 2
		expect(registry.getRetryBudget("a.ts", "one", "embed")).toBe(budget)
		expect(registry.getRetryBudget("a.ts", "one", "upsert").retriesUsed).toBe(0)
		registry.renew("b.ts", "two")
		expect(registry.getRetryBudget("a.ts", "one", "embed").retriesUsed).toBe(2)
		registry.renew("a.ts", "two")
		expect(registry.getRetryBudget("a.ts", "two", "embed").retriesUsed).toBe(0)
		registry.getRetryBudget("a.ts", "two", "embed").retriesUsed = 1
		registry.resetAllBudgets()
		expect(registry.getRetryBudget("a.ts", "two", "embed").retriesUsed).toBe(0)
		registry.getRetryBudget("a.ts", "two", "embed").retriesUsed = 1
		registry.clear("a.ts", "two")
		expect(registry.getRetryBudget("a.ts", "two", "embed").retriesUsed).toBe(0)
	})

	it("keeps a displayed entry across a reset and a new revision until it is cleared", () => {
		const registry = new FileFailureRegistry()
		registry.renew("a.ts", "one")
		registry.record("a.ts", "one", "upsert", "server failed", 3, "exhausted", "server")
		registry.resetAllBudgets()
		registry.renew("a.ts", "two")
		expect(registry.list()).toEqual([
			expect.objectContaining({ path: "a.ts", revision: "two", state: "exhausted" }),
		])
		registry.clear("a.ts", "two")
		expect(registry.list()).toEqual([])
	})

	it("rejects stale records and clearing after a path is renewed", () => {
		const registry = new FileFailureRegistry()
		registry.renew("a.ts", "old")
		registry.record("a.ts", "old", "embed", "failed", 1, "retrying", "connection")
		registry.renew("a.ts", "new")
		expect(registry.isCurrent("a.ts", "old")).toBe(false)
		registry.record("a.ts", "new", "parse", "new failure", 1, "exhausted")
		registry.record("a.ts", "old", "delete", "late failure", 3, "exhausted")
		registry.clear("a.ts", "old")
		expect(registry.list()[0]).toMatchObject({ revision: "new", activity: "parse", reason: "new failure" })
	})

	it("signals each change and returns detached details", () => {
		const registry = new FileFailureRegistry()
		const changed = vi.fn()
		const subscription = registry.onDidChange(changed)
		registry.renew("a.ts", "hash")
		registry.record("a.ts", "hash", "upsert", "busy", 1, "retrying", "server")
		registry.record("a.ts", "hash", "upsert", "busy", 2, "retrying", "server")
		expect(changed).toHaveBeenCalledTimes(2)
		registry.list()[0].reason = "mutated"
		expect(registry.list()[0].reason).toBe("busy")
		subscription.dispose()
		registry.clear("a.ts")
		expect(changed).toHaveBeenCalledTimes(2)
	})

	it("CI-FR-03: a success clears the entry for that path only", () => {
		const registry = new FileFailureRegistry()
		registry.renew("a.ts", "one")
		registry.renew("b.ts", "one")
		registry.record("a.ts", "one", "read", "denied", 1, "exhausted")
		registry.record("b.ts", "one", "parse", "bad", 1, "exhausted")
		registry.clear("a.ts", "one")
		expect(registry.list().map((failure) => failure.path)).toEqual(["b.ts"])
	})
})
