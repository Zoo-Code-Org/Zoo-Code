import type { HistoryItem } from "@roo-code/types"

import {
	abandonDelegatedChild,
	completeDelegatedChild,
	delegateTaskToChild,
	interruptDelegatedChild,
	isDeadDelegationChain,
	recoverDeadDelegatedChild,
	recoverDelegationParent,
	LifecycleTransitionError,
	settleRejectedCreateSubtaskAction,
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
	it("preserves only an ancestor's current delegation when recovering a parent", () => {
		const parent = delegateTaskToChild(item("middle", { parentTaskId: "root" }), "leaf")
		const ancestor = delegateTaskToChild(item("root"), parent.id)
		expect(recoverDelegationParent(parent, ancestor)).toMatchObject({
			status: "interrupted",
			parentTaskId: "root",
			awaitingChildId: undefined,
			delegatedToId: undefined,
		})
		expect(recoverDelegationParent(parent).status).toBe("active")
		expect(recoverDelegationParent(parent, { ...ancestor, awaitingChildId: "replacement" }).status).toBe("active")
		expect(recoverDelegationParent(parent, { ...ancestor, status: "active" }).status).toBe("active")
		expect(() => recoverDelegationParent(item("not-delegated"))).toThrow("non-delegated parent")
	})

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

	it("recognizes only delegated chains that terminate without a live owner", () => {
		const interrupted = item("grandchild", { status: "interrupted" })
		const completed = item("completed-grandchild", { status: "completed" })
		const active = item("active-grandchild")
		const child = item("child", { status: "delegated", awaitingChildId: interrupted.id })
		const tasks = new Map([interrupted, completed, active].map((task) => [task.id, task]))

		expect(isDeadDelegationChain(child, (id) => tasks.get(id))).toBe(true)
		expect(isDeadDelegationChain({ ...child, awaitingChildId: completed.id }, (id) => tasks.get(id))).toBe(true)
		expect(isDeadDelegationChain({ ...child, awaitingChildId: active.id }, (id) => tasks.get(id))).toBe(false)
		expect(isDeadDelegationChain({ ...child, awaitingChildId: undefined }, (id) => tasks.get(id))).toBe(true)
		expect(
			isDeadDelegationChain(
				child,
				(id) => tasks.get(id),
				(id) => id === child.id,
			),
		).toBe(false)
		expect(
			isDeadDelegationChain(
				child,
				(id) => tasks.get(id),
				(id) => id === interrupted.id,
			),
		).toBe(false)
		expect(isDeadDelegationChain({ ...child, status: "active" }, (id) => tasks.get(id))).toBe(false)
		expect(isDeadDelegationChain({ ...child, awaitingChildId: "missing" }, (id) => tasks.get(id))).toBe(true)
		// A missing record is not proof of death when its task still has a live owner.
		expect(
			isDeadDelegationChain(
				{ ...child, awaitingChildId: "missing" },
				(id) => tasks.get(id),
				(id) => id === "missing",
			),
		).toBe(false)
		expect(
			isDeadDelegationChain({ ...child, awaitingChildId: child.id }, (id) =>
				id === child.id ? child : undefined,
			),
		).toBe(false)
	})

	it.each([
		["interrupted", false],
		["completed", true],
		["active", false],
		["delegated", true],
		[undefined, true],
	] as const)("applies the startup recovery policy to a nested %s leaf", (status, recoverAtStartup) => {
		const child = item("child", { status: "delegated", awaitingChildId: "middle" })
		const middle = item("middle", { status: "delegated", awaitingChildId: "leaf" })
		const leaf = status ? item("leaf", { status }) : undefined
		const getTask = (id: string) => (id === middle.id ? middle : leaf)

		expect(isDeadDelegationChain(child, getTask, () => false, { preserveInterrupted: true })).toBe(recoverAtStartup)
		// Explicit runtime re-delegation may still retire the interrupted descendant chain.
		expect(isDeadDelegationChain(child, getTask)).toBe(status !== "active")
	})

	it("recovers a dead delegated child without releasing its parent's ownership", () => {
		const parent = item("parent", { status: "delegated", awaitingChildId: "child", delegatedToId: "child" })
		const child = item("child", {
			status: "delegated",
			parentTaskId: "parent",
			awaitingChildId: "grandchild",
			delegatedToId: "grandchild",
		})

		expect(recoverDeadDelegatedChild(parent, child)).toMatchObject({
			id: "child",
			status: "interrupted",
			parentTaskId: "parent",
			awaitingChildId: undefined,
			delegatedToId: undefined,
		})
		expect(parent).toMatchObject({ status: "delegated", awaitingChildId: "child" })
		expect(() => recoverDeadDelegatedChild(parent, { ...child, status: "active" })).toThrow(/status active/)
		expect(() => recoverDeadDelegatedChild({ ...parent, awaitingChildId: "other-child" }, child)).toThrow(
			/not delegated to child/,
		)
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

describe("settleRejectedCreateSubtaskAction", () => {
	const createSubtaskAction = {
		kind: "create_subtask" as const,
		actionId: "create-action",
		approvalText: "{}",
		mode: "code",
		message: "Do something",
		todos: [],
	}

	it("clears only the matching pending create_subtask action", () => {
		const parent = item("parent", {
			status: "interrupted",
			parentTaskId: "root",
			rootTaskId: "root",
			awaitingChildId: undefined,
			tokensIn: 12,
			totalCost: 0.5,
			pendingAction: createSubtaskAction,
		})

		const settled = settleRejectedCreateSubtaskAction(parent, "create-action")

		expect(settled).toEqual({
			...parent,
			pendingAction: undefined,
		})
		expect(settled).toMatchObject({
			status: "interrupted",
			parentTaskId: "root",
			rootTaskId: "root",
			tokensIn: 12,
			totalCost: 0.5,
		})
	})

	it("never clears a replacement action with a different ID", () => {
		const parent = item("parent", {
			status: "interrupted",
			pendingAction: { ...createSubtaskAction, actionId: "replacement-action" },
		})

		expect(settleRejectedCreateSubtaskAction(parent, "stale-action")).toBe(parent)
	})

	it("never clears a pending action of a different kind", () => {
		const parent = item("parent", {
			pendingAction: {
				kind: "finish_subtask",
				actionId: "create-action",
				approvalText: "{}",
				parentTaskId: "root",
				result: "done",
			},
		})

		expect(settleRejectedCreateSubtaskAction(parent, "create-action")).toBe(parent)
	})

	it("leaves a record without a pending action unchanged", () => {
		const parent = item("parent", { status: "interrupted" })

		expect(settleRejectedCreateSubtaskAction(parent, "create-action")).toBe(parent)
	})

	it("never mutates a completed record", () => {
		const parent = item("parent", { status: "completed", pendingAction: createSubtaskAction })

		expect(settleRejectedCreateSubtaskAction(parent, "create-action")).toBe(parent)
	})

	it("rejects an interrupted parent's delegation with a typed transition error", () => {
		const parent = item("parent", { status: "interrupted", pendingAction: createSubtaskAction })

		expect(() => delegateTaskToChild(parent, "child")).toThrow(LifecycleTransitionError)
		expect(() => delegateTaskToChild(parent, "child")).toThrow(
			"Invalid task status transition: interrupted → delegated",
		)
	})
})
