import type { HistoryItem } from "@roo-code/types"

import {
	abandonDelegatedChild,
	completeDelegatedChild,
	delegateTaskToChild,
	interruptDelegatedChild,
} from "../taskLifecycle"

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

describe("task lifecycle transitions", () => {
	it("delegates an active parent and retains child history", () => {
		const parent = delegateTaskToChild(item("parent", { childIds: ["older"] }), "child")

		expect(parent).toMatchObject({
			status: "delegated",
			awaitingChildId: "child",
			delegatedToId: "child",
			childIds: ["older", "child"],
		})
	})

	it("treats a legacy unset status as active when delegating", () => {
		expect(delegateTaskToChild(item("parent", { status: undefined }), "child")).toMatchObject({
			status: "delegated",
			awaitingChildId: "child",
			delegatedToId: "child",
		})
	})

	it("allows re-delegation only after the previous child is interrupted", () => {
		const parent = item("parent", {
			status: "delegated",
			awaitingChildId: "old-child",
			delegatedToId: "old-child",
			childIds: ["old-child"],
		})

		expect(() => delegateTaskToChild(parent, "new-child", "active")).toThrow(/not interrupted/)
		expect(delegateTaskToChild(parent, "new-child", "interrupted")).toMatchObject({
			status: "delegated",
			awaitingChildId: "new-child",
			childIds: ["old-child", "new-child"],
		})
	})

	it("interrupts a child without clearing the parent's ownership", () => {
		const parent = item("parent", { status: "delegated", awaitingChildId: "child", delegatedToId: "child" })
		const child = item("child", { parentTaskId: "parent" })

		expect(interruptDelegatedChild(parent, child)).toMatchObject({ status: "interrupted", parentTaskId: "parent" })
	})

	it("completes only the child the parent still awaits", () => {
		const parent = item("parent", { status: "delegated", awaitingChildId: "new-child", delegatedToId: "new-child" })
		const staleChild = item("old-child", { status: "interrupted", parentTaskId: "parent" })

		expect(() => completeDelegatedChild(parent, staleChild, "stale result")).toThrow(/not delegated to child/)

		const child = item("new-child", { parentTaskId: "parent" })
		const completed = completeDelegatedChild(parent, child, "result")
		expect(completed.child.status).toBe("completed")
		expect(completed.parent).toMatchObject({
			status: "active",
			completedByChildId: "new-child",
			awaitingChildId: undefined,
		})
	})

	it("repairs an active parent that still awaits the returning child", () => {
		const parent = item("parent", { status: "active", awaitingChildId: "child", delegatedToId: "child" })
		const child = item("child", { status: "interrupted", parentTaskId: "parent" })

		expect(completeDelegatedChild(parent, child, "result").parent).toMatchObject({
			status: "active",
			completedByChildId: "child",
			awaitingChildId: undefined,
		})
	})

	it("abandons only an interrupted child and clears both sides of the live link", () => {
		const parent = item("parent", { status: "delegated", awaitingChildId: "child", delegatedToId: "child" })
		const activeChild = item("child", { parentTaskId: "parent", rootTaskId: "parent" })

		expect(() => abandonDelegatedChild(parent, activeChild)).toThrow(/status active/)

		const abandoned = abandonDelegatedChild(parent, { ...activeChild, status: "interrupted" })
		expect(abandoned.parent).toMatchObject({ status: "active", awaitingChildId: undefined })
		expect(abandoned.child).toMatchObject({ parentTaskId: undefined, rootTaskId: undefined })
	})
})
