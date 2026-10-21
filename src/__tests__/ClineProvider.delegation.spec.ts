// npx vitest run __tests__/provider-delegation.spec.ts

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { describe, it, expect, vi } from "vitest"
import type { HistoryItem } from "@roo-code/types"
import { providerIdentifiers, RooCodeEventName } from "@roo-code/types"
import { ClineProvider } from "../core/webview/ClineProvider"
import { TaskScheduler } from "../core/task/TaskScheduler"
import { LifecycleTransitionError, TaskHistoryStore, type HistoryItemStatus } from "../core/task-persistence"
import { abandonDelegatedChild } from "../core/task-persistence/taskLifecycle"
import { makeProviderStub } from "./helpers/provider-stub"

const parentHistoryItem: HistoryItem = {
	id: "parent-1",
	task: "Parent",
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	childIds: [],
} as unknown as HistoryItem

/** Minimal taskHistoryStore stub whose atomicUpdateParentDelegation builds from the parent item. */
function makeStoreStub(
	overrides: Partial<{
		atomicUpdateParentDelegation: ReturnType<typeof vi.fn>
		get: ReturnType<typeof vi.fn>
	}> = {},
) {
	return {
		invalidate: vi.fn().mockResolvedValue(undefined),
		atomicUpdateParentDelegation: vi.fn(
			async (
				_taskId: string,
				build: (diskParent: HistoryItem, awaitedChildDiskStatus: HistoryItemStatus | undefined) => HistoryItem,
			) => build(parentHistoryItem, undefined),
		),
		get: vi.fn().mockReturnValue(undefined),
		...overrides,
	}
}

/**
 * Parent task double with the methods delegateParentAndOpenChild reads from
 * `parent`. Without flushPendingToolResultsToHistory the method hits its
 * non-fatal flush-error branch and never reaches the happy delegation path.
 */
const makeParentTask = () =>
	({
		taskId: "parent-1",
		apiConfiguration: { apiProvider: providerIdentifiers.anthropic, anthropicApiKey: "task-local-key" },
		getTaskMode: vi.fn().mockResolvedValue("code"),
		getTaskApiConfigName: vi.fn().mockResolvedValue("task-local-profile"),
		emit: vi.fn(),
		flushPendingToolResultsToHistory: vi.fn().mockResolvedValue(true),
		retrySaveApiConversationHistory: vi.fn(),
	}) as any

