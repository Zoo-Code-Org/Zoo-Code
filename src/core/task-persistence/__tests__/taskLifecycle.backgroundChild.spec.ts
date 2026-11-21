import type { HistoryItem } from "@roo-code/types"

import { addBackgroundChild } from "../taskLifecycle"

function item(id: string, overrides: Partial<HistoryItem> = {}): HistoryItem {
	return {
		id,
		number: 1,
		ts: 1,
		task: id,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		status: "active",
		...overrides,
	}
}

describe("addBackgroundChild", () => {
	it("registers a child on a parent without childIds", () => {
		const parent = item("parent")

		expect(addBackgroundChild(parent, "child")).toMatchObject({
			id: "parent",
			childIds: ["child"],
		})
	})

	it("appends a child while preserving existing entries", () => {
		const parent = item("parent", { childIds: ["older"] })

		expect(addBackgroundChild(parent, "child")).toMatchObject({
			childIds: ["older", "child"],
		})
	})

	it("is idempotent and returns the same reference when the child is already registered", () => {
		const parent = item("parent", { childIds: ["child"] })

		expect(addBackgroundChild(parent, "child")).toBe(parent)
	})

	it("does not mutate the input parent", () => {
		const parent = item("parent", { childIds: ["older"] })
		const snapshot = structuredClone(parent)

		addBackgroundChild(parent, "child")

		expect(parent).toEqual(snapshot)
	})

	it("never touches the delegation fields or the parent status", () => {
		const parent = item("parent", { status: "delegated", awaitingChildId: "awaited", delegatedToId: "awaited" })

		const registered = addBackgroundChild(parent, "background-child")

		expect(registered.status).toBe("delegated")
		expect(registered.awaitingChildId).toBe("awaited")
		expect(registered.delegatedToId).toBe("awaited")
		expect(registered.childIds).toEqual(["background-child"])
	})

	it("keeps the singular awaitingChildId invariant after registering many background children", () => {
		let parent = item("parent", { status: "active" })

		for (const childId of ["child-1", "child-2", "child-3", "child-4"]) {
			parent = addBackgroundChild(parent, childId)
		}

		expect(parent.childIds).toEqual(["child-1", "child-2", "child-3", "child-4"])
		expect(parent.awaitingChildId).toBeUndefined()
		expect(parent.delegatedToId).toBeUndefined()
		expect(parent.status).toBe("active")
	})

	it("registers a background child alongside an awaited delegated child without merging the two", () => {
		const parent = item("parent", {
			status: "delegated",
			awaitingChildId: "delegated-child",
			delegatedToId: "delegated-child",
			childIds: ["delegated-child"],
		})

		const registered = addBackgroundChild(parent, "background-child")

		expect(registered.childIds).toEqual(["delegated-child", "background-child"])
		expect(registered.awaitingChildId).toBe("delegated-child")
		expect(registered.delegatedToId).toBe("delegated-child")
		expect(registered.status).toBe("delegated")
	})
})
