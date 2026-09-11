// npx vitest run __tests__/history-resume-delegation.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"
import { providerIdentifiers, RooCodeEventName } from "@roo-code/types"
import type { ClineMessage, HistoryItem } from "@roo-code/types"

import type { ApiMessage } from "../core/task-persistence"
import type { Task } from "../core/task/Task"
import type { JsonFileLock } from "../utils/safeWriteJson"

/* vscode mock for Task/Provider imports */
vi.mock("vscode", () => {
	const window = {
		createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
		showErrorMessage: vi.fn(),
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
	}
	const workspace = {
		getConfiguration: vi.fn(() => ({
			get: vi.fn((_key: string, defaultValue: any) => defaultValue),
			update: vi.fn(),
		})),
		workspaceFolders: [],
	}
	const env = { machineId: "test-machine", uriScheme: "vscode", appName: "VSCode", language: "en", sessionId: "sess" }
	const Uri = { file: (p: string) => ({ fsPath: p, toString: () => p }) }
	const commands = { executeCommand: vi.fn() }
	const ExtensionMode = { Development: 2 }
	const version = "1.0.0-test"
	return { window, workspace, env, Uri, commands, ExtensionMode, version }
})

// Mock TelemetryService (needed by attemptCompletionTool's emitPublicTaskCompleted)
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureTaskCompleted: vi.fn(),
		},
	},
}))

// Mock persistence BEFORE importing provider
vi.mock("../core/task-persistence/taskMessages", () => ({
	readTaskMessages: vi.fn().mockResolvedValue([]),
}))
vi.mock("../core/task-persistence", async (importOriginal) => {
	const real = await importOriginal<typeof import("../core/task-persistence")>()
	return {
		...real,
		readApiMessages: vi.fn().mockResolvedValue([]),
		saveApiMessages: vi.fn(async ({ messages }: { messages: unknown[] }) => messages),
		saveTaskMessages: vi.fn(async ({ messages }: { messages: unknown[] }) => messages),
	}
})

import { ClineProvider } from "../core/webview/ClineProvider"
import { readTaskMessages } from "../core/task-persistence/taskMessages"
import { readApiMessages, saveApiMessages, saveTaskMessages } from "../core/task-persistence"
import { makeProviderStub, unlockedJsonFileLock } from "./helpers/provider-stub"

type LockedDelegationAccess = {
	runLockedDelegationTransition: (
		parentTaskId: string,
		transition: (fileLock: JsonFileLock) => Promise<boolean>,
		afterUnlock: (result: boolean) => Promise<void>,
		afterUnlockError: (error: unknown) => Promise<void>,
	) => Promise<boolean>
}

/**
 * Create a minimal taskHistoryStore stub whose atomicUpdatePair calls both updaters
 * with the provided items and resolves, simulating the happy-path atomic write.
 */
function makeTaskHistoryStoreStub(
	childItem: Record<string, any>,
	parentItem: Record<string, any>,
	overrides: { atomicUpdatePair?: ReturnType<typeof vi.fn> } = {},
) {
	const itemMap = new Map<string, Partial<HistoryItem>>([
		[childItem.id!, childItem],
		[parentItem.id!, parentItem],
	])

	const atomicUpdatePair = vi.fn(
		async (
			firstId: string,
			secondId: string,
			firstUpdater: (h: HistoryItem) => HistoryItem,
			secondUpdater: (h: HistoryItem) => HistoryItem,
			options?: {
				firstDiskGuard?: (item: HistoryItem) => void
				whileFirstFileLocked?: () => Promise<void>
				firstFileLock?: JsonFileLock
				storeLockAcquired?: boolean
				rollbackBothOnCallbackFailure?: boolean
			},
		) => {
			const first = itemMap.get(firstId) as HistoryItem
			const second = itemMap.get(secondId) as HistoryItem
			const updatedFirst = firstUpdater(structuredClone(first))
			const updatedSecond = secondUpdater(structuredClone(second))
			if (updatedFirst.id !== firstId) {
				throw new Error(
					`[TaskHistoryStore] atomicUpdatePair: first updater changed id from ${firstId} to ${updatedFirst.id}`,
				)
			}
			if (updatedSecond.id !== secondId) {
				throw new Error(
					`[TaskHistoryStore] atomicUpdatePair: second updater changed id from ${secondId} to ${updatedSecond.id}`,
				)
			}
			options?.firstDiskGuard?.(first)
			await options?.whileFirstFileLocked?.()
			itemMap.set(firstId, updatedFirst)
			itemMap.set(secondId, updatedSecond)
			return [...itemMap.values()]
		},
	)
	const withTaskFileLock = vi.fn(async (_id: string, callback: (fileLock: JsonFileLock) => Promise<unknown>) =>
		callback(unlockedJsonFileLock()),
	)

	return {
		atomicUpdatePair: overrides.atomicUpdatePair ?? atomicUpdatePair,
		get: vi.fn((id: string) => itemMap.get(id)),
		invalidate: vi.fn().mockResolvedValue(undefined),
		withTaskFileLock,
	}
}

function makeStatefulTaskHistoryStore(...items: HistoryItem[]) {
	const itemMap = new Map(items.map((item) => [item.id, item]))

	return {
		get: vi.fn((id: string) => itemMap.get(id)),
		invalidate: vi.fn().mockResolvedValue(undefined),
		atomicUpdatePair: vi.fn(
			async (
				firstId: string,
				secondId: string,
				firstUpdater: (item: HistoryItem) => HistoryItem,
				secondUpdater: (item: HistoryItem) => HistoryItem,
				options?: { whileFirstFileLocked?: () => Promise<void> },
			) => {
				const first = itemMap.get(firstId)
				const second = itemMap.get(secondId)
				if (!first || !second) throw new Error(`Missing history item for atomic pair: ${firstId}, ${secondId}`)
				itemMap.set(firstId, firstUpdater(first))
				itemMap.set(secondId, secondUpdater(second))
				await options?.whileFirstFileLocked?.()
				return [itemMap.get(firstId), itemMap.get(secondId)]
			},
		),
		atomicReadAndUpdate: vi.fn(async (id: string, updater: (item: HistoryItem) => HistoryItem) => {
			const item = itemMap.get(id)
			if (!item) throw new Error(`Missing history item: ${id}`)
			const updated = updater(item)
			itemMap.set(id, updated)
			return [updated]
		}),
	}
}