describe("ClineProvider.resumeInterruptedTask()", () => {
	it("resumes a delegated child only while its parent still awaits it", async () => {
		const resumed = { id: "child-1", status: "active" } as HistoryItem
		const taskHistoryStore = {
			invalidate: vi.fn().mockResolvedValue(undefined),
			get: vi.fn().mockReturnValue({ id: "parent-1", status: "delegated", awaitingChildId: "child-1" }),
			resumeInterruptedTask: vi.fn().mockResolvedValue(resumed),
		}
		const provider = makeProviderStub({ taskHistoryStore, isViewLaunched: false })

		await ClineProvider.prototype.resumeInterruptedTask.call(provider, "child-1", "parent-1")

		expect(taskHistoryStore.invalidate).toHaveBeenCalledWith("parent-1")
		expect(taskHistoryStore.resumeInterruptedTask).toHaveBeenCalledWith("child-1", "parent-1")
	})

	it("reinterruptAbandonedChild delegates to markDelegatedChildInterrupted", async () => {
		const markDelegatedChildInterrupted = vi.fn().mockResolvedValue(undefined)
		const log = vi.fn()
		const provider = makeProviderStub({ markDelegatedChildInterrupted, log })

		await ClineProvider.prototype.reinterruptAbandonedChild.call(provider, {
			childTaskId: "child-1",
			parentTaskId: "parent-1",
		})

		expect(markDelegatedChildInterrupted).toHaveBeenCalledWith({
			childTaskId: "child-1",
			parentTaskId: "parent-1",
		})
	})

	it("rejects abandonment committed by another host after the parent precheck", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "resume-abandon-"))
		const storeA = new TaskHistoryStore(storagePath)
		const storeB = new TaskHistoryStore(storagePath)
		const parent: HistoryItem = {
			id: "parent",
			number: 1,
			ts: 1,
			task: "Parent",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			status: "delegated",
			awaitingChildId: "child",
			delegatedToId: "child",
			childIds: ["child"],
		}
		const child: HistoryItem = {
			...parent,
			id: "child",
			status: "interrupted",
			parentTaskId: "parent",
			rootTaskId: "parent",
			awaitingChildId: undefined,
			delegatedToId: undefined,
			childIds: [],
		}
		try {
			await storeA.initialize()
			await storeA.upsert(parent)
			await storeA.upsert(child)
			await storeB.initialize()
			const resume = storeA.resumeInterruptedTask.bind(storeA)
			vi.spyOn(storeA, "resumeInterruptedTask").mockImplementationOnce(async (id, expectedParent) => {
				// This hook runs after the provider's cache refresh but before the
				// store's locked ownership check. Commit only the first half of
				// abandonment: the parent still appears to await this child.
				await storeB.atomicReadAndUpdate("child", (current) => abandonDelegatedChild(parent, current).child)
				return resume(id, expectedParent)
			})
			const provider = makeProviderStub({ taskHistoryStore: storeA, isViewLaunched: false })
			await expect(
				ClineProvider.prototype.resumeInterruptedTask.call(provider, "child", "parent"),
			).rejects.toThrow("parent linkage changed")
			await storeB.invalidate("child")
			expect(storeA.get("child")).toEqual(storeB.get("child"))
			expect(storeB.get("child")).toMatchObject({ status: "interrupted" })
			expect(storeB.get("child")?.parentTaskId).toBeUndefined()
			expect(storeB.get("child")?.rootTaskId).toBeUndefined()
		} finally {
			storeA.dispose()
			storeB.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("rejects a stale interrupted child after its parent delegates elsewhere", async () => {
		// The provider does not gate on an unlocked cache read. The store's
		// parent-file-locked check rejects the stale child, so this flow uses
		// a real store with a stale parent on disk.
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "resume-stale-"))
		const store = new TaskHistoryStore(storagePath)
		const parent: HistoryItem = {
			id: "parent",
			number: 1,
			ts: 1,
			task: "Parent",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			status: "delegated",
			awaitingChildId: "child-2",
			delegatedToId: "child-2",
			childIds: ["child", "child-2"],
		}
		const child: HistoryItem = {
			...parent,
			id: "child",
			status: "interrupted",
			parentTaskId: "parent",
			rootTaskId: "parent",
			awaitingChildId: undefined,
			delegatedToId: undefined,
			childIds: [],
		}
		try {
			await store.initialize()
			await store.upsert(parent)
			await store.upsert(child)
			const provider = makeProviderStub({ taskHistoryStore: store, isViewLaunched: false })

			await expect(
				ClineProvider.prototype.resumeInterruptedTask.call(provider, "child", "parent"),
			).rejects.toThrow("parent parent no longer awaits it")

			// The stale child record stays untouched for recovery or abandonment.
			expect(store.get("child")).toMatchObject({ status: "interrupted", parentTaskId: "parent" })
		} finally {
			store.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("delegates a resumed interrupted child to a grandchild through the real provider flow", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "resume-then-grandchild-"))
		const store = new TaskHistoryStore(storagePath)
		const parent: HistoryItem = {
			id: "parent",
			number: 1,
			ts: 1,
			task: "Parent",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			status: "delegated",
			awaitingChildId: "child",
			delegatedToId: "child",
			childIds: ["child"],
		}
		const child: HistoryItem = {
			...parent,
			id: "child",
			task: "Child",
			status: "interrupted",
			parentTaskId: "parent",
			rootTaskId: "parent",
			awaitingChildId: undefined,
			delegatedToId: undefined,
			childIds: [],
		}

		try {
			await store.initialize()
			await store.upsert(parent)
			await store.upsert(child)

			// Accepted resume: the child record activates while the parent stays delegated.
			const resumeProvider = makeProviderStub({ taskHistoryStore: store, isViewLaunched: false })
			await ClineProvider.prototype.resumeInterruptedTask.call(resumeProvider, "child", "parent")
			expect(store.get("child")?.status).toBe("active")
			expect(store.get("parent")).toMatchObject({ status: "delegated", awaitingChildId: "child" })

			// The resumed child runs the real delegation flow and spawns a grandchild.
			const resumedChildTask = {
				taskId: "child",
				apiConfiguration: { apiProvider: providerIdentifiers.anthropic, anthropicApiKey: "task-local-key" },
				getTaskMode: vi.fn().mockResolvedValue("code"),
				getTaskApiConfigName: vi.fn().mockResolvedValue("task-local-profile"),
				emit: vi.fn(),
				flushPendingToolResultsToHistory: vi.fn().mockResolvedValue(true),
				retrySaveApiConversationHistory: vi.fn(),
			}
			const grandchildRun = vi.fn().mockResolvedValue(undefined)
			const grandchild = { taskId: "grandchild", run: grandchildRun }
			const createTask = vi.fn().mockResolvedValue(grandchild)
			const provider = makeProviderStub({
				taskHistoryStore: store,
				isViewLaunched: false,
				tasks: [],
			})
			const providerFields = provider as unknown as Record<string, unknown>
			providerFields.getCurrentTask = vi.fn(() => resumedChildTask)
			providerFields.removeClineFromStack = vi.fn().mockResolvedValue(undefined)
			providerFields.createTask = createTask
			providerFields.taskScheduler = new TaskScheduler()
			providerFields.emit = vi.fn()
			providerFields.log = vi.fn()
			providerFields.recentTasksCache = undefined

			const openedChild = await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
				parentTaskId: "child",
				message: "Grandchild work",
				initialTodos: [],
				mode: "code",
			})
			await Promise.resolve() // drain scheduler microtask so grandchild.run() is invoked

			expect(openedChild.taskId).toBe("grandchild")
			expect(createTask).toHaveBeenCalledWith(
				"Grandchild work",
				undefined,
				resumedChildTask,
				expect.objectContaining({ initialStatus: "active", startTask: false }),
			)
			await store.invalidate("child")
			await store.invalidate("parent")
			expect(store.get("child")).toMatchObject({
				status: "delegated",
				awaitingChildId: "grandchild",
				delegatedToId: "grandchild",
			})
			expect(store.get("child")?.childIds).toContain("grandchild")
			// The top parent record is untouched by the nested delegation.
			expect(store.get("parent")).toMatchObject({ status: "delegated", awaitingChildId: "child" })
			expect(grandchildRun).toHaveBeenCalledTimes(1)
		} finally {
			store.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})
})

