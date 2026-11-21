import { beforeEach, describe, expect, it, vi } from "vitest"
import { clineMessageSchema, type ClineMessage, type HistoryItem } from "@roo-code/types"

vi.mock("../core/task-persistence/taskMessages", async (importOriginal) => ({
	...(await importOriginal<typeof import("../core/task-persistence/taskMessages")>()),
	readTaskMessages: vi.fn(),
}))
vi.mock("../core/task-persistence", async (importOriginal) => ({
	...(await importOriginal<typeof import("../core/task-persistence")>()),
	readApiMessages: vi.fn().mockResolvedValue([]),
	saveApiMessages: vi.fn(async ({ messages }: { messages: unknown[] }) => messages),
	saveTaskMessages: vi.fn(async ({ messages }: { messages: ClineMessage[] }) => messages),
}))

import { ClineProvider } from "../core/webview/ClineProvider"
import { readTaskMessages } from "../core/task-persistence/taskMessages"
import { saveTaskMessages } from "../core/task-persistence"
import { makeProviderStub } from "./helpers/provider-stub"

function newTask(ts: number, childTaskId?: string, content = "Do work"): ClineMessage {
	return {
		ts,
		type: "ask",
		ask: "tool",
		text: JSON.stringify({ tool: "newTask", mode: "code", content }),
		...(childTaskId ? { childTaskId } : {}),
	}
}

function makeLinkProvider() {
	const parentHistory: HistoryItem = {
		id: "parent",
		number: 1,
		ts: 1,
		task: "Parent",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		status: "active",
	}
	const records = new Map<string, HistoryItem>([["parent", parentHistory]])
	const taskHistoryStore = {
		get: vi.fn((taskId: string) => records.get(taskId)),
		invalidate: vi.fn().mockResolvedValue(undefined),
		atomicReadAndUpdate: vi.fn(async (taskId: string, update: (item: HistoryItem) => HistoryItem) => {
			records.set(taskId, update(records.get(taskId)!))
		}),
		atomicUpdatePair: vi.fn(
			async (
				firstId: string,
				secondId: string,
				firstUpdate: (item: HistoryItem) => HistoryItem,
				secondUpdate: (item: HistoryItem) => HistoryItem,
			) => {
				records.set(firstId, firstUpdate(records.get(firstId)!))
				records.set(secondId, secondUpdate(records.get(secondId)!))
			},
		),
	}
	const parent = {
		taskId: "parent",
		apiConfiguration: {},
		getTaskApiConfigName: vi.fn().mockResolvedValue("default"),
		getTaskMode: vi.fn().mockResolvedValue("code"),
		flushPendingToolResultsToHistory: vi.fn().mockResolvedValue(true),
	}
	const child = { taskId: "child", run: vi.fn().mockResolvedValue(undefined) }
	const reopenedParent = {
		taskId: "parent",
		resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
		overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
		overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
	}
	const provider = makeProviderStub({
		contextProxy: { globalStorageUri: { fsPath: "/storage" } },
		getCurrentTask: vi.fn(() => parent),
		getTaskWithId: vi.fn(async (taskId: string) => ({ historyItem: records.get(taskId) })),
		removeClineFromStack: vi.fn().mockResolvedValue(undefined),
		createTask: vi.fn().mockResolvedValue(child),
		createTaskWithHistoryItem: vi.fn().mockResolvedValue(reopenedParent),
		deleteTaskWithId: vi.fn().mockResolvedValue(undefined),
		emit: vi.fn(),
		log: vi.fn(),
		taskHistoryStore,
	})
	return { provider, records, taskHistoryStore, child, reopenedParent }
}

const delegation = { parentTaskId: "parent", message: "Do work", initialTodos: [], mode: "code" }