describe("History resume delegation - parent metadata transitions", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])
		vi.mocked(saveTaskMessages).mockImplementation(async ({ messages }) => messages)
		vi.mocked(saveApiMessages).mockImplementation(async ({ messages }) => messages)
	})

	it("runs post-lock callbacks only for their matching transition outcome", async () => {
		let lockHeld = false
		const provider = makeProviderStub({
			taskHistoryStore: {
				withTaskFileLock: vi.fn(async (_id: string, callback: (fileLock: JsonFileLock) => Promise<unknown>) => {
					lockHeld = true
					try {
						return await callback(unlockedJsonFileLock())
					} finally {
						lockHeld = false
					}
				}),
			},
		}) as unknown as LockedDelegationAccess
		const afterUnlock = vi.fn(async () => expect(lockHeld).toBe(false))
		const afterUnlockError = vi.fn(async () => expect(lockHeld).toBe(false))

		await expect(
			provider.runLockedDelegationTransition("parent-success", async () => true, afterUnlock, afterUnlockError),
		).resolves.toBe(true)
		expect(afterUnlock).toHaveBeenCalledOnce()
		expect(afterUnlockError).not.toHaveBeenCalled()

		const transitionError = new Error("locked transition failed")
		await expect(
			provider.runLockedDelegationTransition(
				"parent-failure",
				async () => {
					throw transitionError
				},
				afterUnlock,
				afterUnlockError,
			),
		).rejects.toBe(transitionError)
		expect(afterUnlockError).toHaveBeenCalledOnce()
	})

	it("rejects a stale restored completion action before changing parent or child state", async () => {
		const parentHistoryItem = {
			id: "parent-1",
			status: "delegated",
			awaitingChildId: "child-1",
			ts: Date.now(),
			task: "Parent task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const childHistoryItem = {
			id: "child-1",
			status: "interrupted",
			pendingAction: {
				kind: "finish_subtask",
				actionId: "current-action",
				approvalText: JSON.stringify({ tool: "finishTask" }),
				parentTaskId: "parent-1",
				result: "Done",
			},
		}
		const taskHistoryStore = makeTaskHistoryStoreStub(childHistoryItem, parentHistoryItem)
		const removeClineFromStack = vi.fn()
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentHistoryItem }),
			getCurrentTask: vi.fn(() => ({ taskId: "child-1" })),
			removeClineFromStack,
			taskHistoryStore,
			log: vi.fn(),
		})

		const result = await ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
			parentTaskId: "parent-1",
			childTaskId: "child-1",
			completionResultSummary: "Done",
			pendingActionId: "stale-action",
		})

		expect(result).toBe(false)
		expect(taskHistoryStore.atomicUpdatePair).not.toHaveBeenCalled()
		expect(removeClineFromStack).not.toHaveBeenCalled()
	})

	it("rejects an ownership change detected inside the atomic child updater", async () => {
		const parentHistoryItem = {
			id: "parent-1",
			status: "delegated",
			awaitingChildId: "child-1",
			ts: Date.now(),
			task: "Parent task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const expectedAction = {
			kind: "finish_subtask",
			actionId: "finish-action",
			approvalText: JSON.stringify({ tool: "finishTask" }),
			parentTaskId: "parent-1",
			result: "Done",
		}
		const childHistoryItem = { id: "child-1", status: "active", pendingAction: expectedAction }
		const atomicUpdatePair = vi.fn(
			async (
				_firstId: string,
				_secondId: string,
				firstUpdater: (item: HistoryItem) => HistoryItem,
				secondUpdater: (item: HistoryItem) => HistoryItem,
			) => {
				firstUpdater(parentHistoryItem as HistoryItem)
				secondUpdater({
					...childHistoryItem,
					pendingAction: { ...expectedAction, actionId: "replacement-action" },
				} as unknown as HistoryItem)
				return []
			},
		)
		const taskHistoryStore = makeTaskHistoryStoreStub(childHistoryItem, parentHistoryItem, { atomicUpdatePair })
		const createTaskWithHistoryItem = vi.fn()
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentHistoryItem }),
			getCurrentTask: vi.fn(() => undefined),
			removeClineFromStack: vi.fn(),
			createTaskWithHistoryItem,
			taskHistoryStore,
			log: vi.fn(),
		})

		await expect(
			ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
				parentTaskId: "parent-1",
				childTaskId: "child-1",
				completionResultSummary: "Done",
				pendingActionId: "finish-action",
			}),
		).rejects.toThrow("Pending action mismatch for child child-1")

		expect(atomicUpdatePair).toHaveBeenCalledTimes(1)
		expect(createTaskWithHistoryItem).not.toHaveBeenCalled()
	})

	it("rejects missing pending-action ownership inside the atomic child updater", async () => {
		const parentHistoryItem = {
			id: "parent-missing-action",
			status: "delegated",
			awaitingChildId: "child-missing-action",
			ts: 1,
			task: "Parent task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const expectedAction = {
			kind: "finish_subtask" as const,
			actionId: "finish-action",
			approvalText: "{}",
			parentTaskId: "parent-missing-action",
			result: "Done",
		}
		const childHistoryItem = { id: "child-missing-action", status: "active", pendingAction: expectedAction }
		const atomicUpdatePair = vi.fn(
			async (
				_firstId: string,
				_secondId: string,
				firstUpdater: (item: HistoryItem) => HistoryItem,
				secondUpdater: (item: HistoryItem) => HistoryItem,
			) => {
				firstUpdater(parentHistoryItem as HistoryItem)
				secondUpdater({ ...childHistoryItem, pendingAction: undefined } as unknown as HistoryItem)
				return []
			},
		)
		const taskHistoryStore = makeTaskHistoryStoreStub(childHistoryItem, parentHistoryItem, { atomicUpdatePair })
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentHistoryItem }),
			getCurrentTask: vi.fn(() => undefined),
			removeClineFromStack: vi.fn(),
			createTaskWithHistoryItem: vi.fn(),
			taskHistoryStore,
			log: vi.fn(),
		})

		await expect(
			ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
				parentTaskId: "parent-missing-action",
				childTaskId: "child-missing-action",
				completionResultSummary: "Done",
				pendingActionId: "finish-action",
			}),
		).rejects.toThrow("Pending action mismatch for child child-missing-action")
	})

	it("reopenParentFromDelegation accepts an active parent awaiting the returning child", async () => {
		const cancelledDelegationChildIds = new Set<string>()
		const providerEmit = vi.fn((event: RooCodeEventName) => {
			if (event === RooCodeEventName.TaskDelegationCompleted) cancelledDelegationChildIds.add("child-1")
		})
		const parentHistoryItem = {
			id: "parent-1",
			status: "active",
			delegatedToId: "child-1",
			awaitingChildId: "child-1",
			childIds: ["child-1"],
			ts: Date.now(),
			task: "Parent task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			mode: "code",
			workspace: "/tmp",
		}
		const getTaskWithId = vi.fn().mockResolvedValue({ historyItem: parentHistoryItem })

		const taskHistoryStore = makeTaskHistoryStoreStub(
			{
				id: "child-1",
				status: "active",
				pendingAction: {
					kind: "finish_subtask",
					actionId: "finish-action",
					approvalText: JSON.stringify({ tool: "finishTask" }),
					parentTaskId: "parent-1",
					result: "Child done",
				},
			},
			parentHistoryItem,
		)
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const createTaskWithHistoryItem = vi.fn().mockResolvedValue({
			taskId: "parent-1",
			skipPrevResponseIdOnce: false,
			resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
		})

		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId,
			emit: providerEmit,
			getCurrentTask: vi.fn(() => ({ taskId: "child-1" })),
			removeClineFromStack,
			createTaskWithHistoryItem,
			taskHistoryStore,
			cancelledDelegationChildIds,
		})

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await (ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
			parentTaskId: "parent-1",
			childTaskId: "child-1",
			completionResultSummary: "Child done",
			pendingActionId: "finish-action",
		})

		// atomicUpdatePair guards and writes the parent before completing the child.
		expect(taskHistoryStore.atomicUpdatePair).toHaveBeenCalledTimes(1)
		const [firstId, secondId, firstUpdater, secondUpdater, options] =
			taskHistoryStore.atomicUpdatePair.mock.calls[0]
		expect(firstId).toBe("parent-1")
		expect(secondId).toBe("child-1")
		expect(taskHistoryStore.withTaskFileLock).toHaveBeenCalledWith("parent-1", expect.any(Function))
		expect(options).toMatchObject({
			firstFileLock: expect.any(Function),
			storeLockAcquired: true,
			rollbackBothOnCallbackFailure: true,
		})

		// Verify child updater produces completed status and persists completionResultSummary.
		const updatedChild = secondUpdater({
			id: "child-1",
			status: "active",
			pendingAction: {
				kind: "finish_subtask",
				actionId: "finish-action",
				approvalText: "{}",
				parentTaskId: "parent-1",
				result: "Child done",
			},
		} as HistoryItem)
		expect(updatedChild.status).toBe("completed")
		expect(updatedChild.completionResultSummary).toBe("Child done")
		expect(updatedChild.pendingAction).toBeUndefined()

		// Verify parent updater produces active status with correct fields
		const updatedParent = firstUpdater(parentHistoryItem as HistoryItem)
		expect(updatedParent).toMatchObject({
			id: "parent-1",
			status: "active",
			completedByChildId: "child-1",
			completionResultSummary: "Child done",
			awaitingChildId: undefined,
			delegatedToId: undefined,
			childIds: ["child-1"],
		})

		// atomicUpdatePair must happen before createTaskWithHistoryItem
		const atomicCall = taskHistoryStore.atomicUpdatePair.mock.invocationCallOrder[0]
		const createCall = createTaskWithHistoryItem.mock.invocationCallOrder[0]
		expect(atomicCall).toBeLessThan(createCall)

		// Verify child closed and parent reopened with updated metadata
		expect(removeClineFromStack).toHaveBeenCalledTimes(1)
		expect(removeClineFromStack).toHaveBeenCalledWith({ saveMessages: false })
		expect(createTaskWithHistoryItem).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "active",
				completedByChildId: "child-1",
			}),
			{ startTask: false },
		)
		expect(cancelledDelegationChildIds.has("child-1")).toBe(false)
		expect(taskHistoryStore.get("parent-1")).toEqual(updatedParent)
		expect(taskHistoryStore.get("child-1")).toEqual(updatedChild)
	})

	it("preserves an unrelated child pending action when completion has no action owner", async () => {
		const parentHistoryItem = {
			id: "parent-unowned-action",
			status: "delegated",
			awaitingChildId: "child-unowned-action",
			childIds: ["child-unowned-action"],
			ts: 1,
			task: "Parent",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const pendingAction = {
			kind: "finish_subtask" as const,
			actionId: "other-action",
			approvalText: "{}",
			parentTaskId: "parent-unowned-action",
			result: "Other result",
		}
		const childHistoryItem = {
			id: "child-unowned-action",
			status: "active",
			pendingAction,
		}
		let updatedChild: HistoryItem | undefined
		const taskHistoryStore = makeTaskHistoryStoreStub(childHistoryItem, parentHistoryItem, {
			atomicUpdatePair: vi.fn(
				async (
					_firstId: string,
					_secondId: string,
					firstUpdater: (item: HistoryItem) => HistoryItem,
					secondUpdater: (item: HistoryItem) => HistoryItem,
					options?: { whileFirstFileLocked?: () => Promise<void> },
				) => {
					firstUpdater(parentHistoryItem as HistoryItem)
					updatedChild = secondUpdater(childHistoryItem as HistoryItem)
					await options?.whileFirstFileLocked?.()
					return []
				},
			),
		})
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentHistoryItem }),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => undefined),
			removeClineFromStack: vi.fn(),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue({
				resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
				overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
				overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
			}),
			taskHistoryStore,
		})

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])
		await ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
			parentTaskId: "parent-unowned-action",
			childTaskId: "child-unowned-action",
			completionResultSummary: "Done",
		})

		expect(updatedChild?.pendingAction).toEqual(pendingAction)
	})

	it("reopenParentFromDelegation injects subtask_result into both UI and API histories", async () => {
		const parentItem = {
			id: "p1",
			status: "delegated",
			awaitingChildId: "c1",
			childIds: [],
			ts: 100,
			task: "Parent",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const taskHistoryStore = makeTaskHistoryStoreStub({ id: "c1", status: "active" }, parentItem)
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/storage" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => ({ taskId: "c1" })),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue({
				taskId: "p1",
				resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
				overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
				overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
			}),
			taskHistoryStore,
		} as any)

		// Start with existing messages in history
		const existingUiMessages = [{ type: "ask", ask: "tool", text: "Old tool", ts: 50 }]
		const existingApiMessages = [{ role: "user", content: [{ type: "text", text: "Old request" }], ts: 50 }]

		vi.mocked(readTaskMessages).mockResolvedValue(existingUiMessages as any)
		vi.mocked(readApiMessages).mockResolvedValue(existingApiMessages as any)

		await (ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
			parentTaskId: "p1",
			childTaskId: "c1",
			completionResultSummary: "Subtask completed successfully",
		})

		expect(readTaskMessages).toHaveBeenCalledWith({ taskId: "p1", globalStoragePath: "/storage" })
		expect(readApiMessages).toHaveBeenCalledWith({ taskId: "p1", globalStoragePath: "/storage" })

		// Verify UI history injection (say: subtask_result)
		expect(saveTaskMessages).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: expect.arrayContaining([
					expect.objectContaining({
						messageId: expect.any(String),
						type: "say",
						say: "subtask_result",
						text: "Subtask completed successfully",
					}),
				]),
				taskId: "p1",
				globalStoragePath: "/storage",
				merge: true,
			}),
		)

		// Verify API history injection (user role message)
		expect(saveApiMessages).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: expect.arrayContaining([
					expect.objectContaining({
						messageId: expect.any(String),
						role: "user",
						content: expect.arrayContaining([
							expect.objectContaining({
								type: "text",
								text: expect.stringContaining("Subtask c1 completed"),
							}),
						]),
					}),
				]),
				taskId: "p1",
				globalStoragePath: "/storage",
				merge: true,
			}),
		)

		// Verify both include original messages
		const uiCall = vi.mocked(saveTaskMessages).mock.calls[0][0]
		expect(uiCall.messages).toHaveLength(2) // 1 original + 1 injected

		const apiCall = vi.mocked(saveApiMessages).mock.calls[0][0]
		expect(apiCall.messages).toHaveLength(2) // 1 original + 1 injected
	})

	it("hydrates the reopened parent from locked merge results without authoritative rewrites", async () => {
		const parentItem = {
			id: "parent-merge",
			status: "delegated",
			awaitingChildId: "child-merge",
			childIds: ["child-merge"],
			ts: 100,
			task: "Parent",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const overwriteClineMessages = vi.fn()
		const overwriteApiConversationHistory = vi.fn()
		const taskHistoryStore = makeTaskHistoryStoreStub({ id: "child-merge", status: "active" }, parentItem)
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/storage" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => ({ taskId: "child-merge" })),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue({
				overwriteClineMessages,
				overwriteApiConversationHistory,
				resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
			}),
			taskHistoryStore,
		})

		vi.mocked(readTaskMessages).mockResolvedValue([{ ts: 1, type: "say", say: "text", text: "initial UI" }])
		vi.mocked(readApiMessages).mockResolvedValue([{ ts: 1, role: "user", content: "initial API" }])
		vi.mocked(saveTaskMessages).mockImplementationOnce(
			async ({ messages }) =>
				[
					{ ts: 1, type: "say", say: "text", text: "initial UI", messageId: "ui-initial" },
					{ ts: 2, type: "say", say: "text", text: "concurrent UI", messageId: "ui-concurrent" },
					messages.at(-1)!, // injected subtask_result
				] as ClineMessage[],
		)
		vi.mocked(saveApiMessages).mockImplementationOnce(
			async ({ messages }) =>
				[
					{ ts: 1, role: "user", content: "initial API", messageId: "api-initial" },
					{ ts: 2, role: "assistant", content: "concurrent API", messageId: "api-concurrent" },
					messages.at(-1)!, // injected tool_result / fallback
				] as ApiMessage[],
		)

		await ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
			parentTaskId: "parent-merge",
			childTaskId: "child-merge",
			completionResultSummary: "Done",
		})

		expect(overwriteClineMessages).toHaveBeenCalledWith(
			expect.arrayContaining([
				{ ts: 1, type: "say", say: "text", text: "initial UI", messageId: "ui-initial" },
				{ ts: 2, type: "say", say: "text", text: "concurrent UI", messageId: "ui-concurrent" },
				expect.objectContaining({
					type: "say",
					say: "subtask_result",
					text: "Done",
					messageId: expect.any(String),
				}),
			]),
			false,
		)
		expect(overwriteApiConversationHistory).toHaveBeenCalledWith(
			expect.arrayContaining([
				{ ts: 1, role: "user", content: "initial API", messageId: "api-initial" },
				{ ts: 2, role: "assistant", content: "concurrent API", messageId: "api-concurrent" },
				expect.objectContaining({ role: "user", messageId: expect.any(String) }),
			]),
			false,
		)
	})

	it("does not reopen or overwrite a parent when its UI history cannot be read", async () => {
		const parentItem = {
			id: "parent-read-failure",
			status: "delegated",
			awaitingChildId: "child-read-failure",
			childIds: ["child-read-failure"],
			ts: 100,
			task: "Parent",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const log = vi.fn()
		const taskHistoryStore = makeTaskHistoryStoreStub({ id: "child-read-failure", status: "active" }, parentItem)
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/storage" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			getCurrentTask: vi.fn(() => ({ taskId: "child-read-failure" })),
			taskHistoryStore,
			log,
		})
		vi.mocked(readTaskMessages).mockRejectedValue(new Error("history unavailable"))

		const result = await ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
			parentTaskId: "parent-read-failure",
			childTaskId: "child-read-failure",
			completionResultSummary: "Child done",
		})

		expect(result).toBe(false)
		expect(log).toHaveBeenCalledWith(expect.stringContaining("history unavailable"))
		expect(readApiMessages).not.toHaveBeenCalled()
		expect(saveTaskMessages).not.toHaveBeenCalled()
		expect(saveApiMessages).not.toHaveBeenCalled()
		expect(taskHistoryStore.atomicUpdatePair).not.toHaveBeenCalled()
	})

	it("does not reopen or overwrite a parent when its API history cannot be read", async () => {
		const parentItem = {
			id: "parent-api-read-failure",
			status: "delegated",
			awaitingChildId: "child-api-read-failure",
			childIds: ["child-api-read-failure"],
			ts: 100,
			task: "Parent",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const log = vi.fn()
		const taskHistoryStore = makeTaskHistoryStoreStub(
			{ id: "child-api-read-failure", status: "active" },
			parentItem,
		)
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/storage" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			getCurrentTask: vi.fn(() => ({ taskId: "child-api-read-failure" })),
			taskHistoryStore,
			log,
		})
		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockRejectedValue(new Error("api history unavailable"))

		const result = await ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
			parentTaskId: "parent-api-read-failure",
			childTaskId: "child-api-read-failure",
			completionResultSummary: "Child done",
		})

		expect(result).toBe(false)
		expect(log).toHaveBeenCalledWith(expect.stringContaining("api history unavailable"))
		expect(saveTaskMessages).not.toHaveBeenCalled()
		expect(saveApiMessages).not.toHaveBeenCalled()
		expect(taskHistoryStore.atomicUpdatePair).not.toHaveBeenCalled()
	})

	it("reopenParentFromDelegation injects tool_result when new_task tool_use exists in API history", async () => {
		const parentItem = {
			id: "p-tool",
			status: "delegated",
			awaitingChildId: "c-tool",
			childIds: [],
			ts: 100,
			task: "Parent with tool_use",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const taskHistoryStore = makeTaskHistoryStoreStub({ id: "c-tool", status: "active" }, parentItem)
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/storage" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => ({ taskId: "c-tool" })),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue({
				taskId: "p-tool",
				resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
				overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
				overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
			}),
			taskHistoryStore,
		} as any)

		// Include an assistant message with new_task tool_use to exercise the tool_result path
		const existingUiMessages = [{ type: "ask", ask: "tool", text: "new_task request", ts: 50 }]
		const existingApiMessages = [
			{ role: "user", content: [{ type: "text", text: "Create a subtask" }], ts: 40 },
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						name: "new_task",
						id: "toolu_abc123",
						input: { mode: "code", message: "Do something" },
					},
				],
				ts: 50,
			},
		]

		vi.mocked(readTaskMessages).mockResolvedValue(existingUiMessages as any)
		vi.mocked(readApiMessages).mockResolvedValue(existingApiMessages as any)

		await (ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
			parentTaskId: "p-tool",
			childTaskId: "c-tool",
			completionResultSummary: "Subtask completed via tool_result",
		})

		// Verify API history injection uses tool_result (not text fallback)
		expect(saveApiMessages).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: expect.arrayContaining([
					expect.objectContaining({
						role: "user",
						content: expect.arrayContaining([
							expect.objectContaining({
								type: "tool_result",
								tool_use_id: "toolu_abc123",
								content: expect.stringContaining("Subtask c-tool completed"),
							}),
						]),
					}),
				]),
				taskId: "p-tool",
				globalStoragePath: "/storage",
			}),
		)

		// Verify total message count: 2 original + 1 injected user message with tool_result
		const apiCall = vi.mocked(saveApiMessages).mock.calls[0][0]
		expect(apiCall.messages).toHaveLength(3)

		// Verify the injected message is a user message with tool_result type
		const injectedMsg = apiCall.messages[2]
		expect(injectedMsg.role).toBe("user")
		expect((injectedMsg.content[0] as any).type).toBe("tool_result")
		expect((injectedMsg.content[0] as any).tool_use_id).toBe("toolu_abc123")

		// Format contract with the e2e mock fixtures: the parent-resume fixtures in
		// apps/vscode-e2e/src/fixtures/subtasks.ts match on this injected
		// "completed.\n\nResult:" prefix (SUBTASK_RESULT_INJECTION). If this template
		// changes, update the fixtures in the same PR or they silently never fire.
		expect((injectedMsg.content[0] as any).content).toMatch(/^Subtask .+ completed\.\n\nResult:\n/)
	})

	it("updates an existing matching tool_result instead of appending a duplicate", async () => {
		const parentItem = {
			id: "p-existing-result",
			status: "delegated",
			awaitingChildId: "c-existing-result",
			childIds: ["c-existing-result"],
			ts: 100,
			task: "Parent with an existing result",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const taskHistoryStore = makeTaskHistoryStoreStub({ id: "c-existing-result", status: "active" }, parentItem)
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/storage" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => ({ taskId: "c-existing-result" })),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue({
				resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
				overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
				overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
			}),
			taskHistoryStore,
		})
		const existingApiMessages = [
			{
				role: "assistant" as const,
				content: [
					{ type: "tool_use" as const, name: "read_file", id: "tool-unrelated", input: {} },
					{ type: "tool_use" as const, name: "new_task", id: "tool-existing", input: {} },
				],
			},
			{
				role: "user" as const,
				content: [
					{ type: "tool_result" as const, tool_use_id: "tool-unrelated", content: "read result" },
					{ type: "tool_result" as const, tool_use_id: "tool-existing", content: "old result" },
				],
			},
		]

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue(existingApiMessages)

		await ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
			parentTaskId: "p-existing-result",
			childTaskId: "c-existing-result",
			completionResultSummary: "replacement result",
		})

		const persistedApiMessages = vi.mocked(saveApiMessages).mock.calls[0][0].messages
		expect(persistedApiMessages).toHaveLength(2)
		expect(persistedApiMessages[1]).toMatchObject({
			role: "user",
			content: expect.arrayContaining([
				{
					type: "tool_result",
					tool_use_id: "tool-existing",
					content: "Subtask c-existing-result completed.\n\nResult:\nreplacement result",
				},
			]),
		})
	})

	it("reopenParentFromDelegation injects plain text when no new_task tool_use exists in API history", async () => {
		const parentItem = {
			id: "p-no-tool",
			status: "delegated",
			awaitingChildId: "c-no-tool",
			childIds: [],
			ts: 100,
			task: "Parent without tool_use",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const taskHistoryStore = makeTaskHistoryStoreStub({ id: "c-no-tool", status: "active" }, parentItem)
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/storage" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => ({ taskId: "c-no-tool" })),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue({
				taskId: "p-no-tool",
				resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
				overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
				overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
			}),
			taskHistoryStore,
		} as any)

		// No assistant tool_use in history
		const existingUiMessages = [{ type: "ask", ask: "tool", text: "subtask request", ts: 50 }]
		const existingApiMessages = [{ role: "user", content: [{ type: "text", text: "Create a subtask" }], ts: 40 }]

		vi.mocked(readTaskMessages).mockResolvedValue(existingUiMessages as any)
		vi.mocked(readApiMessages).mockResolvedValue(existingApiMessages as any)

		await (ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
			parentTaskId: "p-no-tool",
			childTaskId: "c-no-tool",
			completionResultSummary: "Subtask completed without tool_use",
		})

		const apiCall = vi.mocked(saveApiMessages).mock.calls[0][0]
		// Should append a user text note
		expect(apiCall.messages).toHaveLength(2)
		const injected = apiCall.messages[1]
		expect(injected.role).toBe("user")
		expect((injected.content[0] as any).type).toBe("text")
		expect((injected.content[0] as any).text).toContain("Subtask c-no-tool completed")
	})

	it("keeps already-injected UI and fallback API completion records idempotent", async () => {
		const parentItem = {
			id: "p-existing-fallback",
			status: "delegated",
			awaitingChildId: "c-existing-fallback",
			childIds: ["c-existing-fallback"],
			ts: 100,
			task: "Parent with existing fallback",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const completionResultSummary = "Already recorded"
		const fallbackText = `Subtask c-existing-fallback completed.\n\nResult:\n${completionResultSummary}`
		const existingUiMessages = [
			{
				type: "say" as const,
				say: "subtask_result" as const,
				text: completionResultSummary,
				ts: 50,
			},
		]
		const existingApiMessages = [
			{ role: "user" as const, content: [{ type: "text" as const, text: fallbackText }], ts: 50 },
		]
		const taskHistoryStore = makeTaskHistoryStoreStub({ id: "c-existing-fallback", status: "active" }, parentItem)
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/storage" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => ({ taskId: "c-existing-fallback" })),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue({
				resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
				overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
				overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
			}),
			taskHistoryStore,
		})

		vi.mocked(readTaskMessages).mockResolvedValue(existingUiMessages)
		vi.mocked(readApiMessages).mockResolvedValue(existingApiMessages)

		await ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
			parentTaskId: "p-existing-fallback",
			childTaskId: "c-existing-fallback",
			completionResultSummary,
		})

		expect(vi.mocked(saveTaskMessages).mock.calls[0][0].messages).toEqual(existingUiMessages)
		expect(vi.mocked(saveApiMessages).mock.calls[0][0].messages).toEqual(existingApiMessages)
	})

	it("reopenParentFromDelegation sets skipPrevResponseIdOnce via resumeAfterDelegation", async () => {
		const parentInstance: any = {
			taskId: "parent-2",
			skipPrevResponseIdOnce: false,
			resumeAfterDelegation: vi.fn().mockImplementation(async function (this: any) {
				// Simulate what the real resumeAfterDelegation does
				this.skipPrevResponseIdOnce = true
			}),
			overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
			overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
		}

		const parentItem = {
			id: "parent-2",
			status: "delegated",
			awaitingChildId: "child-2",
			childIds: [],
			ts: 200,
			task: "P",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const taskHistoryStore = makeTaskHistoryStoreStub({ id: "child-2", status: "active" }, parentItem)
		let currentTask: object | undefined = { taskId: "child-2" }
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => currentTask),
			removeClineFromStack: vi.fn(async () => {
				currentTask = undefined
			}),
			createTaskWithHistoryItem: vi.fn(async () => (currentTask = parentInstance)),
			taskHistoryStore,
		} as any)

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await (ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
			parentTaskId: "parent-2",
			childTaskId: "child-2",
			completionResultSummary: "Done",
		})
		await vi.waitFor(() => expect(parentInstance.resumeAfterDelegation).toHaveBeenCalledTimes(1))

		// Critical: verify skipPrevResponseIdOnce set to true by resumeAfterDelegation
		expect(parentInstance.skipPrevResponseIdOnce).toBe(true)
		expect(parentInstance.resumeAfterDelegation).toHaveBeenCalledTimes(1)
	})

	it("reopenParentFromDelegation emits events in correct order: TaskDelegationCompleted → TaskDelegationResumed", async () => {
		const emitSpy = vi.fn()
		const parentItem = {
			id: "p3",
			status: "delegated",
			awaitingChildId: "c3",
			childIds: [],
			ts: 300,
			task: "P3",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const taskHistoryStore = makeTaskHistoryStoreStub({ id: "c3", status: "active" }, parentItem)

		const parentInstance = {
			taskId: "p3",
			resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
			overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
			overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
		}
		let currentTask: object | undefined = { taskId: "c3" }
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			emit: emitSpy,
			getCurrentTask: vi.fn(() => currentTask),
			removeClineFromStack: vi.fn(async () => {
				currentTask = undefined
			}),
			createTaskWithHistoryItem: vi.fn(async () => (currentTask = parentInstance)),
			taskHistoryStore,
		} as any)

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await (ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
			parentTaskId: "p3",
			childTaskId: "c3",
			completionResultSummary: "Summary",
		})
		await vi.waitFor(() => expect(parentInstance.resumeAfterDelegation).toHaveBeenCalledTimes(1))

		// Verify both events emitted
		const eventNames = emitSpy.mock.calls.map((c) => c[0])
		expect(eventNames).toContain(RooCodeEventName.TaskDelegationCompleted)
		expect(eventNames).toContain(RooCodeEventName.TaskDelegationResumed)

		// CRITICAL: verify ordering (TaskDelegationCompleted before TaskDelegationResumed)
		const completedIdx = emitSpy.mock.calls.findIndex((c) => c[0] === RooCodeEventName.TaskDelegationCompleted)
		const resumedIdx = emitSpy.mock.calls.findIndex((c) => c[0] === RooCodeEventName.TaskDelegationResumed)
		expect(completedIdx).toBeGreaterThanOrEqual(0)
		expect(resumedIdx).toBeGreaterThan(completedIdx)

		// RPD-05: atomicUpdatePair must be called before TaskDelegationCompleted
		const atomicCallOrder = taskHistoryStore.atomicUpdatePair.mock.invocationCallOrder[0]
		const completedEmitCallOrder = emitSpy.mock.invocationCallOrder[completedIdx]
		expect(atomicCallOrder).toBeLessThan(completedEmitCallOrder)
	})

	it("reopenParentFromDelegation continues when overwrite operations fail and still resumes/emits (RPD-06)", async () => {
		const emitSpy = vi.fn()
		const parentInstance = {
			taskId: "parent-rpd06",
			resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
			overwriteClineMessages: vi.fn().mockRejectedValue(new Error("ui overwrite failed")),
			overwriteApiConversationHistory: vi.fn().mockRejectedValue(new Error("api overwrite failed")),
		}

		const parentItem = {
			id: "parent-rpd06",
			status: "delegated",
			awaitingChildId: "child-rpd06",
			childIds: ["child-rpd06"],
			ts: 800,
			task: "Parent RPD-06",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const taskHistoryStore = makeTaskHistoryStoreStub({ id: "child-rpd06", status: "active" }, parentItem)

		let currentTask: object | undefined = { taskId: "child-rpd06" }
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			emit: emitSpy,
			getCurrentTask: vi.fn(() => currentTask),
			removeClineFromStack: vi.fn(async () => {
				currentTask = undefined
			}),
			createTaskWithHistoryItem: vi.fn(async () => (currentTask = parentInstance)),
			taskHistoryStore,
		} as any)

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await expect(
			ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
				parentTaskId: "parent-rpd06",
				childTaskId: "child-rpd06",
				completionResultSummary: "Subtask finished despite overwrite failures",
			}),
		).resolves.toBe(true)
		await vi.waitFor(() => expect(parentInstance.resumeAfterDelegation).toHaveBeenCalledTimes(1))

		expect(parentInstance.overwriteClineMessages).toHaveBeenCalledTimes(1)
		expect(parentInstance.overwriteApiConversationHistory).toHaveBeenCalledTimes(1)
		expect(parentInstance.overwriteClineMessages).toHaveBeenCalledWith(expect.any(Array), false)
		expect(parentInstance.overwriteApiConversationHistory).toHaveBeenCalledWith(expect.any(Array), false)
		expect(parentInstance.resumeAfterDelegation).toHaveBeenCalledTimes(1)

		expect(emitSpy).toHaveBeenCalledWith(
			RooCodeEventName.TaskDelegationCompleted,
			"parent-rpd06",
			"child-rpd06",
			"Subtask finished despite overwrite failures",
		)
		expect(emitSpy).toHaveBeenCalledWith(RooCodeEventName.TaskDelegationResumed, "parent-rpd06", "child-rpd06")

		const completedIdx = emitSpy.mock.calls.findIndex((c) => c[0] === RooCodeEventName.TaskDelegationCompleted)
		const resumedIdx = emitSpy.mock.calls.findIndex((c) => c[0] === RooCodeEventName.TaskDelegationResumed)
		expect(completedIdx).toBeGreaterThanOrEqual(0)
		expect(resumedIdx).toBeGreaterThan(completedIdx)
	})

	it("does not admit an aborted parent through the default scheduler stub", async () => {
		const parentItem = {
			id: "parent-not-admitted",
			status: "delegated",
			awaitingChildId: "child-not-admitted",
			childIds: ["child-not-admitted"],
			ts: 1,
			task: "Parent",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const parentInstance = {
			taskId: parentItem.id,
			abort: true,
			resumeAfterDelegation: vi.fn(),
			overwriteClineMessages: vi.fn(),
			overwriteApiConversationHistory: vi.fn(),
		}
		let currentTask: object | undefined = { taskId: "child-not-admitted" }
		const emit = vi.fn()
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			getCurrentTask: vi.fn(() => currentTask),
			removeClineFromStack: vi.fn(async () => {
				currentTask = undefined
			}),
			createTaskWithHistoryItem: vi.fn(async () => (currentTask = parentInstance)),
			taskHistoryStore: makeTaskHistoryStoreStub({ id: "child-not-admitted", status: "active" }, parentItem),
			emit,
		})
		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await expect(
			ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
				parentTaskId: parentItem.id,
				childTaskId: "child-not-admitted",
				completionResultSummary: "done",
			}),
		).resolves.toBe(true)
		await Promise.resolve()

		expect(parentInstance.resumeAfterDelegation).not.toHaveBeenCalled()
		expect(emit).not.toHaveBeenCalledWith(
			RooCodeEventName.TaskDelegationResumed,
			parentItem.id,
			"child-not-admitted",
		)
	})

	it("keeps a failed scheduled parent resume visible and resumable without emitting resumed success", async () => {
		const resumeError = new Error("provider stream failed")
		const emitSpy = vi.fn()
		const log = vi.fn()
		const parentInstance = {
			taskId: "parent-resume-failure",
			resumeAfterDelegation: vi.fn().mockRejectedValue(resumeError),
			overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
			overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
		}
		const parentItem = {
			id: "parent-resume-failure",
			status: "delegated",
			awaitingChildId: "child-resume-failure",
			childIds: ["child-resume-failure"],
			ts: 900,
			task: "Parent resume failure",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const taskHistoryStore = makeTaskHistoryStoreStub({ id: "child-resume-failure", status: "active" }, parentItem)
		let currentTask: object | undefined = { taskId: "child-resume-failure" }
		let scheduled: Promise<void> | undefined
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			emit: emitSpy,
			log,
			getCurrentTask: vi.fn(() => currentTask),
			removeClineFromStack: vi.fn(async () => {
				currentTask = undefined
			}),
			createTaskWithHistoryItem: vi.fn(async () => (currentTask = parentInstance)),
			taskScheduler: {
				schedule: vi.fn((_task, run) => {
					scheduled = run()
					return scheduled
				}),
			},
			taskHistoryStore,
		})

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		await expect(
			ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
				parentTaskId: "parent-resume-failure",
				childTaskId: "child-resume-failure",
				completionResultSummary: "Child completed",
			}),
		).resolves.toBe(true)
		await expect(scheduled).rejects.toThrow(resumeError)

		expect(log).toHaveBeenCalledWith(expect.stringContaining("provider stream failed"))
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			expect.stringContaining("Open the task from history to retry"),
		)
		expect(emitSpy).not.toHaveBeenCalledWith(
			RooCodeEventName.TaskDelegationResumed,
			"parent-resume-failure",
			"child-resume-failure",
		)
		expect(parentInstance.taskId).toBe("parent-resume-failure")
		consoleError.mockRestore()
	})

	it("releases the shared parent queue when scheduler admission rejects", async () => {
		const scheduleError = new Error("scheduler unavailable")
		const parentInstance = {
			taskId: "parent-scheduler-rejection",
			resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
			overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
			overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
		}
		const parentItem = {
			id: parentInstance.taskId,
			status: "delegated",
			awaitingChildId: "child-scheduler-rejection",
			childIds: ["child-scheduler-rejection"],
			ts: 901,
			task: "Parent scheduler rejection",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const taskHistoryStore = makeTaskHistoryStoreStub(
			{ id: "child-scheduler-rejection", status: "active" },
			parentItem,
		)
		const emit = vi.fn()
		let currentTask: object | undefined = { taskId: "child-scheduler-rejection" }
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			emit,
			getCurrentTask: vi.fn(() => currentTask),
			removeClineFromStack: vi.fn(async () => {
				currentTask = undefined
			}),
			createTaskWithHistoryItem: vi.fn(async () => (currentTask = parentInstance)),
			taskScheduler: {
				schedule: vi.fn().mockRejectedValue(scheduleError),
			},
			taskHistoryStore,
		})
		const laterTransition = vi.fn()
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])
		await expect(
			ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
				parentTaskId: parentInstance.taskId,
				childTaskId: "child-scheduler-rejection",
				completionResultSummary: "Child completed",
			}),
		).resolves.toBe(true)
		await (
			ClineProvider.prototype as unknown as {
				runDelegationTransition: (
					this: ClineProvider,
					parentTaskId: string,
					fn: () => Promise<void>,
				) => Promise<void>
			}
		).runDelegationTransition.call(provider, parentInstance.taskId, async () => laterTransition())

		expect(parentInstance.resumeAfterDelegation).not.toHaveBeenCalled()
		expect(laterTransition).toHaveBeenCalledTimes(1)
		expect(emit).not.toHaveBeenCalledWith(
			RooCodeEventName.TaskDelegationResumed,
			parentInstance.taskId,
			"child-scheduler-rejection",
		)
		expect(consoleError).toHaveBeenCalledWith(
			`[reopenParentFromDelegation] taskScheduler.schedule failed:`,
			scheduleError,
		)
		consoleError.mockRestore()
	})

	it("reopenParentFromDelegation does NOT emit TaskPaused or TaskUnpaused (new flow only)", async () => {
		const emitSpy = vi.fn()
		const parentItem = {
			id: "p4",
			status: "delegated",
			awaitingChildId: "c4",
			childIds: [],
			ts: 400,
			task: "P4",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const taskHistoryStore = makeTaskHistoryStoreStub({ id: "c4", status: "active" }, parentItem)

		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			emit: emitSpy,
			getCurrentTask: vi.fn(() => ({ taskId: "c4" })),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue({
				resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
				overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
				overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
			}),
			taskHistoryStore,
		} as any)

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await (ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
			parentTaskId: "p4",
			childTaskId: "c4",
			completionResultSummary: "S",
		})

		// CRITICAL: verify legacy pause/unpause events NOT emitted
		const eventNames = emitSpy.mock.calls.map((c) => c[0])
		expect(eventNames).not.toContain(RooCodeEventName.TaskPaused)
		expect(eventNames).not.toContain(RooCodeEventName.TaskUnpaused)
		expect(eventNames).not.toContain(RooCodeEventName.TaskSpawned)
	})

	it("persists completion without evicting or rehydrating over another current task (RPD-02)", async () => {
		const parentInstance = {
			resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
			overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
			overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
		}

		const parentItem = {
			id: "parent-rpd02",
			status: "delegated",
			awaitingChildId: "child-rpd02",
			childIds: ["child-rpd02"],
			ts: 600,
			task: "Parent RPD-02",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const taskHistoryStore = makeTaskHistoryStoreStub({ id: "child-rpd02", status: "active" }, parentItem)
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const createTaskWithHistoryItem = vi.fn().mockResolvedValue(parentInstance)

		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => ({ taskId: "different-open-task" })),
			removeClineFromStack,
			createTaskWithHistoryItem,
			taskHistoryStore,
		} as any)

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await (ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
			parentTaskId: "parent-rpd02",
			childTaskId: "child-rpd02",
			completionResultSummary: "Child done without being current",
		})

		expect(removeClineFromStack).not.toHaveBeenCalled()

		// Verify atomicUpdatePair guards the parent before completing the child.
		expect(taskHistoryStore.atomicUpdatePair).toHaveBeenCalledTimes(1)
		const [firstId, secondId, firstUpdater, secondUpdater] = taskHistoryStore.atomicUpdatePair.mock.calls[0]
		expect(firstId).toBe("parent-rpd02")
		expect(secondId).toBe("child-rpd02")
		const updatedChild = secondUpdater({ id: "child-rpd02", status: "active" } as HistoryItem)
		expect(updatedChild.status).toBe("completed")
		const updatedParent = firstUpdater(parentItem as HistoryItem)
		expect(updatedParent).toMatchObject({ id: "parent-rpd02", status: "active", completedByChildId: "child-rpd02" })

		expect(createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(taskHistoryStore.get("parent-rpd02")).toMatchObject({
			status: "active",
			completedByChildId: "child-rpd02",
		})
		expect(taskHistoryStore.get("child-rpd02")).toMatchObject({ status: "completed" })
		expect(taskHistoryStore.invalidate).not.toHaveBeenCalled()
		expect(parentInstance.resumeAfterDelegation).not.toHaveBeenCalled()
	})

	it("serializes real cross-provider completion and redelegation through resume invocation", async () => {
		let releaseResume!: () => void
		const resumeBlocked = new Promise<void>((resolve) => {
			releaseResume = resolve
		})
		let releaseChildRun!: () => void
		const childRunBlocked = new Promise<void>((resolve) => {
			releaseChildRun = resolve
		})
		const parentInstanceA = {
			taskId: "parent-shared-transition",
			abort: false,
			abandoned: false,
			resumeAfterDelegation: vi.fn(() => resumeBlocked),
			overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
			overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
		}
		const parentItem = {
			id: parentInstanceA.taskId,
			status: "delegated",
			awaitingChildId: "child-c1",
			delegatedToId: "child-c1",
			childIds: ["child-c1"],
			ts: 1,
			task: "Parent",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			mode: "code",
		} as HistoryItem
		const taskHistoryStore = makeStatefulTaskHistoryStore(parentItem, {
			id: "child-c1",
			status: "active",
			parentTaskId: parentItem.id,
		} as HistoryItem)
		let currentTaskA: object | undefined = { taskId: "child-c1" }
		let runScheduledContinuation!: () => Promise<void>
		let settleScheduledContinuation!: () => void
		const scheduledContinuationSettled = new Promise<void>((resolve) => {
			settleScheduledContinuation = resolve
		})
		let scheduledContinuation: Promise<void> | undefined
		const emitA = vi.fn()
		const scheduleParent = vi.fn((_task, run) => {
			runScheduledContinuation = () => (scheduledContinuation ??= run())
			return scheduledContinuationSettled
		})
		const providerA = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn(async (id: string) => ({ historyItem: taskHistoryStore.get(id)! })),
			emit: emitA,
			getCurrentTask: vi.fn(() => currentTaskA),
			removeClineFromStack: vi.fn(async () => {
				currentTaskA = undefined
			}),
			createTaskWithHistoryItem: vi.fn(async () => (currentTaskA = parentInstanceA)),
			taskScheduler: {
				schedule: scheduleParent,
			},
			taskHistoryStore,
		})
		const parentInstanceB = {
			taskId: parentItem.id,
			apiConfiguration: { apiProvider: providerIdentifiers.anthropic, anthropicApiKey: "task-local-key" },
			getTaskMode: vi.fn().mockResolvedValue("code"),
			getTaskApiConfigName: vi.fn().mockResolvedValue("task-local-profile"),
			flushPendingToolResultsToHistory: vi.fn().mockResolvedValue(true),
			retrySaveApiConversationHistory: vi.fn(),
		}
		const childC2 = {
			taskId: "child-c2",
			run: vi.fn(async () => {
				expect(taskHistoryStore.get(parentItem.id)).toMatchObject({
					status: "delegated",
					awaitingChildId: "child-c2",
				})
				await childRunBlocked
			}),
		}
		let currentTaskB: object | undefined = parentInstanceB
		let childRun: Promise<void> | undefined
		const removeParentB = vi.fn(async () => {
			currentTaskB = undefined
		})
		const createChildC2 = vi.fn(async () => {
			currentTaskB = childC2
			return childC2
		})
		const providerB = makeProviderStub({
			taskHistoryStore,
			getCurrentTask: vi.fn(() => currentTaskB),
			removeClineFromStack: removeParentB,
			createTask: createChildC2,
			taskScheduler: {
				schedule: vi.fn((_task, run) => (childRun = run())),
			},
			emit: vi.fn(),
			log: vi.fn(),
			isViewLaunched: false,
		})

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])
		await ClineProvider.prototype.reopenParentFromDelegation.call(providerA, {
			parentTaskId: parentItem.id,
			childTaskId: "child-c1",
			completionResultSummary: "C1 done",
		})
		expect(taskHistoryStore.get("child-c1")).toMatchObject({ status: "completed" })
		expect(taskHistoryStore.get(parentItem.id)).toMatchObject({
			status: "active",
			completedByChildId: "child-c1",
			awaitingChildId: undefined,
		})

		const providerBTransition = ClineProvider.prototype.delegateParentAndOpenChild.call(providerB, {
			parentTaskId: parentItem.id,
			message: "Run C2",
			initialTodos: [],
			mode: "code",
		})

		await Promise.resolve()
		expect(removeParentB).not.toHaveBeenCalled()
		expect(createChildC2).not.toHaveBeenCalled()
		expect(taskHistoryStore.atomicReadAndUpdate).not.toHaveBeenCalled()

		expect(scheduleParent).toHaveBeenCalledOnce()
		await vi.waitFor(() => expect(runScheduledContinuation).toEqual(expect.any(Function)))
		const continuationRun = runScheduledContinuation()
		await vi.waitFor(() => expect(parentInstanceA.resumeAfterDelegation).toHaveBeenCalledTimes(1))
		await expect(providerBTransition).resolves.toBe(childC2)
		expect(removeParentB).toHaveBeenCalledTimes(1)
		expect(createChildC2).toHaveBeenCalledTimes(1)
		expect(taskHistoryStore.atomicReadAndUpdate).toHaveBeenCalledTimes(1)
		expect(taskHistoryStore.get(parentItem.id)).toMatchObject({
			status: "delegated",
			awaitingChildId: "child-c2",
			delegatedToId: "child-c2",
			childIds: ["child-c1", "child-c2"],
		})
		await vi.waitFor(() => expect(childC2.run).toHaveBeenCalledTimes(1))
		expect(parentInstanceA.resumeAfterDelegation).toHaveBeenCalledTimes(1)
		expect(emitA).not.toHaveBeenCalledWith(RooCodeEventName.TaskDelegationResumed, parentItem.id, "child-c1")

		releaseChildRun()
		await childRun
		releaseResume()
		await continuationRun
		settleScheduledContinuation()
		await scheduledContinuationSettled
		expect(emitA).toHaveBeenCalledWith(RooCodeEventName.TaskDelegationResumed, parentItem.id, "child-c1")
	})

	it("allows resumed work to re-enter the same parent transition queue", async () => {
		const parentInstance = {
			taskId: "parent-reentrant",
			abort: false,
			abandoned: false,
			resumeAfterDelegation: vi.fn<() => Promise<void>>(),
			overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
			overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
		}
		const parentItem = {
			id: parentInstance.taskId,
			status: "delegated",
			awaitingChildId: "child-reentrant",
			childIds: ["child-reentrant"],
			ts: 1,
			task: "Parent",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const taskHistoryStore = makeTaskHistoryStoreStub({ id: "child-reentrant", status: "active" }, parentItem)
		let currentTask: object | undefined = { taskId: "child-reentrant" }
		let runScheduledContinuation!: () => Promise<void>
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => currentTask),
			removeClineFromStack: vi.fn(async () => {
				currentTask = undefined
			}),
			createTaskWithHistoryItem: vi.fn(async () => (currentTask = parentInstance)),
			taskScheduler: {
				schedule: vi.fn((_task, run) => {
					runScheduledContinuation = run
					return new Promise<void>(() => {})
				}),
			},
			taskHistoryStore,
		})
		const reentrantTransition = vi.fn()
		parentInstance.resumeAfterDelegation.mockImplementation(async () => {
			await (
				ClineProvider.prototype as unknown as {
					runDelegationTransition: (
						this: ClineProvider,
						parentTaskId: string,
						fn: () => Promise<void>,
					) => Promise<void>
				}
			).runDelegationTransition.call(provider, parentInstance.taskId, async () => reentrantTransition())
		})

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])
		await ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
			parentTaskId: parentInstance.taskId,
			childTaskId: "child-reentrant",
			completionResultSummary: "done",
		})
		await runScheduledContinuation()

		expect(parentInstance.resumeAfterDelegation).toHaveBeenCalledTimes(1)
		expect(reentrantTransition).toHaveBeenCalledTimes(1)
	})

	it.each([
		{ name: "cancelled child", cancelled: true },
		{ name: "aborted parent instance", instance: { abort: true } },
		{ name: "abandoned parent instance", instance: { abandoned: true } },
		{ name: "current parent instance mismatch", currentMismatch: true },
		{ name: "missing persisted parent", missingPersisted: true },
		{ name: "non-active persisted parent", persisted: { status: "delegated" as const } },
		{ name: "wrong completing child", persisted: { completedByChildId: "child-c2" } },
		{ name: "new awaited child", persisted: { awaitingChildId: "child-c2" } },
		{ name: "new delegated child", persisted: { delegatedToId: "child-c2" } },
	])(
		"skips resume for $name during ownership revalidation",
		async ({ cancelled, instance, currentMismatch, missingPersisted, persisted }) => {
			const emit = vi.fn()
			const log = vi.fn()
			const parentInstance = {
				taskId: "parent-stale-owner",
				abort: instance?.abort ?? false,
				abandoned: instance?.abandoned ?? false,
				resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
				overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
				overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
			}
			const parentItem = {
				id: parentInstance.taskId,
				status: "delegated",
				awaitingChildId: "child-c1",
				childIds: ["child-c1"],
				ts: 1,
				task: "Parent",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			}
			const taskHistoryStore = makeTaskHistoryStoreStub({ id: "child-c1", status: "active" }, parentItem)
			let currentTask: object | undefined = { taskId: "child-c1" }
			let runScheduledContinuation!: () => Promise<void>
			const cancelledDelegationChildIds = new Set<string>()
			const provider = makeProviderStub({
				contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
				getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
				emit,
				log,
				getCurrentTask: vi.fn(() => currentTask),
				removeClineFromStack: vi.fn(async () => {
					currentTask = undefined
				}),
				createTaskWithHistoryItem: vi.fn(async () => (currentTask = parentInstance)),
				taskScheduler: {
					schedule: vi.fn((_task, run) => {
						runScheduledContinuation = run
						return new Promise<void>(() => {})
					}),
				},
				taskHistoryStore,
				cancelledDelegationChildIds,
			})

			vi.mocked(readTaskMessages).mockResolvedValue([])
			vi.mocked(readApiMessages).mockResolvedValue([])
			await ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
				parentTaskId: parentInstance.taskId,
				childTaskId: "child-c1",
				completionResultSummary: "C1 done",
			})
			const completedParent = taskHistoryStore.get(parentInstance.taskId)
			if (cancelled) cancelledDelegationChildIds.add("child-c1")
			if (currentMismatch) currentTask = { taskId: "other-parent-instance" }
			taskHistoryStore.get.mockImplementation((id: string) =>
				id === parentInstance.taskId && !missingPersisted
					? ({ ...completedParent, ...persisted } as HistoryItem)
					: undefined,
			)

			await runScheduledContinuation()
			expect(parentInstance.resumeAfterDelegation).not.toHaveBeenCalled()
			expect(emit).not.toHaveBeenCalledWith(
				RooCodeEventName.TaskDelegationResumed,
				parentInstance.taskId,
				"child-c1",
			)
			expect(log).toHaveBeenCalledWith(expect.stringContaining("Skipping stale parent continuation"))
		},
	)

	it("reopenParentFromDelegation propagates atomicUpdatePair failure — parent not reopened (RPD-04)", async () => {
		const parentItem = {
			id: "parent-rpd04",
			status: "delegated",
			awaitingChildId: "child-rpd04",
			childIds: ["child-rpd04"],
			ts: 700,
			task: "Parent RPD-04",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const persistError = new Error("atomic pair write failed")
		const atomicUpdatePair = vi.fn().mockRejectedValue(persistError)
		const taskHistoryStore = makeTaskHistoryStoreStub({ id: "child-rpd04", status: "active" }, parentItem, {
			atomicUpdatePair,
		})
		const createTaskWithHistoryItem = vi.fn()

		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => ({ taskId: "child-rpd04" })),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem,
			taskHistoryStore,
		} as any)

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		// Failure propagates — child is closed (step 4 already ran) but parent is NOT reopened
		await expect(
			(ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
				parentTaskId: "parent-rpd04",
				childTaskId: "child-rpd04",
				completionResultSummary: "Child completion with persistence failure",
			}),
		).rejects.toThrow(persistError)

		expect(createTaskWithHistoryItem).not.toHaveBeenCalled()
	})

	it("reopenParentFromDelegation aborts parent reopen when all persistence paths fail (RPD-05)", async () => {
		const persistError = new Error("parent status persist failed")
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const createTaskWithHistoryItem = vi.fn()
		const parentItem = {
			id: "parent-rpd05",
			status: "delegated",
			awaitingChildId: "child-rpd05",
			childIds: ["child-rpd05"],
			ts: 800,
			task: "Parent RPD-05",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		// atomicUpdatePair failure aborts the reopen flow.
		const atomicUpdatePair = vi.fn().mockRejectedValue(persistError)
		const taskHistoryStore = makeTaskHistoryStoreStub({ id: "child-rpd05", status: "active" }, parentItem, {
			atomicUpdatePair,
		})

		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			emit: vi.fn(),
			log: vi.fn(),
			getCurrentTask: vi.fn(() => ({ taskId: "child-rpd05" })),
			removeClineFromStack,
			createTaskWithHistoryItem,
			taskHistoryStore,
			updateTaskHistory: vi.fn().mockRejectedValue(persistError),
		} as any)

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await expect(
			(ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
				parentTaskId: "parent-rpd05",
				childTaskId: "child-rpd05",
				completionResultSummary: "Child completion",
			}),
		).rejects.toThrow(persistError)

		// A failed handoff leaves the child available for retry.
		expect(removeClineFromStack).not.toHaveBeenCalled()
		expect(createTaskWithHistoryItem).not.toHaveBeenCalled()
	})

	it("keeps the delegation retryable when API history persistence fails", async () => {
		const parentItem = {
			id: "parent-api-save-failure",
			status: "delegated",
			awaitingChildId: "child-api-save-failure",
			childIds: ["child-api-save-failure"],
			ts: 1,
			task: "Parent",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const originalUiMessages = [{ type: "say" as const, say: "text" as const, text: "before", ts: 1 }]
		const originalApiMessages = [{ role: "user" as const, content: [{ type: "text" as const, text: "before" }] }]
		const taskHistoryStore = makeTaskHistoryStoreStub(
			{ id: "child-api-save-failure", status: "active" },
			parentItem,
		)
		const removeClineFromStack = vi.fn()
		const createTaskWithHistoryItem = vi.fn()
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			getCurrentTask: vi.fn(() => ({ taskId: "child-api-save-failure" })),
			removeClineFromStack,
			createTaskWithHistoryItem,
			taskHistoryStore,
		})

		vi.mocked(readTaskMessages).mockResolvedValue(structuredClone(originalUiMessages))
		vi.mocked(readApiMessages).mockResolvedValue(structuredClone(originalApiMessages))
		vi.mocked(saveApiMessages)
			.mockRejectedValueOnce(new Error("api save failed"))
			.mockImplementationOnce(async ({ messages }) => messages)

		await expect(
			ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
				parentTaskId: "parent-api-save-failure",
				childTaskId: "child-api-save-failure",
				completionResultSummary: "Done",
			}),
		).rejects.toThrow("api save failed")

		expect(taskHistoryStore.atomicUpdatePair).toHaveBeenCalledTimes(1)
		expect(taskHistoryStore.get("parent-api-save-failure")).toEqual(parentItem)
		expect(taskHistoryStore.get("child-api-save-failure")).toMatchObject({ status: "active" })
		expect(removeClineFromStack).not.toHaveBeenCalled()
		expect(createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(saveTaskMessages).toHaveBeenLastCalledWith(
			expect.objectContaining({ messages: originalUiMessages, merge: false }),
		)
		expect(saveApiMessages).toHaveBeenLastCalledWith(
			expect.objectContaining({ messages: originalApiMessages, merge: false }),
		)
	})

	it("surfaces all restoration failures without committing completion metadata", async () => {
		const parentItem = {
			id: "parent-restore-failure",
			status: "delegated",
			awaitingChildId: "child-restore-failure",
			childIds: ["child-restore-failure"],
			ts: 1,
			task: "Parent",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const taskHistoryStore = makeTaskHistoryStoreStub({ id: "child-restore-failure", status: "active" }, parentItem)
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			getCurrentTask: vi.fn(() => ({ taskId: "child-restore-failure" })),
			removeClineFromStack: vi.fn(),
			createTaskWithHistoryItem: vi.fn(),
			taskHistoryStore,
		})

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])
		const initialError = new Error("initial UI save failed")
		const uiRestoreError = new Error("UI restore failed")
		const apiRestoreError = new Error("API restore failed")
		vi.mocked(saveTaskMessages).mockRejectedValueOnce(initialError).mockRejectedValueOnce(uiRestoreError)
		vi.mocked(saveApiMessages).mockRejectedValueOnce(apiRestoreError)

		const result = ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
			parentTaskId: "parent-restore-failure",
			childTaskId: "child-restore-failure",
			completionResultSummary: "Done",
		})
		await expect(result).rejects.toMatchObject({
			name: "AggregateError",
			message: expect.stringContaining("Failed to restore parent parent-restore-failure conversation files"),
			errors: [initialError, uiRestoreError, apiRestoreError],
		})
		expect(taskHistoryStore.atomicUpdatePair).toHaveBeenCalledTimes(1)
		expect(taskHistoryStore.get("parent-restore-failure")).toEqual(parentItem)
		expect(taskHistoryStore.get("child-restore-failure")).toMatchObject({ status: "active" })
	})

	it("logs a UI history read rejection and returns false without changing persistence or the task stack", async () => {
		const parentItem = {
			id: "parent-read-failure",
			status: "delegated",
			awaitingChildId: "child-read-failure",
			childIds: ["child-read-failure"],
			ts: 1,
			task: "Parent",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const taskHistoryStore = makeTaskHistoryStoreStub({ id: "child-read-failure", status: "active" }, parentItem)
		const removeClineFromStack = vi.fn()
		const createTaskWithHistoryItem = vi.fn()
		const log = vi.fn()
		const taskScheduler = { schedule: vi.fn() }
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			getCurrentTask: vi.fn(() => ({ taskId: "child-read-failure" })),
			removeClineFromStack,
			createTaskWithHistoryItem,
			taskHistoryStore,
			taskScheduler,
			log,
		})

		vi.mocked(readTaskMessages).mockRejectedValue(new Error("UI read failed"))
		vi.mocked(readApiMessages).mockResolvedValue([])

		await expect(
			ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
				parentTaskId: "parent-read-failure",
				childTaskId: "child-read-failure",
				completionResultSummary: "Done",
			}),
		).resolves.toBe(false)

		expect(readApiMessages).not.toHaveBeenCalled()
		expect(saveTaskMessages).not.toHaveBeenCalled()
		expect(saveApiMessages).not.toHaveBeenCalled()
		expect(taskHistoryStore.atomicUpdatePair).not.toHaveBeenCalled()
		expect(removeClineFromStack).not.toHaveBeenCalled()
		expect(createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(taskScheduler.schedule).not.toHaveBeenCalled()
		expect(log).toHaveBeenCalledWith(expect.stringContaining("UI read failed"))
	})

	it("logs an API history read rejection and returns false without changing persistence or the task stack", async () => {
		const parentItem = {
			id: "parent-api-read-failure",
			status: "delegated",
			awaitingChildId: "child-api-read-failure",
			childIds: ["child-api-read-failure"],
			ts: 1,
			task: "Parent",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const taskHistoryStore = makeTaskHistoryStoreStub(
			{ id: "child-api-read-failure", status: "active" },
			parentItem,
		)
		const removeClineFromStack = vi.fn()
		const createTaskWithHistoryItem = vi.fn()
		const log = vi.fn()
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			getCurrentTask: vi.fn(() => ({ taskId: "child-api-read-failure" })),
			removeClineFromStack,
			createTaskWithHistoryItem,
			taskHistoryStore,
			log,
		})

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockRejectedValue(new Error("API read failed"))

		await expect(
			ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
				parentTaskId: "parent-api-read-failure",
				childTaskId: "child-api-read-failure",
				completionResultSummary: "Done",
			}),
		).resolves.toBe(false)

		expect(saveTaskMessages).not.toHaveBeenCalled()
		expect(saveApiMessages).not.toHaveBeenCalled()
		expect(taskHistoryStore.atomicUpdatePair).not.toHaveBeenCalled()
		expect(removeClineFromStack).not.toHaveBeenCalled()
		expect(createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(log).toHaveBeenCalledWith(expect.stringContaining("API read failed"))
	})

	it("handles empty history gracefully when injecting synthetic messages", async () => {
		const parentItem = {
			id: "p5",
			status: "delegated",
			awaitingChildId: "c5",
			childIds: [],
			ts: 500,
			task: "P5",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const taskHistoryStore = makeTaskHistoryStoreStub({ id: "c5", status: "active" }, parentItem)
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => ({ taskId: "c5" })),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue({
				resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
				overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
				overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
			}),
			taskHistoryStore,
		} as any)

		// Mock read failures or empty returns
		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await expect(
			(ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
				parentTaskId: "p5",
				childTaskId: "c5",
				completionResultSummary: "Result",
			}),
		).resolves.toBe(true)

		// Verify saves still occurred with just the injected message
		expect(saveTaskMessages).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: [
					expect.objectContaining({
						type: "say",
						say: "subtask_result",
					}),
				],
			}),
		)

		expect(saveApiMessages).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: [
					expect.objectContaining({
						role: "user",
					}),
				],
			}),
		)
	})

	it("reopenParentFromDelegation aborts when parent is already active (stale-delegation guard)", async () => {
		const logSpy = vi.fn()
		const atomicUpdatePair = vi.fn()
		const saveTaskMessagesMock = vi.mocked(saveTaskMessages)
		const saveApiMessagesMock = vi.mocked(saveApiMessages)

		const makeProvider = (historyItem: object) =>
			makeProviderStub({
				contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
				getTaskWithId: vi.fn().mockResolvedValue({ historyItem }),
				emit: vi.fn(),
				log: logSpy,
				getCurrentTask: vi.fn(() => null),
				removeClineFromStack: vi.fn(),
				createTaskWithHistoryItem: vi.fn(),
				taskHistoryStore: { atomicUpdatePair, get: vi.fn() },
			} as any)

		const providerActive = makeProvider({
			id: "parent-guard",
			status: "active",
			awaitingChildId: undefined,
		})
		await expect(
			(ClineProvider.prototype as any).reopenParentFromDelegation.call(providerActive, {
				parentTaskId: "parent-guard",
				childTaskId: "child-guard",
				completionResultSummary: "should be ignored",
			}),
		).resolves.toBe(false)
		expect(saveTaskMessagesMock).not.toHaveBeenCalled()
		expect(saveApiMessagesMock).not.toHaveBeenCalled()
		expect(atomicUpdatePair).not.toHaveBeenCalled()
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[reopenParentFromDelegation] Aborting"))
	})

	it("reopenParentFromDelegation aborts when in-process cancellation failed closed", async () => {
		const logSpy = vi.fn()
		const atomicUpdatePair = vi.fn()
		const saveTaskMessagesMock = vi.mocked(saveTaskMessages)
		const saveApiMessagesMock = vi.mocked(saveApiMessages)
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({
				historyItem: {
					id: "parent-guard",
					status: "delegated",
					awaitingChildId: "child-guard",
				},
			}),
			emit: vi.fn(),
			log: logSpy,
			getCurrentTask: vi.fn(() => null),
			removeClineFromStack: vi.fn(),
			createTaskWithHistoryItem: vi.fn(),
			taskHistoryStore: { atomicUpdatePair, get: vi.fn() },
			cancelledDelegationChildIds: new Set(["child-guard"]),
		} as any)

		await expect(
			(ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
				parentTaskId: "parent-guard",
				childTaskId: "child-guard",
				completionResultSummary: "should be ignored",
			}),
		).resolves.toBe(false)

		expect(saveTaskMessagesMock).not.toHaveBeenCalled()
		expect(saveApiMessagesMock).not.toHaveBeenCalled()
		expect(atomicUpdatePair).not.toHaveBeenCalled()
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[reopenParentFromDelegation] Aborting"))
	})

	it("reopenParentFromDelegation aborts when parent awaits a different child (stale-delegation guard)", async () => {
		const logSpy = vi.fn()
		const atomicUpdatePair = vi.fn()
		const saveTaskMessagesMock = vi.mocked(saveTaskMessages)
		const saveApiMessagesMock = vi.mocked(saveApiMessages)

		const makeProvider = (historyItem: object) =>
			makeProviderStub({
				contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
				getTaskWithId: vi.fn().mockResolvedValue({ historyItem }),
				emit: vi.fn(),
				log: logSpy,
				getCurrentTask: vi.fn(() => null),
				removeClineFromStack: vi.fn(),
				createTaskWithHistoryItem: vi.fn(),
				taskHistoryStore: { atomicUpdatePair, get: vi.fn() },
			} as any)

		const providerWrongChild = makeProvider({
			id: "parent-guard",
			status: "delegated",
			awaitingChildId: "other-child",
		})
		await expect(
			(ClineProvider.prototype as any).reopenParentFromDelegation.call(providerWrongChild, {
				parentTaskId: "parent-guard",
				childTaskId: "child-guard",
				completionResultSummary: "should be ignored",
			}),
		).resolves.toBe(false)
		expect(saveTaskMessagesMock).not.toHaveBeenCalled()
		expect(saveApiMessagesMock).not.toHaveBeenCalled()
		expect(atomicUpdatePair).not.toHaveBeenCalled()
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[reopenParentFromDelegation] Aborting"))
	})

	it("aborts before reading histories when the refreshed parent awaits another child", async () => {
		const persistedParent = {
			id: "parent-refreshed-stale",
			status: "delegated",
			awaitingChildId: "child-original",
			ts: 1,
			task: "Parent",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const refreshedParent = { ...persistedParent, awaitingChildId: "child-replacement" }
		const atomicUpdatePair = vi.fn()
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: persistedParent }),
			getCurrentTask: vi.fn(() => undefined),
			removeClineFromStack: vi.fn(),
			createTaskWithHistoryItem: vi.fn(),
			taskHistoryStore: {
				get: vi.fn((id: string) => (id === persistedParent.id ? refreshedParent : undefined)),
				atomicUpdatePair,
				withTaskFileLock: vi.fn(async (_id: string, callback: (fileLock: JsonFileLock) => Promise<unknown>) =>
					callback(unlockedJsonFileLock()),
				),
			},
			log: vi.fn(),
		})

		await expect(
			ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
				parentTaskId: persistedParent.id,
				childTaskId: "child-original",
				completionResultSummary: "stale result",
			}),
		).resolves.toBe(false)

		expect(readTaskMessages).not.toHaveBeenCalled()
		expect(readApiMessages).not.toHaveBeenCalled()
		expect(atomicUpdatePair).not.toHaveBeenCalled()
	})

	it("aborts before reading histories when the refreshed parent is terminal", async () => {
		const parent = {
			id: "parent-refreshed-completed",
			status: "completed",
			awaitingChildId: "child-original",
			ts: 1,
			task: "Parent",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const log = vi.fn()
		const atomicUpdatePair = vi.fn()
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parent }),
			taskHistoryStore: {
				get: vi.fn((id: string) => (id === parent.id ? parent : undefined)),
				atomicUpdatePair,
				withTaskFileLock: vi.fn(async (_id: string, callback: (fileLock: JsonFileLock) => Promise<unknown>) =>
					callback(unlockedJsonFileLock()),
				),
			},
			log,
		})

		await expect(
			ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
				parentTaskId: parent.id,
				childTaskId: "child-original",
				completionResultSummary: "stale result",
			}),
		).resolves.toBe(false)

		expect(readTaskMessages).not.toHaveBeenCalled()
		expect(readApiMessages).not.toHaveBeenCalled()
		expect(atomicUpdatePair).not.toHaveBeenCalled()
		expect(log).toHaveBeenCalledWith(expect.stringContaining("status=completed, awaitingChildId=child-original"))
	})

	it("reopenParentFromDelegation aborts when another host re-delegates after the initial guard", async () => {
		const staleParent = {
			id: "parent-cross-host",
			status: "delegated",
			awaitingChildId: "child-old",
			delegatedToId: "child-old",
			childIds: ["child-old"],
			ts: 1,
			task: "Parent",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const diskRecords = new Map<string, HistoryItem>([
			[
				"parent-cross-host",
				{
					...staleParent,
					awaitingChildId: "child-new",
					delegatedToId: "child-new",
					childIds: ["child-old", "child-new"],
				} as HistoryItem,
			],
			[
				"child-old",
				{
					id: "child-old",
					status: "interrupted",
					parentTaskId: "parent-cross-host",
				} as HistoryItem,
			],
		])
		let diskGuardError: Error | undefined
		const atomicUpdatePair = vi.fn(
			async (
				firstId: string,
				secondId: string,
				firstUpdater: (item: HistoryItem) => HistoryItem,
				secondUpdater: (item: HistoryItem) => HistoryItem,
				options?: { firstDiskGuard?: (item: HistoryItem) => void },
			) => {
				const first = diskRecords.get(firstId)!
				const second = diskRecords.get(secondId)!
				try {
					options?.firstDiskGuard?.(first)
				} catch (error) {
					diskGuardError = error as Error
					throw error
				}
				firstUpdater(first)
				secondUpdater(second)
				return []
			},
		)
		const createTaskWithHistoryItem = vi.fn()
		const removeClineFromStack = vi.fn()
		const log = vi.fn()
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: staleParent }),
			emit: vi.fn(),
			log,
			getCurrentTask: vi.fn(() => ({ taskId: "child-old" })),
			removeClineFromStack,
			createTaskWithHistoryItem,
			taskHistoryStore: {
				atomicUpdatePair,
				get: vi.fn((id: string) => (id === "parent-cross-host" ? staleParent : diskRecords.get(id))),
			},
		})

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await expect(
			ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
				parentTaskId: "parent-cross-host",
				childTaskId: "child-old",
				completionResultSummary: "stale result",
			}),
		).resolves.toBe(false)

		expect(createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(removeClineFromStack).not.toHaveBeenCalled()
		expect(saveTaskMessages).not.toHaveBeenCalled()
		expect(saveApiMessages).not.toHaveBeenCalled()
		expect(log).toHaveBeenCalledWith(expect.stringContaining("is no longer delegated to child child-old"))
		expect(diskGuardError?.message).toBe("stale cross-instance delegation")
	})

	it("treats a status change inside the atomic parent updater as a stale delegation", async () => {
		const parentItem = {
			id: "parent-atomic-status-change",
			status: "delegated",
			awaitingChildId: "child-atomic-status-change",
			ts: 1,
			task: "Parent",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const childItem = { id: "child-atomic-status-change", status: "active" }
		const atomicUpdatePair = vi.fn(
			async (
				_firstId: string,
				_secondId: string,
				firstUpdater: (item: HistoryItem) => HistoryItem,
				_secondUpdater: (item: HistoryItem) => HistoryItem,
				options?: { firstDiskGuard?: (item: HistoryItem) => void },
			) => {
				options?.firstDiskGuard?.(parentItem as HistoryItem)
				firstUpdater({ ...parentItem, status: "completed" } as HistoryItem)
				return []
			},
		)
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			getCurrentTask: vi.fn(() => undefined),
			removeClineFromStack: vi.fn(),
			createTaskWithHistoryItem: vi.fn(),
			taskHistoryStore: {
				get: vi.fn((id: string) => (id === parentItem.id ? parentItem : childItem)),
				atomicUpdatePair,
				withTaskFileLock: vi.fn(async (_id: string, callback: (fileLock: JsonFileLock) => Promise<unknown>) =>
					callback(unlockedJsonFileLock()),
				),
			},
			log: vi.fn(),
		})
		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await expect(
			ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
				parentTaskId: parentItem.id,
				childTaskId: childItem.id,
				completionResultSummary: "stale result",
			}),
		).resolves.toBe(false)

		expect(saveTaskMessages).not.toHaveBeenCalled()
		expect(saveApiMessages).not.toHaveBeenCalled()
		expect(provider.log).toHaveBeenCalledWith(
			expect.stringContaining(`parent ${parentItem.id} is no longer delegated to child ${childItem.id}`),
		)
	})

	it("restores the child after parent rehydration fails and allows completion to retry", async () => {
		const parentItem = {
			id: "parent-rehydrate-failure",
			status: "delegated",
			awaitingChildId: "child-rehydrate-failure",
			delegatedToId: "child-rehydrate-failure",
			childIds: ["child-rehydrate-failure"],
			ts: 1,
			task: "Parent",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const childItem = {
			id: "child-rehydrate-failure",
			status: "active",
			parentTaskId: "parent-rehydrate-failure",
			ts: 2,
			task: "Child",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		let lockHeld = false
		let currentTask: object | undefined = { taskId: childItem.id }
		const withTaskFileLock = vi.fn(async (_id: string, callback: (fileLock: JsonFileLock) => Promise<unknown>) => {
			lockHeld = true
			try {
				return await callback(unlockedJsonFileLock())
			} finally {
				lockHeld = false
			}
		})
		const atomicUpdatePair = vi.fn(
			async (
				_firstId: string,
				_secondId: string,
				firstUpdater: (item: HistoryItem) => HistoryItem,
				secondUpdater: (item: HistoryItem) => HistoryItem,
				options?: {
					whileFirstFileLocked?: () => Promise<void>
					rollbackBothOnCallbackFailure?: boolean
					firstFileLock?: JsonFileLock
					storeLockAcquired?: boolean
				},
			) => {
				expect(lockHeld).toBe(true)
				const parentSnapshot = structuredClone(parentItem)
				const childSnapshot = structuredClone(childItem)
				Object.assign(parentItem, firstUpdater(parentItem as HistoryItem))
				Object.assign(childItem, secondUpdater(childItem as HistoryItem))
				try {
					await options?.whileFirstFileLocked?.()
				} catch (error) {
					expect(options?.rollbackBothOnCallbackFailure).toBe(true)
					for (const key of Object.keys(parentItem)) delete (parentItem as Record<string, unknown>)[key]
					for (const key of Object.keys(childItem)) delete (childItem as Record<string, unknown>)[key]
					Object.assign(parentItem, parentSnapshot)
					Object.assign(childItem, childSnapshot)
					throw error
				}
				return []
			},
		)
		const removeLockStates: boolean[] = []
		const removeClineFromStack = vi.fn(async () => {
			removeLockStates.push(lockHeld)
			currentTask = undefined
		})
		let parentCreateAttempts = 0
		const createCalls: Array<{ historyItem: HistoryItem; lockHeld: boolean; startTask: boolean | undefined }> = []
		const resumedParent = {
			taskId: parentItem.id,
			overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
			overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
			resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
		}
		const createTaskWithHistoryItem = vi.fn(async (historyItem: HistoryItem, options?: { startTask?: boolean }) => {
			createCalls.push({ historyItem: structuredClone(historyItem), lockHeld, startTask: options?.startTask })
			currentTask = historyItem.id === parentItem.id ? resumedParent : { taskId: childItem.id }
			if (historyItem.id === parentItem.id && parentCreateAttempts++ === 0) {
				throw new Error("parent rehydration failed")
			}
			return historyItem.id === parentItem.id
				? resumedParent
				: {
						taskId: childItem.id,
						resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
					}
		})
		const taskHistoryStore = {
			atomicUpdatePair,
			get: vi.fn((id: string) =>
				id === parentItem.id ? parentItem : id === childItem.id ? childItem : undefined,
			),
			withTaskFileLock,
		}
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockImplementation(async () => ({ historyItem: structuredClone(parentItem) })),
			getCurrentTask: vi.fn(() => currentTask),
			removeClineFromStack,
			createTaskWithHistoryItem,
			taskHistoryStore,
		})

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		const completion = {
			parentTaskId: parentItem.id,
			childTaskId: childItem.id,
			completionResultSummary: "Done",
		}
		await expect(ClineProvider.prototype.reopenParentFromDelegation.call(provider, completion)).rejects.toThrow(
			"parent rehydration failed",
		)

		expect(parentItem).toMatchObject({
			status: "delegated",
			awaitingChildId: childItem.id,
			delegatedToId: childItem.id,
		})
		expect(childItem.status).toBe("active")
		expect(currentTask).toMatchObject({ taskId: childItem.id })
		expect(createCalls[1]).toEqual({ historyItem: childItem, lockHeld: false, startTask: false })
		expect(removeLockStates).toEqual([true, false])
		expect(removeClineFromStack).toHaveBeenNthCalledWith(1, { saveMessages: false })
		expect(removeClineFromStack).toHaveBeenNthCalledWith(2, { saveMessages: false })
		expect(saveTaskMessages).toHaveBeenLastCalledWith(expect.objectContaining({ messages: [] }))
		expect(saveApiMessages).toHaveBeenLastCalledWith(expect.objectContaining({ messages: [] }))

		await expect(ClineProvider.prototype.reopenParentFromDelegation.call(provider, completion)).resolves.toBe(true)
		expect(parentItem.status).toBe("active")
		expect(parentItem.awaitingChildId).toBeUndefined()
		expect(childItem.status).toBe("completed")
		await vi.waitFor(() => expect(resumedParent.resumeAfterDelegation).toHaveBeenCalledOnce())
		expect(withTaskFileLock).toHaveBeenCalledTimes(2)
		expect(atomicUpdatePair).toHaveBeenCalledTimes(2)
	})

	it("aggregates the transition and child-restoration failures", async () => {
		const transitionError = new Error("parent rehydration failed")
		const restorationError = new Error("child restoration failed")
		const parentItem = {
			id: "parent-recovery-error",
			status: "delegated",
			awaitingChildId: "child-recovery-error",
			ts: 1,
			task: "Parent",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const childItem = {
			id: "child-recovery-error",
			status: "active",
			parentTaskId: parentItem.id,
			ts: 2,
			task: "Child",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		let currentTaskId: string | undefined = childItem.id
		const removeClineFromStack = vi.fn(async () => {
			currentTaskId = undefined
		})
		const createTaskWithHistoryItem = vi.fn(async (historyItem: HistoryItem) => {
			if (historyItem.id === parentItem.id) throw transitionError
			throw restorationError
		})
		const atomicUpdatePair = vi.fn(
			async (
				_firstId: string,
				_secondId: string,
				firstUpdater: (item: HistoryItem) => HistoryItem,
				secondUpdater: (item: HistoryItem) => HistoryItem,
				options?: { whileFirstFileLocked?: () => Promise<void> },
			) => {
				firstUpdater(parentItem as HistoryItem)
				secondUpdater(childItem as HistoryItem)
				await options?.whileFirstFileLocked?.()
				return []
			},
		)
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			getCurrentTask: vi.fn(() => (currentTaskId ? { taskId: currentTaskId } : undefined)),
			removeClineFromStack,
			createTaskWithHistoryItem,
			taskHistoryStore: {
				get: vi.fn((id: string) => (id === parentItem.id ? parentItem : childItem)),
				atomicUpdatePair,
				withTaskFileLock: vi.fn(async (_id: string, callback: (fileLock: JsonFileLock) => Promise<unknown>) =>
					callback(unlockedJsonFileLock()),
				),
			},
		})
		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await expect(
			ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
				parentTaskId: parentItem.id,
				childTaskId: childItem.id,
				completionResultSummary: "Done",
			}),
		).rejects.toMatchObject({
			name: "AggregateError",
			message: `Failed to restore child ${childItem.id}`,
			errors: [transitionError, restorationError],
		})
		expect(removeClineFromStack).toHaveBeenCalledOnce()
		expect(createTaskWithHistoryItem).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: parentItem.id }), {
			startTask: false,
		})
		expect(createTaskWithHistoryItem).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: childItem.id }), {
			startTask: false,
		})
	})

	it("leaves an unrelated current task untouched when parent recovery fails", async () => {
		const transitionError = new Error("parent rehydration failed")
		const parentItem = {
			id: "parent-unrelated-recovery",
			status: "delegated",
			awaitingChildId: "child-unrelated-recovery",
			ts: 1,
			task: "Parent",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const childItem = { id: "child-unrelated-recovery", status: "active" }
		let currentTaskId = childItem.id
		const removeClineFromStack = vi.fn(async () => {
			currentTaskId = "unrelated-task"
		})
		const createTaskWithHistoryItem = vi.fn(async () => {
			currentTaskId = "unrelated-task"
			throw transitionError
		})
		const atomicUpdatePair = vi.fn(
			async (
				_firstId: string,
				_secondId: string,
				firstUpdater: (item: HistoryItem) => HistoryItem,
				secondUpdater: (item: HistoryItem) => HistoryItem,
				options?: { whileFirstFileLocked?: () => Promise<void> },
			) => {
				firstUpdater(parentItem as HistoryItem)
				secondUpdater(childItem as HistoryItem)
				await options?.whileFirstFileLocked?.()
				return []
			},
		)
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			getCurrentTask: vi.fn(() => ({ taskId: currentTaskId })),
			removeClineFromStack,
			createTaskWithHistoryItem,
			taskHistoryStore: {
				get: vi.fn((id: string) => (id === parentItem.id ? parentItem : childItem)),
				atomicUpdatePair,
				withTaskFileLock: vi.fn(async (_id: string, callback: (fileLock: JsonFileLock) => Promise<unknown>) =>
					callback(unlockedJsonFileLock()),
				),
			},
		})
		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await expect(
			ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
				parentTaskId: parentItem.id,
				childTaskId: childItem.id,
				completionResultSummary: "Done",
			}),
		).rejects.toThrow(transitionError)

		expect(currentTaskId).toBe("unrelated-task")
		expect(removeClineFromStack).toHaveBeenCalledOnce()
		expect(createTaskWithHistoryItem).toHaveBeenCalledOnce()
	})

	it("serializes delegation transitions and continues after a rejected predecessor", async () => {
		const provider = makeProviderStub({} as any) as any
		const calls: string[] = []
		let rejectFirst!: (error: Error) => void

		const first = provider.runDelegationTransition("parent-lock", async () => {
			calls.push("first")
			await new Promise<void>((_resolve, reject) => {
				rejectFirst = reject
			})
		})
		const second = provider.runDelegationTransition("parent-lock", async () => {
			calls.push("second")
			return "done"
		})

		await Promise.resolve()
		expect(calls).toEqual(["first"])

		rejectFirst(new Error("first transition failed"))
		await expect(first).rejects.toThrow("first transition failed")
		await expect(second).resolves.toBe("done")
		expect(calls).toEqual(["first", "second"])
	})

	it("reopenParentFromDelegation posts taskHistoryItemUpdated for both records when view is launched", async () => {
		const childItem = { id: "c-webview", status: "active" }
		const parentItem = {
			id: "p-webview",
			number: 1,
			status: "delegated",
			awaitingChildId: "c-webview",
			childIds: [],
			ts: 100,
			task: "Parent webview",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		} satisfies HistoryItem

		// After atomicUpdatePair resolves, get() returns the merged committed items.
		const updatedChild = { ...childItem, status: "completed" }
		const updatedParent = {
			...parentItem,
			status: "active",
			awaitingChildId: undefined,
			completedByChildId: "c-webview",
		}
		let committed = false
		const taskHistoryStore = {
			atomicUpdatePair: vi.fn(
				async (
					_fId: string,
					_sId: string,
					fU: (h: HistoryItem) => HistoryItem,
					sU: (h: HistoryItem) => HistoryItem,
					options?: { whileFirstFileLocked?: () => Promise<void> },
				) => {
					fU(parentItem)
					sU(childItem as HistoryItem)
					await options?.whileFirstFileLocked?.()
					committed = true
					return []
				},
			),
			get: vi.fn((id: string) => {
				if (id === "p-webview") return committed ? updatedParent : parentItem
				if (id === "c-webview") return committed ? updatedChild : childItem
				return undefined
			}),
		}

		const postMessageToWebview = vi.fn().mockResolvedValue(undefined)

		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			emit: vi.fn(),
			isViewLaunched: true,
			getCurrentTask: vi.fn(() => ({ taskId: "c-webview" })),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue({
				resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
				overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
				overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
			}),
			taskHistoryStore,
			postMessageToWebview,
		} as any)

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await (ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
			parentTaskId: "p-webview",
			childTaskId: "c-webview",
			completionResultSummary: "Done",
		})

		// Must post taskHistoryItemUpdated for both the child (completed) and parent (active)
		const webviewCalls = postMessageToWebview.mock.calls.filter((c) => c[0]?.type === "taskHistoryItemUpdated")
		expect(webviewCalls).toHaveLength(2)

		const childMsg = webviewCalls.find((c) => c[0].taskHistoryItem.id === "c-webview")
		expect(childMsg?.[0].taskHistoryItem).toMatchObject({ id: "c-webview", status: "completed" })

		const parentMsg = webviewCalls.find((c) => c[0].taskHistoryItem.id === "p-webview")
		expect(parentMsg?.[0].taskHistoryItem).toMatchObject({ id: "p-webview", status: "active" })

		// Both must be sent after atomicUpdatePair (verified by call order)
		const atomicOrder = taskHistoryStore.atomicUpdatePair.mock.invocationCallOrder[0]
		for (const call of webviewCalls) {
			const msgOrder =
				postMessageToWebview.mock.invocationCallOrder[postMessageToWebview.mock.calls.indexOf(call)]
			expect(atomicOrder).toBeLessThan(msgOrder)
		}
	})

	it("reopenParentFromDelegation does NOT post taskHistoryItemUpdated when view is not launched", async () => {
		const childItem = { id: "c-noview", status: "active" }
		const parentItem = {
			id: "p-noview",
			status: "delegated",
			awaitingChildId: "c-noview",
			childIds: [],
			ts: 100,
			task: "Parent no-view",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const taskHistoryStore = makeTaskHistoryStoreStub(childItem, parentItem)
		const postMessageToWebview = vi.fn().mockResolvedValue(undefined)

		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			emit: vi.fn(),
			isViewLaunched: false,
			getCurrentTask: vi.fn(() => ({ taskId: "c-noview" })),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue({
				resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
				overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
				overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
			}),
			taskHistoryStore,
			postMessageToWebview,
		} as any)

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await (ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
			parentTaskId: "p-noview",
			childTaskId: "c-noview",
			completionResultSummary: "Done",
		})

		const webviewCalls = postMessageToWebview.mock.calls.filter((c) => c[0]?.type === "taskHistoryItemUpdated")
		expect(webviewCalls).toHaveLength(0)
	})

	describe("atomicUpdatePair handoff correctness", () => {
		it("after reopenParentFromDelegation, child is completed and parent is active atomically", async () => {
			const parentItem = {
				id: "p-handoff",
				status: "delegated",
				awaitingChildId: "c-handoff",
				childIds: [],
				ts: 100,
				task: "Parent",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			}
			const childItem = { id: "c-handoff", status: "active" }

			let capturedChildResult: HistoryItem | undefined
			let capturedParentResult: HistoryItem | undefined

			const atomicUpdatePair = vi.fn(
				async (
					firstId: string,
					secondId: string,
					firstUpdater: (h: HistoryItem) => HistoryItem,
					secondUpdater: (h: HistoryItem) => HistoryItem,
				) => {
					// Both updaters must be applied atomically
					capturedParentResult = firstUpdater(parentItem as unknown as HistoryItem)
					capturedChildResult = secondUpdater(childItem as unknown as HistoryItem)
					return []
				},
			)
			const taskHistoryStore = {
				atomicUpdatePair,
				get: vi.fn((id: string) => (id === parentItem.id ? parentItem : childItem)),
			}

			const provider = makeProviderStub({
				contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
				getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
				emit: vi.fn(),
				getCurrentTask: vi.fn(() => ({ taskId: "c-handoff" })),
				removeClineFromStack: vi.fn().mockResolvedValue(undefined),
				createTaskWithHistoryItem: vi.fn().mockResolvedValue({
					resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
				}),
				taskHistoryStore,
			} as any)

			vi.mocked(readTaskMessages).mockResolvedValue([])
			vi.mocked(readApiMessages).mockResolvedValue([])

			await (ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
				parentTaskId: "p-handoff",
				childTaskId: "c-handoff",
				completionResultSummary: "Done",
			})

			// After atomicUpdatePair: child completed AND parent active — never one without the other
			expect(capturedChildResult?.status).toBe("completed")
			expect(capturedParentResult?.status).toBe("active")
			expect(capturedParentResult?.awaitingChildId).toBeUndefined()
			expect(capturedParentResult?.completedByChildId).toBe("c-handoff")
		})
	})

	describe("Issue #566 — manual stop/resume of a delegated subtask", () => {
		it("reopens the parent after a subtask is cancelled mid-stream, resumed, and completes (interrupted → attempt_completion)", async () => {
			// Step 1: simulate cancelTask()'s persisted transition — child "active" → "interrupted",
			// parent stays "delegated" with awaitingChildId intact (ClineProvider.ts cancelTaskInternal).
			const childItem: Record<string, any> = {
				id: "child-566",
				status: "interrupted",
				parentTaskId: "parent-566",
				ts: 1,
				task: "Child task",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				mode: "code",
				workspace: "/tmp",
			}
			const parentItem: Record<string, any> = {
				id: "parent-566",
				status: "delegated",
				delegatedToId: "child-566",
				awaitingChildId: "child-566",
				childIds: ["child-566"],
				ts: 0,
				task: "Parent task",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				mode: "code",
				workspace: "/tmp",
			}

			// Step 2: user clicks "Resume" — the extension rehydrates the child from its persisted
			// history item (createTaskWithHistoryItem passes historyItem.status through as
			// initialStatus), so the resumed task instance still reports "interrupted".
			let currentActiveId: string | undefined = "child-566"
			let currentTask:
				| {
						taskId: string
						resumeAfterDelegation?: ReturnType<typeof vi.fn>
						overwriteClineMessages?: ReturnType<typeof vi.fn>
						overwriteApiConversationHistory?: ReturnType<typeof vi.fn>
				  }
				| undefined = {
				taskId: "child-566",
			}
			const emitSpy = vi.fn()
			const removeClineFromStack = vi.fn().mockImplementation(async () => {
				currentActiveId = undefined
				currentTask = undefined
			})
			const createTaskWithHistoryItem = vi.fn().mockImplementation(async (historyItem: any) => {
				currentActiveId = historyItem.id
				currentTask = {
					taskId: historyItem.id,
					resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
					overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
					overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
				}
				return currentTask
			})
			const getTaskWithId = vi.fn(async (id: string) => {
				const item = id === "child-566" ? childItem : id === "parent-566" ? parentItem : undefined
				if (!item) throw new Error("Task not found")
				return { historyItem: item }
			})
			const taskHistoryStore = {
				atomicUpdatePair: vi.fn(
					async (
						firstId: string,
						secondId: string,
						firstUpdater: (h: any) => any,
						secondUpdater: (h: any) => any,
						options?: { whileFirstFileLocked?: () => Promise<void> },
					) => {
						Object.assign(parentItem, firstUpdater(parentItem))
						Object.assign(childItem, secondUpdater(childItem))
						await options?.whileFirstFileLocked?.()
						return []
					},
				),
				get: vi.fn((id: string) =>
					id === "child-566" ? childItem : id === "parent-566" ? parentItem : undefined,
				),
			}

			const provider = makeProviderStub({
				contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
				getTaskWithId,
				emit: emitSpy,
				getCurrentTask: vi.fn(() => currentTask as unknown as Task | undefined),
				removeClineFromStack,
				createTaskWithHistoryItem,
				taskHistoryStore,
				reopenParentFromDelegation: vi.fn(async (params: any) => {
					// Intentional self-reference: the provider variable is initialized before this stub is invoked.
					return await (ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, params)
				}),
			} as unknown as ClineProvider)

			vi.mocked(readTaskMessages).mockResolvedValue([])
			vi.mocked(readApiMessages).mockResolvedValue([])

			// Step 3: the resumed subtask finishes its work and calls attempt_completion.
			const { attemptCompletionTool } = await import("../core/tools/AttemptCompletionTool")
			const resumedChildTask = {
				taskId: "child-566",
				parentTask: undefined, // live parent reference is gone after resume; only parentTaskId survives
				parentTaskId: "parent-566",
				historyItem: { parentTaskId: "parent-566" },
				providerRef: { deref: () => provider },
				ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: "", images: [] }),
				say: vi.fn().mockResolvedValue(undefined),
				emit: vi.fn(),
				getTokenUsage: vi.fn(() => ({})),
				toolUsage: {},
				clineMessages: [],
				userMessageContent: [],
				consecutiveMistakeCount: 0,
				emitFinalTokenUsageUpdate: vi.fn(),
				flushTelemetryInstallment: vi.fn(),
				waitForCurrentAssistantMessagePersistence: vi.fn().mockResolvedValue(true),
			} as unknown as import("../core/task/Task").Task

			const block = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Child finished after resume" },
				nativeArgs: { result: "Child finished after resume" },
				partial: false,
			} as any

			await attemptCompletionTool.handle(resumedChildTask, block, {
				askApproval: vi.fn(),
				handleError: vi.fn(async (_action: string, err: Error) => {
					throw err
				}),
				pushToolResult: vi.fn(),
				askFinishSubTaskApproval: vi.fn(async () => true),
				toolDescription: () => "desc",
			} as any)
			await vi.waitFor(() => expect(currentTask?.resumeAfterDelegation).toHaveBeenCalledTimes(1))

			// The parent must regain control — this is the exact behavior issue #566 reported as broken.
			expect(currentActiveId).toBe("parent-566")
			expect(childItem.status).toBe("completed")
			expect(parentItem.status).toBe("active")
			expect(parentItem.awaitingChildId).toBeUndefined()

			const eventNames = emitSpy.mock.calls.map((c: any[]) => c[0])
			expect(eventNames).toContain(RooCodeEventName.TaskDelegationCompleted)
			expect(eventNames).toContain(RooCodeEventName.TaskDelegationResumed)
		})
	})
})