describe("ClineProvider.delegateParentAndOpenChild()", () => {
	it("rejects a stale restored action before delegation side effects", async () => {
		const parentTask = makeParentTask()
		const removeClineFromStack = vi.fn()
		const createTask = vi.fn()
		const handleModeSwitch = vi.fn()
		const taskHistoryStore = makeStoreStub({
			get: vi.fn().mockReturnValue({
				...parentHistoryItem,
				pendingAction: {
					kind: "create_subtask",
					actionId: "current-action",
					approvalText: "{}",
					mode: "code",
					message: "Do something",
					todos: [],
				},
			}),
		})
		const provider = {
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack,
			createTask,
			handleModeSwitch,
			taskHistoryStore,
		} as unknown as ClineProvider

		await expect(
			ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: "Do something",
				initialTodos: [],
				mode: "code",
				pendingActionId: "stale-action",
			}),
		).rejects.toThrow("Pending action mismatch")

		expect(parentTask.flushPendingToolResultsToHistory).not.toHaveBeenCalled()
		expect(removeClineFromStack).not.toHaveBeenCalled()
		expect(handleModeSwitch).not.toHaveBeenCalled()
		expect(createTask).not.toHaveBeenCalled()
		expect(taskHistoryStore.atomicUpdateParentDelegation).not.toHaveBeenCalled()
	})

	it("clears a matching pending action when delegation commits", async () => {
		const pendingAction = {
			kind: "create_subtask" as const,
			actionId: "create-action",
			approvalText: "{}",
			mode: "code",
			message: "Do something",
			todos: [],
		}
		let current: HistoryItem = { ...parentHistoryItem, status: "active", pendingAction }
		const taskHistoryStore = {
			invalidate: vi.fn().mockResolvedValue(undefined),
			get: vi.fn(() => current),
			atomicUpdateParentDelegation: vi.fn(
				async (
					_taskId: string,
					build: (
						diskParent: HistoryItem,
						awaitedChildDiskStatus: HistoryItemStatus | undefined,
					) => HistoryItem,
				) => {
					current = build(current, undefined)
					return current
				},
			),
		}
		const parentTask = makeParentTask()
		const child = { taskId: "child-1", run: vi.fn().mockResolvedValue(undefined) }
		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockResolvedValue(child),
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
			isViewLaunched: false,
			taskHistoryStore,
		} as unknown as ClineProvider

		await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
			pendingActionId: "create-action",
		})

		expect(current.pendingAction).toBeUndefined()
		expect(current).toMatchObject({ status: "delegated", awaitingChildId: "child-1" })
	})

	it("rolls back when pending-action ownership changes before the atomic parent update", async () => {
		const pendingAction = {
			kind: "create_subtask" as const,
			actionId: "create-action",
			approvalText: "{}",
			mode: "code",
			message: "Do something",
			todos: [],
		}
		const parentTask = makeParentTask()
		const child = { taskId: "child-1", run: vi.fn().mockResolvedValue(undefined) }
		const getCurrentTask = vi.fn(() => parentTask)
		const createTask = vi.fn(async () => {
			getCurrentTask.mockReturnValue(child)
			return child
		})
		const replacementAction = { ...pendingAction, actionId: "replacement-action" }
		const taskHistoryStore = makeStoreStub({
			get: vi.fn().mockReturnValue({ ...parentHistoryItem, status: "active", pendingAction }),
			atomicUpdateParentDelegation: vi.fn(
				async (
					_taskId: string,
					build: (
						diskParent: HistoryItem,
						awaitedChildDiskStatus: HistoryItemStatus | undefined,
					) => HistoryItem,
				) => {
					build({ ...parentHistoryItem, status: "active", pendingAction: replacementAction }, undefined)
					return { ...parentHistoryItem, status: "active", pendingAction: replacementAction }
				},
			),
		})
		const deleteTaskWithId = vi.fn().mockResolvedValue(undefined)
		const createTaskWithHistoryItem = vi.fn().mockResolvedValue(undefined)
		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask,
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			deleteTaskWithId,
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentHistoryItem }),
			createTaskWithHistoryItem,
			log: vi.fn(),
			isViewLaunched: false,
			taskHistoryStore,
		} as unknown as ClineProvider

		await expect(
			ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: "Do something",
				initialTodos: [],
				mode: "code",
				pendingActionId: "create-action",
			}),
		).rejects.toThrow("Pending action mismatch for parent parent-1")

		expect(child.run).not.toHaveBeenCalled()
		expect(deleteTaskWithId).toHaveBeenCalledWith("child-1", false)
		expect(createTaskWithHistoryItem).toHaveBeenCalledWith(parentHistoryItem)
	})

	it("persists parent delegation metadata via atomicUpdateParentDelegation and emits TaskDelegated", async () => {
		const providerEmit = vi.fn()
		const parentTask = makeParentTask()

		const childRun = vi.fn().mockResolvedValue(undefined)
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const createTask = vi.fn().mockResolvedValue({ taskId: "child-1", start: vi.fn(), run: childRun })
		const handleModeSwitch = vi.fn().mockResolvedValue(undefined)
		const taskHistoryStore = makeStoreStub()

		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: providerEmit,
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack,
			createTask,
			handleModeSwitch,
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		} as unknown as ClineProvider

		const child = await (ClineProvider.prototype as any).delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})
		await Promise.resolve() // drain scheduler microtask so child.run() is invoked

		expect(child.taskId).toBe("child-1")

		// Invariant: parent closed before child creation
		expect(removeClineFromStack).toHaveBeenCalledTimes(1)

		// Child task created with startTask: false and initialStatus: "active"
		expect(createTask).toHaveBeenCalledWith("Do something", undefined, parentTask, {
			handoffExecutionContext: {
				apiConfigName: "task-local-profile",
				apiConfiguration: {
					apiProvider: providerIdentifiers.anthropic,
					anthropicApiKey: "task-local-key",
				},
				mode: "code",
			},
			initialTodos: [],
			initialStatus: "active",
			startTask: false,
		})

		// Delegation metadata written via atomicUpdateParentDelegation with correct taskId
		expect(taskHistoryStore.atomicUpdateParentDelegation).toHaveBeenCalledTimes(1)
		const [calledTaskId, build] = taskHistoryStore.atomicUpdateParentDelegation.mock.calls[0]
		expect(calledTaskId).toBe("parent-1")

		// The builder must produce the correct delegation fields
		const result = build(parentHistoryItem, undefined)
		expect(result).toMatchObject({
			id: "parent-1",
			status: "delegated",
			delegatedToId: "child-1",
			awaitingChildId: "child-1",
			childIds: expect.arrayContaining(["child-1"]),
		})

		// child.run() called AFTER parent metadata is persisted (via taskScheduler)
		expect(childRun).toHaveBeenCalledTimes(1)

		// Provider-level event
		expect(providerEmit).toHaveBeenCalledWith(RooCodeEventName.TaskDelegated, "parent-1", "child-1")

		expect(handleModeSwitch).not.toHaveBeenCalled()
	})

	it("uses an explicitly saved different-mode profile without reading shared current identity", async () => {
		const parentTask = makeParentTask()
		const child = { taskId: "child-ask", run: vi.fn().mockResolvedValue(undefined) }
		const createTask = vi.fn().mockResolvedValue(child)
		const providerSettingsManager = {
			getModeConfigId: vi.fn().mockResolvedValue("ask-profile-id"),
			getProfile: vi.fn().mockResolvedValue({
				name: "ask-profile",
				id: "ask-profile-id",
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "openai/gpt-4.1-mini",
			}),
			getCurrentProfileName: vi.fn(),
		}
		const workspaceGet = vi.fn().mockReturnValue(false)
		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			log: vi.fn(),
			isViewLaunched: false,
			taskHistoryStore: makeStoreStub(),
			providerSettingsManager,
			context: { workspaceState: { get: workspaceGet } },
		} as unknown as ClineProvider

		await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Ask child",
			initialTodos: [],
			mode: "ask",
		})

		expect(providerSettingsManager.getModeConfigId).toHaveBeenCalledWith("ask")
		expect(workspaceGet).toHaveBeenCalledWith("lockApiConfigAcrossModes", false)
		expect(providerSettingsManager.getProfile).toHaveBeenCalledWith({ id: "ask-profile-id" })
		expect(providerSettingsManager.getCurrentProfileName).not.toHaveBeenCalled()
		expect(createTask).toHaveBeenCalledWith(
			"Ask child",
			undefined,
			parentTask,
			expect.objectContaining({
				handoffExecutionContext: {
					mode: "ask",
					apiConfigName: "ask-profile",
					apiConfiguration: {
						apiProvider: providerIdentifiers.openrouter,
						openRouterModelId: "openai/gpt-4.1-mini",
					},
				},
			}),
		)
	})

	it.each([
		{ name: "has no saved mode profile", savedConfigId: undefined, savedProfile: undefined },
		{
			name: "has an unconfigured saved mode profile",
			savedConfigId: "empty-id",
			savedProfile: { name: "empty", id: "empty-id" },
		},
		{
			name: "has a stale saved mode profile",
			savedConfigId: "stale-id",
			savedProfile: new Error("profile not found"),
		},
	])("keeps the parent task-local profile when a different mode $name", async ({ savedConfigId, savedProfile }) => {
		const parentTask = makeParentTask()
		const child = { taskId: "child-fallback", run: vi.fn().mockResolvedValue(undefined) }
		const createTask = vi.fn().mockResolvedValue(child)
		const getProfile =
			savedProfile instanceof Error
				? vi.fn().mockRejectedValue(savedProfile)
				: vi.fn().mockResolvedValue(savedProfile)
		const log = vi.fn()
		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			log,
			isViewLaunched: false,
			taskHistoryStore: makeStoreStub(),
			providerSettingsManager: {
				getModeConfigId: vi.fn().mockResolvedValue(savedConfigId),
				getProfile,
			},
			context: { workspaceState: { get: vi.fn().mockReturnValue(false) } },
		} as unknown as ClineProvider

		await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Fallback child",
			initialTodos: [],
			mode: "ask",
		})

		if (savedConfigId) expect(getProfile).toHaveBeenCalledWith({ id: savedConfigId })
		else expect(getProfile).not.toHaveBeenCalled()
		if (savedProfile instanceof Error) {
			expect(
				log.mock.calls.some(([message]) => message.includes("stale-id") && message.includes("parent parent-1")),
			).toBe(true)
		}
		expect(createTask).toHaveBeenCalledWith(
			"Fallback child",
			undefined,
			parentTask,
			expect.objectContaining({
				handoffExecutionContext: {
					mode: "ask",
					apiConfigName: "task-local-profile",
					apiConfiguration: {
						apiProvider: providerIdentifiers.anthropic,
						anthropicApiKey: "task-local-key",
					},
				},
			}),
		)
	})

	it("posts taskHistoryItemUpdated to the webview when isViewLaunched is true", async () => {
		const updatedParent = { ...parentHistoryItem, status: "delegated" } as HistoryItem
		const postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		const parentTask = makeParentTask()
		const taskHistoryStore = makeStoreStub({
			atomicUpdateParentDelegation: vi.fn().mockResolvedValue(updatedParent),
		})

		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockResolvedValue({ taskId: "child-1", start: vi.fn(), run: () => Promise.resolve() }),
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			postMessageToWebview,
			log: vi.fn(),
			isViewLaunched: true,
			recentTasksCache: undefined,
			taskHistoryStore,
		} as unknown as ClineProvider

		await (ClineProvider.prototype as any).delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})

		expect(postMessageToWebview).toHaveBeenCalledWith({
			type: "taskHistoryItemUpdated",
			taskHistoryItem: updatedParent,
		})
	})

	it("skips postMessageToWebview when isViewLaunched is true but the store returns undefined", async () => {
		const postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		const parentTask = makeParentTask()
		const taskHistoryStore = makeStoreStub({
			atomicUpdateParentDelegation: vi.fn().mockResolvedValue(undefined),
		})

		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockResolvedValue({ taskId: "child-1", start: vi.fn(), run: () => Promise.resolve() }),
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			postMessageToWebview,
			log: vi.fn(),
			isViewLaunched: true,
			recentTasksCache: undefined,
			taskHistoryStore,
		} as unknown as ClineProvider

		await (ClineProvider.prototype as any).delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})

		expect(postMessageToWebview).not.toHaveBeenCalled()
	})

	it("calls child.run() only after atomicUpdateParentDelegation completes (no race condition)", async () => {
		const callOrder: string[] = []

		const parentTask = makeParentTask()
		const childRun = vi.fn(async () => callOrder.push("child.run"))
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const createTask = vi.fn(async () => {
			callOrder.push("createTask")
			return { taskId: "child-1", start: vi.fn(), run: childRun }
		})
		const handleModeSwitch = vi.fn().mockResolvedValue(undefined)
		const taskHistoryStore = makeStoreStub({
			atomicUpdateParentDelegation: vi.fn(
				async (
					_taskId: string,
					_build: (
						diskParent: HistoryItem,
						awaitedChildDiskStatus: HistoryItemStatus | undefined,
					) => HistoryItem,
				) => {
					callOrder.push("atomicUpdateParentDelegation")
					return parentHistoryItem
				},
			),
		})

		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack,
			createTask,
			handleModeSwitch,
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		} as unknown as ClineProvider

		await (ClineProvider.prototype as any).delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})
		await Promise.resolve() // drain scheduler microtask so child.run() is invoked

		// createTask → atomicUpdateParentDelegation → child.run: scheduler admits child only after metadata is persisted
		expect(callOrder).toEqual(["createTask", "atomicUpdateParentDelegation", "child.run"])
	})

	it("implicitly severs interrupted awaited child and re-delegates when parent is already delegated", async () => {
		const oldChildId = "old-child"
		const oldChild = { id: oldChildId, status: "interrupted" } as unknown as HistoryItem
		const alreadyDelegatedParent: HistoryItem = {
			...parentHistoryItem,
			status: "delegated",
			awaitingChildId: oldChildId,
			delegatedToId: oldChildId,
			childIds: [oldChildId],
		} as unknown as HistoryItem

		const taskHistoryStore = makeStoreStub({
			// store returns: parent (delegated), old child (interrupted)
			get: vi.fn((id: string) =>
				id === "parent-1" ? alreadyDelegatedParent : id === oldChildId ? oldChild : undefined,
			),
			atomicUpdateParentDelegation: vi.fn(
				async (
					_taskId: string,
					build: (
						diskParent: HistoryItem,
						awaitedChildDiskStatus: HistoryItemStatus | undefined,
					) => HistoryItem,
				) => {
					build(alreadyDelegatedParent, "interrupted")
					return alreadyDelegatedParent
				},
			),
		})

		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => makeParentTask()),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockResolvedValue({ taskId: "child-2", start: vi.fn(), run: () => Promise.resolve() }),
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		} as unknown as ClineProvider

		await (ClineProvider.prototype as any).delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Continue",
			initialTodos: [],
			mode: "code",
		})

		// The builder must sever the old link and apply the new delegation
		const [, build] = taskHistoryStore.atomicUpdateParentDelegation.mock.calls[0]
		const result = build(alreadyDelegatedParent, "interrupted")
		expect(result).toMatchObject({
			status: "delegated",
			awaitingChildId: "child-2",
			delegatedToId: "child-2",
		})
		// Old child ID preserved in childIds (audit trail)
		expect(result.childIds).toContain(oldChildId)
		expect(result.childIds).toContain("child-2")
	})

	it("rejects with 'Cannot re-delegate' when the existing awaited child is still active", async () => {
		const oldChildId = "old-child"
		const activeChild = { id: oldChildId, status: "active" } as unknown as HistoryItem
		const alreadyDelegatedParent: HistoryItem = {
			...parentHistoryItem,
			status: "delegated",
			awaitingChildId: oldChildId,
			delegatedToId: oldChildId,
		} as unknown as HistoryItem

		const child = { taskId: "child-2", start: vi.fn(), run: vi.fn().mockResolvedValue(undefined) }
		const getCurrentTask = vi.fn().mockReturnValue(makeParentTask())
		const createTask = vi.fn().mockImplementation(async () => {
			getCurrentTask.mockReturnValue(child)
			return child
		})

		const taskHistoryStore = makeStoreStub({
			get: vi.fn((id: string) =>
				id === "parent-1" ? alreadyDelegatedParent : id === oldChildId ? activeChild : undefined,
			),
			// Real atomicUpdateParentDelegation behaviour: call the builder and propagate any throw
			atomicUpdateParentDelegation: vi.fn(
				async (
					_taskId: string,
					build: (
						diskParent: HistoryItem,
						awaitedChildDiskStatus: HistoryItemStatus | undefined,
					) => HistoryItem,
				) => {
					build(alreadyDelegatedParent, "active")
					return alreadyDelegatedParent
				},
			),
		})

		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask,
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			deleteTaskWithId: vi.fn().mockResolvedValue(undefined),
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: alreadyDelegatedParent }),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		} as unknown as ClineProvider

		await expect(
			(ClineProvider.prototype as any).delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: "Continue",
				initialTodos: [],
				mode: "code",
			}),
		).rejects.toThrow("Cannot re-delegate while the awaited child is not interrupted")

		// The authoritative preflight rejects before either provider mutates its stack.
		expect(child.run).not.toHaveBeenCalled()
		expect(createTask).not.toHaveBeenCalled()
		expect((provider as any).deleteTaskWithId).not.toHaveBeenCalled()
	})

	it("rejects a delegated parent whose awaited-child identity is missing", async () => {
		const parentTask = makeParentTask()
		const taskHistoryStore = makeStoreStub({
			get: vi.fn().mockReturnValue({ ...parentHistoryItem, status: "delegated" }),
		})
		const provider = {
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn(),
			createTask: vi.fn(),
			taskHistoryStore,
		} as unknown as ClineProvider

		await expect(
			ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: "Continue",
				initialTodos: [],
				mode: "code",
			}),
		).rejects.toThrow("Cannot re-delegate a parent with no awaited child")
		expect(provider.removeClineFromStack).not.toHaveBeenCalled()
	})

	it("serializes same-parent delegation across provider instances and starts only one child", async () => {
		let durableParent = { ...parentHistoryItem, status: "active" as const }
		let releaseCommit!: () => void
		let markCommitStarted!: () => void
		const commitStarted = new Promise<void>((resolve) => {
			markCommitStarted = resolve
		})
		const commitMayFinish = new Promise<void>((resolve) => {
			releaseCommit = resolve
		})

		const makeProvider = (childId: string) => {
			const parent = makeParentTask()
			const child = { taskId: childId, run: vi.fn().mockResolvedValue(undefined) }
			const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
			const store = {
				invalidate: vi.fn().mockResolvedValue(undefined),
				get: vi.fn((id: string) => (id === parent.taskId ? durableParent : undefined)),
				atomicUpdateParentDelegation: vi.fn(
					async (
						_id: string,
						build: (
							diskParent: HistoryItem,
							awaitedChildDiskStatus: HistoryItemStatus | undefined,
						) => HistoryItem,
					) => {
						markCommitStarted()
						await commitMayFinish
						durableParent = build(durableParent, undefined) as typeof durableParent
						return durableParent
					},
				),
			}
			const provider = {
				taskScheduler: new TaskScheduler(),
				emit: vi.fn(),
				getCurrentTask: vi.fn(() => parent),
				removeClineFromStack,
				createTask: vi.fn().mockResolvedValue(child),
				log: vi.fn(),
				isViewLaunched: false,
				taskHistoryStore: store,
			} as unknown as ClineProvider
			return { provider, child, removeClineFromStack }
		}

		const first = makeProvider("child-1")
		const second = makeProvider("child-2")
		const firstDelegation = ClineProvider.prototype.delegateParentAndOpenChild.call(first.provider, {
			parentTaskId: "parent-1",
			message: "First",
			initialTodos: [],
			mode: "code",
		})
		await commitStarted
		const secondDelegation = ClineProvider.prototype.delegateParentAndOpenChild.call(second.provider, {
			parentTaskId: "parent-1",
			message: "Second",
			initialTodos: [],
			mode: "ask",
		})

		expect(second.removeClineFromStack).not.toHaveBeenCalled()
		releaseCommit()
		await expect(firstDelegation).resolves.toBe(first.child)
		await expect(secondDelegation).rejects.toThrow("Cannot re-delegate")
		await Promise.resolve()

		expect(first.child.run).toHaveBeenCalledOnce()
		expect(second.child.run).not.toHaveBeenCalled()
		expect(durableParent.awaitingChildId).toBe("child-1")
	})

	it("rolls back the paused child and restores the parent when atomicUpdateParentDelegation fails", async () => {
		const persistError = new Error("parent metadata persist failed")
		const parentTask = makeParentTask()
		const childRun = vi.fn().mockResolvedValue(undefined)
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const deleteTaskWithId = vi.fn().mockResolvedValue(undefined)
		const createTaskWithHistoryItem = vi.fn().mockResolvedValue(undefined)
		const getTaskWithId = vi.fn().mockResolvedValue({ historyItem: parentHistoryItem })

		const taskHistoryStore = makeStoreStub({
			atomicUpdateParentDelegation: vi.fn().mockRejectedValue(persistError),
		})

		const child = { taskId: "child-1", start: vi.fn(), run: childRun }
		// Before createTask: getCurrentTask returns parent (used by step 3 close).
		// After createTask: returns child so the rollback guard passes and the child is popped.
		const getCurrentTask = vi.fn().mockReturnValue(parentTask)
		const createTask = vi.fn().mockImplementation(async () => {
			getCurrentTask.mockReturnValue(child)
			return child
		})

		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask,
			removeClineFromStack,
			createTask,
			getTaskWithId,
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			deleteTaskWithId,
			createTaskWithHistoryItem,
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		} as unknown as ClineProvider

		await expect(
			(ClineProvider.prototype as any).delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: "Do something",
				initialTodos: [],
				mode: "code",
			}),
		).rejects.toThrow(persistError)

		expect(childRun).not.toHaveBeenCalled()
		expect(removeClineFromStack).toHaveBeenNthCalledWith(1)
		expect(removeClineFromStack).toHaveBeenNthCalledWith(2)
		expect(deleteTaskWithId).toHaveBeenCalledWith("child-1", false)
		expect(createTaskWithHistoryItem).toHaveBeenCalledWith(parentHistoryItem)
	})

	it("settles an interrupted parent's pending action when delegation is rejected", async () => {
		const pendingAction = {
			kind: "create_subtask" as const,
			actionId: "create-action",
			approvalText: "{}",
			mode: "code",
			message: "Do something",
			todos: [],
		}
		let current: HistoryItem = {
			...parentHistoryItem,
			status: "interrupted",
			pendingAction,
		}
		const parentTask = makeParentTask()
		const child = { taskId: "child-1", run: vi.fn().mockResolvedValue(undefined) }
		const getCurrentTask = vi.fn().mockReturnValue(parentTask)
		const createTask = vi.fn(async () => {
			getCurrentTask.mockReturnValue(child)
			return child
		})
		const taskHistoryStore = {
			invalidate: vi.fn().mockResolvedValue(undefined),
			get: vi.fn(() => current),
			atomicUpdateParentDelegation: vi.fn(
				async (
					_taskId: string,
					build: (
						diskParent: HistoryItem,
						awaitedChildDiskStatus: HistoryItemStatus | undefined,
					) => HistoryItem,
				) => {
					current = build(current, undefined)
					return current
				},
			),
			clearPendingActionIfMatching: vi.fn(async (_taskId: string, actionId: string) => {
				if (current.pendingAction?.kind === "create_subtask" && current.pendingAction.actionId === actionId) {
					current = { ...current, pendingAction: undefined }
				}
				return current
			}),
		}
		const provider = {
			taskScheduler: new TaskScheduler(),
			recentTasksCache: [parentHistoryItem],
			emit: vi.fn(),
			getCurrentTask,
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			getTaskWithId: vi.fn().mockImplementation(async () => ({ historyItem: current })),
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			deleteTaskWithId: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
			isViewLaunched: false,
			taskHistoryStore,
		} as unknown as ClineProvider

		await expect(
			ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: pendingAction.message,
				initialTodos: pendingAction.todos,
				mode: pendingAction.mode,
				pendingActionId: pendingAction.actionId,
			}),
		).rejects.toThrow("Invalid task status transition: interrupted → delegated")

		expect(current.pendingAction).toBeUndefined()
		expect(current.status).toBe("interrupted")
		expect((provider as unknown as { recentTasksCache?: HistoryItem[] }).recentTasksCache).toBeUndefined()
		expect(provider.deleteTaskWithId).toHaveBeenCalledWith("child-1", false)
		expect(provider.createTaskWithHistoryItem).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "interrupted",
				pendingAction: undefined,
			}),
		)
	})

	it("rolls back a typed lifecycle rejection without a pending action ID", async () => {
		const interruptedParent: HistoryItem = {
			...parentHistoryItem,
			status: "interrupted",
		}
		const parentTask = makeParentTask()
		const child = { taskId: "child-1", run: vi.fn().mockResolvedValue(undefined) }
		const getCurrentTask = vi.fn().mockReturnValue(parentTask)
		const createTask = vi.fn(async () => {
			getCurrentTask.mockReturnValue(child)
			return child
		})
		let transitionError: LifecycleTransitionError | undefined
		const atomicUpdateParentDelegation = vi.fn(
			async (
				_taskId: string,
				build: (diskParent: HistoryItem, awaitedChildDiskStatus: HistoryItemStatus | undefined) => HistoryItem,
			) => {
				try {
					build(interruptedParent, undefined)
				} catch (error) {
					if (error instanceof LifecycleTransitionError) transitionError = error
					throw error
				}
				return interruptedParent
			},
		)
		const clearPendingActionIfMatching = vi.fn()
		const deleteTaskWithId = vi.fn().mockResolvedValue(undefined)
		const createTaskWithHistoryItem = vi.fn().mockResolvedValue(undefined)
		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask,
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: interruptedParent }),
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			deleteTaskWithId,
			createTaskWithHistoryItem,
			log: vi.fn(),
			isViewLaunched: false,
			taskHistoryStore: {
				invalidate: vi.fn().mockResolvedValue(undefined),
				get: vi.fn(() => interruptedParent),
				atomicUpdateParentDelegation,
				clearPendingActionIfMatching,
			},
		} as unknown as ClineProvider

		let rejection: unknown
		try {
			await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: "Do something",
				initialTodos: [],
				mode: "code",
			})
		} catch (error) {
			rejection = error
		}

		expect(rejection).toBe(transitionError)
		expect(transitionError).toBeInstanceOf(LifecycleTransitionError)
		expect(clearPendingActionIfMatching).not.toHaveBeenCalled()
		expect(deleteTaskWithId).toHaveBeenCalledWith("child-1", false)
		expect(createTaskWithHistoryItem).toHaveBeenCalledWith(interruptedParent)
	})

	it("does not settle a pending action after an unrelated persistence failure", async () => {
		const persistenceError = new Error("parent persistence failed")
		const pendingAction = {
			kind: "create_subtask" as const,
			actionId: "create-action",
			approvalText: "{}",
			mode: "code",
			message: "Do something",
			todos: [],
		}
		const interruptedParent: HistoryItem = {
			...parentHistoryItem,
			status: "interrupted",
			pendingAction,
		}
		const parentTask = makeParentTask()
		const child = { taskId: "child-1", run: vi.fn().mockResolvedValue(undefined) }
		const getCurrentTask = vi.fn().mockReturnValue(parentTask)
		const createTask = vi.fn(async () => {
			getCurrentTask.mockReturnValue(child)
			return child
		})
		const atomicUpdateParentDelegation = vi.fn().mockRejectedValue(persistenceError)
		const clearPendingActionIfMatching = vi.fn().mockResolvedValue(interruptedParent)
		const createTaskWithHistoryItem = vi.fn().mockResolvedValue(undefined)
		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask,
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: interruptedParent }),
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			deleteTaskWithId: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem,
			log: vi.fn(),
			isViewLaunched: false,
			taskHistoryStore: {
				invalidate: vi.fn().mockResolvedValue(undefined),
				get: vi.fn(() => interruptedParent),
				atomicUpdateParentDelegation,
				clearPendingActionIfMatching,
			},
		} as unknown as ClineProvider

		await expect(
			ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: pendingAction.message,
				initialTodos: pendingAction.todos,
				mode: pendingAction.mode,
				pendingActionId: pendingAction.actionId,
			}),
		).rejects.toThrow(persistenceError)

		expect(atomicUpdateParentDelegation).toHaveBeenCalledTimes(1)
		expect(clearPendingActionIfMatching).not.toHaveBeenCalled()
		expect(interruptedParent.pendingAction).toBe(pendingAction)
		expect(provider.deleteTaskWithId).toHaveBeenCalledWith("child-1", false)
		expect(createTaskWithHistoryItem).toHaveBeenCalledWith(interruptedParent)
	})

	it("does not restore a rejected pending action when its settlement write fails", async () => {
		const settlementError = new Error("pending-action settlement failed")
		const pendingAction = {
			kind: "create_subtask" as const,
			actionId: "create-action",
			approvalText: "{}",
			mode: "code",
			message: "Do something",
			todos: [],
		}
		const interruptedParent: HistoryItem = {
			...parentHistoryItem,
			status: "interrupted",
			pendingAction,
		}
		const parentTask = makeParentTask()
		const child = { taskId: "child-1", run: vi.fn().mockResolvedValue(undefined) }
		const getCurrentTask = vi.fn().mockReturnValue(parentTask)
		const createTask = vi.fn(async () => {
			getCurrentTask.mockReturnValue(child)
			return child
		})
		const atomicUpdateParentDelegation = vi.fn(
			async (
				_taskId: string,
				build: (diskParent: HistoryItem, awaitedChildDiskStatus: HistoryItemStatus | undefined) => HistoryItem,
			) => {
				build(interruptedParent, undefined)
				return interruptedParent
			},
		)
		const clearPendingActionIfMatching = vi.fn().mockRejectedValue(settlementError)
		const createTaskWithHistoryItem = vi.fn().mockResolvedValue(undefined)
		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask,
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: interruptedParent }),
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			deleteTaskWithId: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem,
			log: vi.fn(),
			isViewLaunched: false,
			taskHistoryStore: {
				invalidate: vi.fn().mockResolvedValue(undefined),
				get: vi.fn(() => interruptedParent),
				atomicUpdateParentDelegation,
				clearPendingActionIfMatching,
			},
		} as unknown as ClineProvider

		await expect(
			ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: pendingAction.message,
				initialTodos: pendingAction.todos,
				mode: pendingAction.mode,
				pendingActionId: pendingAction.actionId,
			}),
		).rejects.toThrow("Invalid task status transition: interrupted → delegated")

		expect(atomicUpdateParentDelegation).toHaveBeenCalledTimes(1)
		expect(clearPendingActionIfMatching).toHaveBeenCalledTimes(1)
		expect(provider.deleteTaskWithId).toHaveBeenCalledWith("child-1", false)
		expect(createTaskWithHistoryItem).not.toHaveBeenCalled()
	})

	it("does not restore a completed parent when settlement preserves the rejected action", async () => {
		const pendingAction = {
			kind: "create_subtask" as const,
			actionId: "create-action",
			approvalText: "{}",
			mode: "code",
			message: "Do something",
			todos: [],
		}
		const interruptedParent: HistoryItem = {
			...parentHistoryItem,
			status: "interrupted",
			pendingAction,
		}
		const completedParent: HistoryItem = {
			...parentHistoryItem,
			status: "completed",
			pendingAction,
		}
		const parentTask = makeParentTask()
		const child = { taskId: "child-1", run: vi.fn().mockResolvedValue(undefined) }
		const getCurrentTask = vi.fn().mockReturnValue(parentTask)
		const createTask = vi.fn(async () => {
			getCurrentTask.mockReturnValue(child)
			return child
		})
		const clearPendingActionIfMatching = vi.fn().mockResolvedValue(completedParent)
		const createTaskWithHistoryItem = vi.fn().mockResolvedValue(undefined)
		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask,
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: completedParent }),
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			deleteTaskWithId: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem,
			log: vi.fn(),
			isViewLaunched: false,
			taskHistoryStore: {
				invalidate: vi.fn().mockResolvedValue(undefined),
				get: vi.fn(() => interruptedParent),
				atomicUpdateParentDelegation: vi.fn(
					async (
						_taskId: string,
						build: (
							diskParent: HistoryItem,
							awaitedChildDiskStatus: HistoryItemStatus | undefined,
						) => HistoryItem,
					) => {
						build(interruptedParent, undefined)
						return interruptedParent
					},
				),
				clearPendingActionIfMatching,
			},
		} as unknown as ClineProvider

		await expect(
			ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: pendingAction.message,
				initialTodos: pendingAction.todos,
				mode: pendingAction.mode,
				pendingActionId: pendingAction.actionId,
			}),
		).rejects.toThrow("Invalid task status transition: interrupted → delegated")

		expect(clearPendingActionIfMatching).toHaveBeenCalledWith("parent-1", pendingAction.actionId)
		expect(provider.deleteTaskWithId).toHaveBeenCalledWith("child-1", false)
		expect(createTaskWithHistoryItem).not.toHaveBeenCalled()
	})

	it("restores the authoritative parent record when settlement preserves a replacement action", async () => {
		const pendingAction = {
			kind: "create_subtask" as const,
			actionId: "create-action",
			approvalText: "{}",
			mode: "code",
			message: "Do something",
			todos: [],
		}
		const replacementAction = { ...pendingAction, actionId: "replacement-action" }
		const cachedParent: HistoryItem = {
			...parentHistoryItem,
			status: "interrupted",
			pendingAction,
		}
		const replacedParent: HistoryItem = {
			...parentHistoryItem,
			status: "interrupted",
			pendingAction: replacementAction,
		}
		const parentTask = makeParentTask()
		const child = { taskId: "child-1", run: vi.fn().mockResolvedValue(undefined) }
		const getCurrentTask = vi.fn().mockReturnValue(parentTask)
		const createTask = vi.fn(async () => {
			getCurrentTask.mockReturnValue(child)
			return child
		})
		const clearPendingActionIfMatching = vi.fn(async (_taskId: string, _actionId: string) => replacedParent)
		const createTaskWithHistoryItem = vi.fn().mockResolvedValue(undefined)
		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask,
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: replacedParent }),
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			deleteTaskWithId: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem,
			log: vi.fn(),
			isViewLaunched: false,
			taskHistoryStore: {
				invalidate: vi.fn().mockResolvedValue(undefined),
				get: vi.fn(() => cachedParent),
				atomicUpdateParentDelegation: vi.fn(
					async (
						_taskId: string,
						build: (
							diskParent: HistoryItem,
							awaitedChildDiskStatus: HistoryItemStatus | undefined,
						) => HistoryItem,
					) => {
						build(cachedParent, undefined)
						return cachedParent
					},
				),
				clearPendingActionIfMatching,
			},
		} as unknown as ClineProvider

		await expect(
			ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: pendingAction.message,
				initialTodos: pendingAction.todos,
				mode: pendingAction.mode,
				pendingActionId: pendingAction.actionId,
			}),
		).rejects.toThrow("Invalid task status transition: interrupted → delegated")

		expect(clearPendingActionIfMatching).toHaveBeenCalledTimes(1)
		expect(replacedParent.pendingAction).toEqual(replacementAction)
		expect(provider.deleteTaskWithId).toHaveBeenCalledWith("child-1", false)
		expect(createTaskWithHistoryItem).toHaveBeenCalledWith(replacedParent)
	})

	it("keeps directory cleanup and parent restoration when the child history lock failure is swallowed", async () => {
		const pendingAction = {
			kind: "create_subtask" as const,
			actionId: "create-action",
			approvalText: "{}",
			mode: "code",
			message: "Do something",
			todos: [],
		}
		const interruptedParent: HistoryItem = {
			...parentHistoryItem,
			status: "interrupted",
			pendingAction,
		}
		const settledParent: HistoryItem = { ...interruptedParent, pendingAction: undefined }
		const childItem: HistoryItem = { ...parentHistoryItem, id: "child-1", task: "Child" }

		const globalStorageDir = await fs.mkdtemp(path.join(os.tmpdir(), "delegation-rollback-cleanup-"))
		const childDir = path.join(globalStorageDir, "tasks", "child-1")
		await fs.mkdir(childDir, { recursive: true })
		await fs.writeFile(path.join(childDir, "ui_messages.json"), "[]")

		const parentTask = makeParentTask()
		const child = { taskId: "child-1", run: vi.fn().mockResolvedValue(undefined) }
		const getCurrentTask = vi.fn().mockReturnValue(parentTask)
		const createTask = vi.fn(async () => {
			getCurrentTask.mockReturnValue(child)
			return child
		})
		const createTaskWithHistoryItem = vi.fn().mockResolvedValue(undefined)
		const getTaskWithId = vi.fn(async (taskId: string) => {
			if (taskId === "parent-1") {
				return { historyItem: settledParent }
			}
			return { taskDirPath: childDir, historyItem: childItem }
		})
		const clearPendingActionIfMatching = vi.fn(async () => settledParent)

		const provider = {
			taskScheduler: new TaskScheduler(),
			recentTasksCache: [parentHistoryItem],
			emit: vi.fn(),
			getCurrentTask,
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			getTaskWithId,
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			// The real deletion path: the store swallows a per-file history
			// lock failure, so deleteMany resolves and cleanup continues.
			deleteTaskWithId: ClineProvider.prototype.deleteTaskWithId,
			createTaskWithHistoryItem,
			log: vi.fn(),
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			isViewLaunched: false,
			contextProxy: { globalStorageUri: { fsPath: globalStorageDir } },
			cwd: globalStorageDir,
			taskHistoryStore: {
				invalidate: vi.fn().mockResolvedValue(undefined),
				get: vi.fn(() => interruptedParent),
				atomicUpdateParentDelegation: vi.fn(
					async (
						_taskId: string,
						build: (
							diskParent: HistoryItem,
							awaitedChildDiskStatus: HistoryItemStatus | undefined,
						) => HistoryItem,
					) => {
						build(interruptedParent, undefined)
						return interruptedParent
					},
				),
				clearPendingActionIfMatching,
				deleteMany: vi.fn().mockResolvedValue(undefined),
			},
		} as unknown as ClineProvider

		try {
			await expect(
				ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
					parentTaskId: "parent-1",
					message: pendingAction.message,
					initialTodos: pendingAction.todos,
					mode: pendingAction.mode,
					pendingActionId: pendingAction.actionId,
				}),
			).rejects.toThrow("Invalid task status transition: interrupted → delegated")

			// The child task directory was removed even though the child's
			// history lock failed and was swallowed, and the settled parent
			// was restored before the original rejection surfaced.
			await expect(fs.access(childDir)).rejects.toMatchObject({ code: "ENOENT" })
			expect(clearPendingActionIfMatching).toHaveBeenCalledWith("parent-1", "create-action")
			expect(createTaskWithHistoryItem).toHaveBeenCalledWith(
				expect.objectContaining({ status: "interrupted", pendingAction: undefined }),
			)
		} finally {
			await fs.rm(globalStorageDir, { recursive: true, force: true }).catch(() => {})
		}
	})
})