describe("persisted subtask links", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(readTaskMessages).mockResolvedValue([])
	})

	it.each([undefined, "child"])("keeps optional child identity through schema validation: %s", (childTaskId) => {
		expect(clineMessageSchema.parse(newTask(1, childTaskId)).childTaskId).toBe(childTaskId)
	})

	it("stamps only the latest ask after commit and before the child runs", async () => {
		const messages: ClineMessage[] = [
			newTask(1),
			newTask(2),
			{ ts: 3, type: "say", say: "text", text: "Working" },
			{ ts: 4, type: "ask", ask: "tool", text: "invalid JSON" },
			{ ts: 5, type: "ask", ask: "tool", text: JSON.stringify({ tool: "readFile" }) },
		]
		vi.mocked(readTaskMessages).mockResolvedValue(messages)
		const { provider, taskHistoryStore, child } = makeLinkProvider()
		await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, delegation)

		expect(messages[0].childTaskId).toBeUndefined()
		expect(messages[1].childTaskId).toBe("child")
		expect(saveTaskMessages).toHaveBeenCalledWith({
			messages,
			taskId: "parent",
			globalStoragePath: "/storage",
			merge: true,
		})
		const saveOrder = vi.mocked(saveTaskMessages).mock.invocationCallOrder[0]
		expect(taskHistoryStore.atomicReadAndUpdate.mock.invocationCallOrder[0]).toBeLessThan(saveOrder)
		expect(saveOrder).toBeLessThan(child.run.mock.invocationCallOrder[0])
		expect(readTaskMessages).toHaveBeenCalledWith({ taskId: "parent", globalStoragePath: "/storage" })
	})

	it.each<ClineMessage>([
		{ ts: 3, type: "say", say: "text", text: newTask(0).text },
		{ ts: 3, type: "ask", ask: "followup", text: newTask(0).text },
		{ ts: 3, type: "ask", ask: "tool", text: "null" },
		{ ts: 3, type: "ask", ask: "tool", text: JSON.stringify({ tool: "readFile", content: "Do work" }) },
	])("skips a newer non-delegation message and stamps the delegation ask: %j", async (newer) => {
		const messages = [newTask(1), newer]
		vi.mocked(readTaskMessages).mockResolvedValue(messages)
		const { provider } = makeLinkProvider()
		await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, delegation)
		expect(messages[0].childTaskId).toBe("child")
		expect(newer.childTaskId).toBeUndefined()
	})

	it.each([{ tool: "newTask" }, { tool: "newTask", content: 42 }])(
		"does not stamp or log a newest ask without string content: %j",
		async (tool) => {
			const messages: ClineMessage[] = [{ ts: 1, type: "ask", ask: "tool", text: JSON.stringify(tool) }]
			vi.mocked(readTaskMessages).mockResolvedValue(messages)
			const { provider } = makeLinkProvider()
			await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, delegation)
			expect(messages[0].childTaskId).toBeUndefined()
			expect(provider.log).not.toHaveBeenCalledWith(expect.stringContaining("Failed to save child link"))
		},
	)

	it.each([{ messages: [] }, { messages: [newTask(1), newTask(2, "existing-child")] }])(
		"does not write or stamp older asks when no pending delegation exists: %j",
		async ({ messages }) => {
			vi.mocked(readTaskMessages).mockResolvedValue(messages)
			const { provider } = makeLinkProvider()
			await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, delegation)
			expect(saveTaskMessages).not.toHaveBeenCalled()
			expect(messages[0]?.childTaskId).toBeUndefined()
		},
	)

	it.each([
		{ askContent: "Do work", delegatedMessage: "Do work", stamped: true },
		{ askContent: "See \\\\@file", delegatedMessage: "See \\@file", stamped: true },
		{ askContent: "Other work", delegatedMessage: "Do work", stamped: false },
	])("stamps the newest ask only when it matches the delegation: %j", async (scenario) => {
		const { askContent, delegatedMessage, stamped } = scenario
		const messages = [newTask(1, undefined, delegatedMessage), newTask(2, undefined, askContent)]
		vi.mocked(readTaskMessages).mockResolvedValue(messages)
		const { provider, child } = makeLinkProvider()
		await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			...delegation,
			message: delegatedMessage,
		})

		expect(messages[0].childTaskId).toBeUndefined()
		expect(messages[1].childTaskId).toBe(stamped ? "child" : undefined)
		expect(vi.mocked(saveTaskMessages).mock.calls).toHaveLength(stamped ? 1 : 0)
		expect(child.run).toHaveBeenCalledOnce()
	})

	it("does not stamp a rejected delegation", async () => {
		const { provider, taskHistoryStore } = makeLinkProvider()
		taskHistoryStore.atomicReadAndUpdate.mockRejectedValueOnce(new Error("commit rejected"))
		await expect(ClineProvider.prototype.delegateParentAndOpenChild.call(provider, delegation)).rejects.toThrow(
			"commit rejected",
		)
		expect(readTaskMessages).not.toHaveBeenCalled()
		expect(saveTaskMessages).not.toHaveBeenCalled()
	})

	it.each(["read", "write"])("starts the committed child even if link %s fails", async (operation) => {
		vi.mocked(readTaskMessages).mockResolvedValue([newTask(1)])
		if (operation === "read") vi.mocked(readTaskMessages).mockRejectedValueOnce(new Error("read failed"))
		else vi.mocked(saveTaskMessages).mockRejectedValueOnce(new Error("write failed"))
		const { provider, child } = makeLinkProvider()
		await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, delegation)
		expect(child.run).toHaveBeenCalledOnce()
		expect(provider.log).toHaveBeenCalledWith(expect.stringContaining("Failed to save child link"))
	})

	it.each([undefined, "child", "earlier-child"])(
		"stamps resumed results without conflating identical summaries from child %s",
		async (previousChildId) => {
			const { provider, records, reopenedParent } = makeLinkProvider()
			const parent = records.get("parent")!
			records.set("parent", { ...parent, status: "delegated", awaitingChildId: "child", childIds: ["child"] })
			records.set("child", { ...parent, id: "child", parentTaskId: "parent" })
			const previous: ClineMessage = {
				ts: 1,
				type: "say",
				say: "subtask_result",
				text: "Done",
				childTaskId: previousChildId,
			}
			vi.mocked(readTaskMessages).mockResolvedValue([previous])

			await ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
				parentTaskId: "parent",
				childTaskId: "child",
				completionResultSummary: "Done",
			})

			const saved = vi.mocked(saveTaskMessages).mock.calls[0][0].messages
			expect(saved).toHaveLength(previousChildId === "earlier-child" ? 2 : 1)
			expect(saved.at(-1)).toMatchObject({ say: "subtask_result", childTaskId: "child" })
			if (previousChildId === "earlier-child") expect(saved[0].childTaskId).toBe("earlier-child")
			expect(reopenedParent.overwriteClineMessages).toHaveBeenCalledWith(saved, false)
		},
	)

	it.each<ClineMessage>([
		{ ts: 1, type: "say", say: "text", text: "Done" },
		{ ts: 1, type: "say", say: "subtask_result", text: "Earlier result", childTaskId: "child" },
	])("appends the result after a non-duplicate last message: %j", async (previous) => {
		const { provider, records } = makeLinkProvider()
		const parent = records.get("parent")!
		records.set("parent", { ...parent, status: "delegated", awaitingChildId: "child", childIds: ["child"] })
		records.set("child", { ...parent, id: "child", parentTaskId: "parent" })
		vi.mocked(readTaskMessages).mockResolvedValue([previous])

		await ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
			parentTaskId: "parent",
			childTaskId: "child",
			completionResultSummary: "Done",
		})

		const saved = vi.mocked(saveTaskMessages).mock.calls[0][0].messages
		expect(saved).toHaveLength(2)
		expect(saved.at(-1)).toMatchObject({ say: "subtask_result", childTaskId: "child" })
	})
})
