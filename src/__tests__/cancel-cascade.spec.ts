// npx vitest run __tests__/cancel-cascade.spec.ts

import { describe, it, expect, vi } from "vitest"
import type { HistoryItem } from "@roo-code/types"
import { ClineProvider } from "../core/webview/ClineProvider"
import { TaskRegistry } from "../core/task/TaskRegistry"
import type { Task } from "../core/task/Task"

/**
 * Minimal live-child double carrying only the fields interruptLiveChildren touches.
 * `abortTask` is a real mock so we can assert it was invoked (and that its inlineSubtask
 * phase marker would be cleared by the abort path).
 */
function makeChildDouble(taskId: string, opts: { abort?: boolean; abandoned?: boolean } = {}) {
	const abortTask = vi.fn().mockResolvedValue(undefined)
	return {
		taskId,
		abort: opts.abort ?? false,
		abandoned: opts.abandoned ?? false,
		inlineSubtask: undefined as { message: string; todos: unknown[] } | undefined,
		abortTask,
	}
}

function makeProvider(opts: {
	parentChildIds?: string[]
	childStatuses?: Record<string, "active" | "interrupted" | "completed">
	children: Array<ReturnType<typeof makeChildDouble>>
}) {
	const store = new Map<string, HistoryItem>()
	store.set("parent-1", {
		id: "parent-1",
		task: "Parent",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		childIds: opts.parentChildIds ?? [],
	} as unknown as HistoryItem)
	for (const [id, status] of Object.entries(opts.childStatuses ?? {})) {
		store.set(id, {
			id,
			task: `Child ${id}`,
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			status,
		} as unknown as HistoryItem)
	}

	const registry = new TaskRegistry()
	for (const child of opts.children) {
		registry.push(child as unknown as Task)
	}

	const updateTaskHistory = vi.fn().mockResolvedValue([])

	return {
		taskHistoryStore: { get: (id: string) => store.get(id) },
		taskRegistry: registry,
		updateTaskHistory,
		log: vi.fn(),
	}
}

async function callInterruptLiveChildren(provider: object, parentTaskId: string): Promise<void> {
	const proto = ClineProvider.prototype as unknown as {
		interruptLiveChildren: (this: object, id: string) => Promise<void>
	}
	await proto.interruptLiveChildren.call(provider, parentTaskId)
}

describe("ClineProvider.cancel cascade — interruptLiveChildren", () => {
	it("aborts live children and marks them interrupted", async () => {
		const child = makeChildDouble("child-1")
		const provider = makeProvider({
			parentChildIds: ["child-1"],
			childStatuses: { "child-1": "active" },
			children: [child],
		})

		await callInterruptLiveChildren(provider, "parent-1")

		expect(child.abortTask).toHaveBeenCalledTimes(1)
		const update = (provider as { updateTaskHistory: ReturnType<typeof vi.fn> }).updateTaskHistory
		expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: "child-1", status: "interrupted" }))
	})

	it("skips children already in a terminal state (never overwrites completed/interrupted)", async () => {
		const done = makeChildDouble("child-done")
		const interrupted = makeChildDouble("child-interrupted")
		const provider = makeProvider({
			parentChildIds: ["child-done", "child-interrupted"],
			childStatuses: { "child-done": "completed", "child-interrupted": "interrupted" },
			children: [done, interrupted],
		})

		await callInterruptLiveChildren(provider, "parent-1")

		expect(done.abortTask).not.toHaveBeenCalled()
		expect(interrupted.abortTask).not.toHaveBeenCalled()
		const update = (provider as { updateTaskHistory: ReturnType<typeof vi.fn> }).updateTaskHistory
		expect(update).not.toHaveBeenCalled()
	})

	it("skips children that are not live in the registry (already aborted/abandoned or evicted)", async () => {
		const abandoned = makeChildDouble("child-abandoned", { abandoned: true })
		const provider = makeProvider({
			parentChildIds: ["child-abandoned", "child-evicted"], // child-evicted has no registry entry
			childStatuses: { "child-abandoned": "active", "child-evicted": "active" },
			children: [abandoned],
		})

		await callInterruptLiveChildren(provider, "parent-1")

		expect(abandoned.abortTask).not.toHaveBeenCalled()
		const update = (provider as { updateTaskHistory: ReturnType<typeof vi.fn> }).updateTaskHistory
		expect(update).not.toHaveBeenCalled()
	})

	it("is a no-op when the parent has no children", async () => {
		const provider = makeProvider({ parentChildIds: [], childStatuses: {}, children: [] })

		await callInterruptLiveChildren(provider, "parent-1")

		const update = (provider as { updateTaskHistory: ReturnType<typeof vi.fn> }).updateTaskHistory
		expect(update).not.toHaveBeenCalled()
	})
})
