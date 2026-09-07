// npx vitest run __tests__/ClineProvider.delegation.spec.ts

import { describe, it, expect, vi } from "vitest"
import type { HistoryItem, ProviderSettings } from "@roo-code/types"
import { RooCodeEventName } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"
import { ClineProvider } from "../core/webview/ClineProvider"
import { TaskScheduler } from "../core/task/TaskScheduler"
import {
	createPreparedProviderHandoffContext,
	type PreparedProviderHandoffContext,
	type ProviderHandoffProjectionOutcome,
} from "../core/task-persistence/providerHandoff"

const parentHistoryItem: HistoryItem = {
	id: "parent-1",
	task: "Parent",
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	childIds: [],
} as unknown as HistoryItem

/** Minimal taskHistoryStore stub whose atomicReadAndUpdate calls the updater with the parent item. */
function makeStoreStub(
	overrides: Partial<{
		atomicReadAndUpdate: ReturnType<typeof vi.fn>
		get: ReturnType<typeof vi.fn>
		readFresh: ReturnType<typeof vi.fn>
		invalidate: ReturnType<typeof vi.fn>
	}> = {},
) {
	return {
		atomicReadAndUpdate: vi.fn(async (_taskId: string, updater: (h: HistoryItem) => HistoryItem) => {
			updater(parentHistoryItem)
			return []
		}),
		// A persisted parent record with no delegation, read strictly from its
		// durable task file: the commit-rejection reconciliation reads this as
		// an exact nondelegated preimage — definitively uncommitted. The child
		// history is optional at this boundary and absent by default.
		get: vi.fn((taskId: string) => (taskId === "parent-1" ? { ...parentHistoryItem } : undefined)),
		readFresh: vi.fn(async (taskId: string) =>
			taskId === "parent-1"
				? { kind: "found" as const, item: { ...parentHistoryItem } }
				: { kind: "missing" as const },
		),
		invalidate: vi.fn().mockResolvedValue(undefined),
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
		emit: vi.fn(),
		flushPendingToolResultsToHistory: vi.fn().mockResolvedValue(true),
		retrySaveApiConversationHistory: vi.fn(),
	}) as any

const SENTINEL_API_KEY = "sk-handoff-sentinel-123456"

/** Prepared handoff snapshot double used by happy-path delegation tests. */
const makePreparedHandoff = (
	overrides: Partial<{
		profileName: string | undefined
		profileId: string | undefined
		apiConfiguration: ProviderSettings
		persistModeProfileId: string | undefined
	}> = {},
): PreparedProviderHandoffContext =>
	createPreparedProviderHandoffContext({
		requestedMode: "code",
		profile: {
			source: "unsaved-current",
			name: overrides.profileName === undefined ? "profile-1" : overrides.profileName,
			id: overrides.profileId === undefined ? "profile-1-id" : overrides.profileId,
		},
		apiConfiguration: overrides.apiConfiguration ?? { apiProvider: providerIdentifiers.openrouter },
		persistModeProfileId: overrides.persistModeProfileId ?? "profile-1-id",
	})

/** Child task double with the execution-context adoption hook the provider calls after the commit. */
const makeChildTask = (taskId: string) => {
	const run = vi.fn().mockResolvedValue(undefined)
	return {
		taskId,
		start: vi.fn(),
		run,
		adoptHandoffExecutionContext: vi.fn(),
		updateApiConfiguration: vi.fn(),
	}
}

/** Minimal prepared-handoff provider stub: preparation is stubbed, the post-commit projection runs harmlessly. */
const makePreparationStub = (prepared: PreparedProviderHandoffContext) => vi.fn().mockResolvedValue(prepared)

/**
 * Real handoff prototype methods so `delegateParentAndOpenChild` can run with
 * a stub `this`. Specific tests override individual entries (e.g. the
 * preparation stub above).
 */
const handoffPrototype = {
	prepareProviderHandoffContext: ClineProvider.prototype["prepareProviderHandoffContext"],
	projectPreparedProviderHandoffState: ClineProvider.prototype["projectPreparedProviderHandoffState"],
	runProviderHandoffProjectionWrites: ClineProvider.prototype["runProviderHandoffProjectionWrites"],
	rollbackFailedDelegation: ClineProvider.prototype["rollbackFailedDelegation"],
	restoreParentAfterFailedChildCreation: ClineProvider.prototype["restoreParentAfterFailedChildCreation"],
	reconcileDelegationCommitFailure: ClineProvider.prototype["reconcileDelegationCommitFailure"],
	delegateParentAndOpenChildUnlocked: ClineProvider.prototype["delegateParentAndOpenChildUnlocked"],
	runDelegationTransition: ClineProvider.prototype["runDelegationTransition"],
	enqueueProviderProfileMutation: ClineProvider.prototype["enqueueProviderProfileMutation"],
	markStaleProviderHandoffProjection: ClineProvider.prototype["markStaleProviderHandoffProjection"],
	clearStaleProviderHandoffProjection: ClineProvider.prototype["clearStaleProviderHandoffProjection"],
	supersedeStaleProviderHandoffProjection: ClineProvider.prototype["supersedeStaleProviderHandoffProjection"],
	isCurrentProfileMutationGeneration: ClineProvider.prototype["isCurrentProfileMutationGeneration"],
	isProviderHandoffProjectionStillRelevant: ClineProvider.prototype["isProviderHandoffProjectionStillRelevant"],
	invalidateProviderHandoffProjectionState: ClineProvider.prototype["invalidateProviderHandoffProjectionState"],
	registerProviderHandoffProjectionTarget: ClineProvider.prototype["registerProviderHandoffProjectionTarget"],
	admitProviderHandoffProjectionTarget: ClineProvider.prototype["admitProviderHandoffProjectionTarget"],
	isExplicitProfileClearInForce: ClineProvider.prototype["isExplicitProfileClearInForce"],
	deleteTaskFromState: ClineProvider.prototype.deleteTaskFromState,
	markDelegatedChildInterrupted: ClineProvider.prototype["markDelegatedChildInterrupted"],
	markDelegatedChildInterruptedUnlocked: ClineProvider.prototype["markDelegatedChildInterruptedUnlocked"],
	evictCurrentTask: ClineProvider.prototype.evictCurrentTask,
}

const makeProviderStub = (partial: Record<string, unknown>): ClineProvider =>
	({
		// Per-parent delegation transition serialization and the bounded
		// profile-mutation queue, shared by every test through the real
		// prototype implementations.
		delegationTransitionLocks: new Map<string, Promise<void>>(),
		delegationTransitionOwners: new Map<string, symbol>(),
		cancelledDelegationChildIds: new Set<string>(),
		explicitProfileClearChildIds: new Set<string>(),
		providerProfileMutationQueue: Promise.resolve(),
		providerProfileMutationReservation: 0,
		providerProfileMutationGeneration: 0,
		providerProfileMutationSettledGeneration: 0,
		profileMutationAbortControllers: new Set<AbortController>(),
		nextProviderHandoffProjectionToken: 0,
		_disposed: false,
		// No current task by default: the durable explicit-clear fallback
		// only consults the manager for a still-current task.
		getCurrentTask: vi.fn(() => undefined),
		...handoffPrototype,
		...partial,
	}) as unknown as ClineProvider

describe("ClineProvider.delegateParentAndOpenChild()", () => {
	it("rejects a stale restored action before delegation side effects", async () => {
		const parentTask = makeParentTask()
		const removeClineFromStack = vi.fn()
		const createTask = vi.fn()
		const prepareProviderHandoffContext = vi.fn()
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
		const provider = makeProviderStub({
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack,
			createTask,
			prepareProviderHandoffContext,
			taskHistoryStore,
		})

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
		expect(prepareProviderHandoffContext).not.toHaveBeenCalled()
		expect(createTask).not.toHaveBeenCalled()
		expect(taskHistoryStore.atomicReadAndUpdate).not.toHaveBeenCalled()
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
			get: vi.fn(() => current),
			atomicReadAndUpdate: vi.fn(async (_taskId: string, updater: (item: HistoryItem) => HistoryItem) => {
				current = updater(current)
				return [current]
			}),
		}
		const parentTask = makeParentTask()
		const child = makeChildTask("child-1")
		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockResolvedValue(child),
			prepareProviderHandoffContext: makePreparationStub(makePreparedHandoff()),
			log: vi.fn(),
			isViewLaunched: false,
			taskHistoryStore,
		})

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

	it("fails closed when preparation rejects: parent stays current, no child, no store writes", async () => {
		const parentTask = makeParentTask()
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const createTask = vi.fn()
		const prepareProviderHandoffContext = vi.fn().mockRejectedValue(new Error("handoff preparation failed"))
		const providerEmit = vi.fn()
		const taskHistoryStore = makeStoreStub()

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: providerEmit,
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack,
			createTask,
			prepareProviderHandoffContext,
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		await expect(
			ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: "Do something",
				initialTodos: [],
				mode: "code",
			}),
		).rejects.toThrow("handoff preparation failed")

		// Fail closed before the stack changes: the parent was never removed, so it
		// remains the current task.
		expect(removeClineFromStack).not.toHaveBeenCalled()
		expect(provider.getCurrentTask()).toBe(parentTask)

		// No child was created (so none was scheduled) and no parent delegation
		// metadata was committed.
		expect(createTask).not.toHaveBeenCalled()
		expect(taskHistoryStore.atomicReadAndUpdate).not.toHaveBeenCalled()
		expect(providerEmit).not.toHaveBeenCalledWith(RooCodeEventName.TaskDelegated, "parent-1", expect.anything())
	})

	it("restores the parent when child creation fails after the parent was removed", async () => {
		const parentTask = makeParentTask()
		const creationError = new Error("child creation failed")
		const createTask = vi.fn().mockRejectedValue(creationError)
		const createTaskWithHistoryItem = vi.fn().mockResolvedValue(undefined)
		const getTaskWithId = vi.fn().mockResolvedValue({ historyItem: parentHistoryItem })
		const providerEmit = vi.fn()
		const taskHistoryStore = makeStoreStub()

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: providerEmit,
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			prepareProviderHandoffContext: makePreparationStub(makePreparedHandoff()),
			getTaskWithId,
			createTaskWithHistoryItem,
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		await expect(
			ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: "Do something",
				initialTodos: [],
				mode: "code",
			}),
		).rejects.toThrow(creationError)

		// The original creation error is preserved and the parent is restored.
		expect(getTaskWithId).toHaveBeenCalledWith("parent-1")
		expect(createTaskWithHistoryItem).toHaveBeenCalledWith(parentHistoryItem, {
			transitionOwner: expect.anything(),
		})

		// No delegation metadata was committed and nothing was emitted.
		expect(taskHistoryStore.atomicReadAndUpdate).not.toHaveBeenCalled()
		expect(providerEmit).not.toHaveBeenCalledWith(RooCodeEventName.TaskDelegated, "parent-1", expect.anything())
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
			// The strict fresh read mirrors the unchanged durable record: the
			// updater rejected before anything was written.
			readFresh: vi.fn(async () => ({
				kind: "found" as const,
				item: { ...parentHistoryItem, status: "active", pendingAction },
			})),
			atomicReadAndUpdate: vi.fn(async (_taskId: string, updater: (item: HistoryItem) => HistoryItem) => {
				updater({ ...parentHistoryItem, status: "active", pendingAction: replacementAction })
				return []
			}),
		})
		const deleteTaskWithId = vi.fn().mockResolvedValue(undefined)
		const createTaskWithHistoryItem = vi.fn().mockResolvedValue(undefined)
		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask,
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			prepareProviderHandoffContext: makePreparationStub(makePreparedHandoff()),
			deleteTaskWithId,
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentHistoryItem }),
			createTaskWithHistoryItem,
			log: vi.fn(),
			isViewLaunched: false,
			taskHistoryStore,
		})

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
		expect(createTaskWithHistoryItem).toHaveBeenCalledWith(parentHistoryItem, {
			transitionOwner: expect.anything(),
		})
	})

	it("persists parent delegation metadata via atomicReadAndUpdate and emits TaskDelegated", async () => {
		const providerEmit = vi.fn()
		const parentTask = makeParentTask()
		const prepared = makePreparedHandoff()

		const child = makeChildTask("child-1")
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const createTask = vi.fn().mockResolvedValue(child)
		const taskHistoryStore = makeStoreStub()

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: providerEmit,
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack,
			createTask,
			prepareProviderHandoffContext: makePreparationStub(prepared),
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		const result = await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})
		await Promise.resolve() // drain scheduler microtask so child.run() is invoked

		expect(result.taskId).toBe("child-1")

		// Invariant: parent closed before child creation
		expect(removeClineFromStack).toHaveBeenCalledTimes(1)

		// Child task created from the all-or-none explicit handoff execution
		// context with startTask: false
		expect(createTask).toHaveBeenCalledWith("Do something", undefined, parentTask, {
			initialTodos: [],
			initialStatus: "active",
			startTask: false,
			handoffExecutionContext: {
				mode: prepared.requestedMode,
				apiConfigName: prepared.profile.name,
				apiConfiguration: expect.anything(),
			},
		})

		// Delegation metadata written via atomicReadAndUpdate with correct taskId
		expect(taskHistoryStore.atomicReadAndUpdate).toHaveBeenCalledTimes(1)
		const [calledTaskId, updater] = taskHistoryStore.atomicReadAndUpdate.mock.calls[0]
		expect(calledTaskId).toBe("parent-1")

		// The updater must produce the correct delegation fields
		const delegated = updater(parentHistoryItem)
		expect(delegated).toMatchObject({
			id: "parent-1",
			status: "delegated",
			delegatedToId: "child-1",
			awaitingChildId: "child-1",
			childIds: expect.arrayContaining(["child-1"]),
		})

		// The prepared context became authoritative on the paused child after the commit.
		expect(child.adoptHandoffExecutionContext).toHaveBeenCalledWith({
			mode: prepared.requestedMode,
			apiConfigName: prepared.profile.name,
			apiConfiguration: expect.anything(),
		})

		// child.run() called AFTER parent metadata is persisted (via taskScheduler)
		expect(child.run).toHaveBeenCalledTimes(1)

		// Provider-level event
		expect(providerEmit).toHaveBeenCalledWith(RooCodeEventName.TaskDelegated, "parent-1", "child-1")
	})

	it("posts taskHistoryItemUpdated to the webview when isViewLaunched is true", async () => {
		const updatedParent = { ...parentHistoryItem, status: "delegated" } as HistoryItem
		const postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		const parentTask = makeParentTask()
		const taskHistoryStore = makeStoreStub({
			get: vi.fn().mockReturnValue(updatedParent),
		})

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockResolvedValue(makeChildTask("child-1")),
			prepareProviderHandoffContext: makePreparationStub(makePreparedHandoff()),
			postMessageToWebview,
			log: vi.fn(),
			isViewLaunched: true,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
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

	it("skips postMessageToWebview when isViewLaunched is true but store returns undefined", async () => {
		const postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		const parentTask = makeParentTask()
		const taskHistoryStore = makeStoreStub({
			get: vi.fn().mockReturnValue(undefined),
		})

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockResolvedValue(makeChildTask("child-1")),
			prepareProviderHandoffContext: makePreparationStub(makePreparedHandoff()),
			postMessageToWebview,
			log: vi.fn(),
			isViewLaunched: true,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})

		expect(postMessageToWebview).not.toHaveBeenCalled()
	})

	it("calls child.run() only after atomicReadAndUpdate completes (no race condition)", async () => {
		const callOrder: string[] = []

		const parentTask = makeParentTask()
		const child = makeChildTask("child-1")
		child.run.mockImplementation(async () => {
			callOrder.push("child.run")
		})
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const createTask = vi.fn(async () => {
			callOrder.push("createTask")
			return child
		})
		const prepareProviderHandoffContext = vi.fn(async () => {
			callOrder.push("prepareProviderHandoffContext")
			return makePreparedHandoff()
		})
		const taskHistoryStore = makeStoreStub({
			atomicReadAndUpdate: vi.fn(async (_taskId: string, _updater: (h: HistoryItem) => HistoryItem) => {
				callOrder.push("atomicReadAndUpdate")
				return []
			}),
		})

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack,
			createTask,
			prepareProviderHandoffContext,
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})
		await Promise.resolve() // drain scheduler microtask so child.run() is invoked

		// prepare → createTask → atomicReadAndUpdate → child.run: read-only
		// preparation completes before the parent leaves the stack, and the
		// scheduler admits the child only after metadata is persisted
		expect(callOrder).toEqual(["prepareProviderHandoffContext", "createTask", "atomicReadAndUpdate", "child.run"])
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
			atomicReadAndUpdate: vi.fn(async (_taskId: string, updater: (h: HistoryItem) => HistoryItem) => {
				updater(alreadyDelegatedParent)
				return []
			}),
		})

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => makeParentTask()),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockResolvedValue(makeChildTask("child-2")),
			prepareProviderHandoffContext: makePreparationStub(makePreparedHandoff()),
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Continue",
			initialTodos: [],
			mode: "code",
		})

		// The updater must sever the old link and apply the new delegation
		const [, updater] = taskHistoryStore.atomicReadAndUpdate.mock.calls[0]
		const result = updater(alreadyDelegatedParent)
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

		const child = makeChildTask("child-2")
		const getCurrentTask = vi.fn().mockReturnValue(makeParentTask())
		const createTask = vi.fn().mockImplementation(async () => {
			getCurrentTask.mockReturnValue(child)
			return child
		})

		const taskHistoryStore = makeStoreStub({
			get: vi.fn((id: string) =>
				id === "parent-1" ? alreadyDelegatedParent : id === oldChildId ? activeChild : undefined,
			),
			// The strict fresh read mirrors the unchanged durable record: the
			// updater rejected before anything was written.
			readFresh: vi.fn(async (taskId: string) =>
				taskId === "parent-1"
					? { kind: "found" as const, item: alreadyDelegatedParent }
					: { kind: "missing" as const },
			),
			// Real atomicReadAndUpdate behaviour: call the updater and propagate any throw
			atomicReadAndUpdate: vi.fn(async (_taskId: string, updater: (h: HistoryItem) => HistoryItem) => {
				updater(alreadyDelegatedParent)
				return []
			}),
		})

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask,
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			prepareProviderHandoffContext: makePreparationStub(makePreparedHandoff()),
			deleteTaskWithId: vi.fn().mockResolvedValue(undefined),
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: alreadyDelegatedParent }),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		await expect(
			ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: "Continue",
				initialTodos: [],
				mode: "code",
			}),
		).rejects.toThrow("Cannot re-delegate")

		// Rollback: child must not have run, and must be cleaned up
		expect(child.run).not.toHaveBeenCalled()
		expect((provider as any).deleteTaskWithId).toHaveBeenCalledWith("child-2", false)
	})

	it("rolls back the paused child and restores the parent when atomicReadAndUpdate fails", async () => {
		const persistError = new Error("parent metadata persist failed")
		const parentTask = makeParentTask()
		const child = makeChildTask("child-1")
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const deleteTaskWithId = vi.fn().mockResolvedValue(undefined)
		const createTaskWithHistoryItem = vi.fn().mockResolvedValue(undefined)
		const getTaskWithId = vi.fn().mockResolvedValue({ historyItem: parentHistoryItem })

		const taskHistoryStore = makeStoreStub({
			atomicReadAndUpdate: vi.fn().mockRejectedValue(persistError),
		})

		// Before createTask: getCurrentTask returns parent (used by step 4 close).
		// After createTask: returns child so the rollback guard passes and the child is popped.
		const getCurrentTask = vi.fn().mockReturnValue(parentTask)
		const createTask = vi.fn().mockImplementation(async () => {
			getCurrentTask.mockReturnValue(child)
			return child
		})

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask,
			removeClineFromStack,
			createTask,
			getTaskWithId,
			prepareProviderHandoffContext: makePreparationStub(makePreparedHandoff()),
			deleteTaskWithId,
			createTaskWithHistoryItem,
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		await expect(
			ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: "Do something",
				initialTodos: [],
				mode: "code",
			}),
		).rejects.toThrow(persistError)

		expect(child.run).not.toHaveBeenCalled()
		expect(removeClineFromStack).toHaveBeenNthCalledWith(1)
		expect(removeClineFromStack).toHaveBeenNthCalledWith(2)
		expect(deleteTaskWithId).toHaveBeenCalledWith("child-1", false)
		expect(createTaskWithHistoryItem).toHaveBeenCalledWith(parentHistoryItem, {
			transitionOwner: expect.anything(),
		})
	})

	it("wraps an incomplete rollback in an AggregateError that preserves the original error first", async () => {
		const persistError = new Error("parent metadata persist failed")
		const cleanupError = new Error("child cleanup failed")
		const parentTask = makeParentTask()
		const child = makeChildTask("child-1")
		const deleteTaskWithId = vi.fn().mockRejectedValue(cleanupError)
		const createTaskWithHistoryItem = vi.fn().mockResolvedValue(undefined)
		const getTaskWithId = vi.fn().mockResolvedValue({ historyItem: parentHistoryItem })

		const taskHistoryStore = makeStoreStub({
			atomicReadAndUpdate: vi.fn().mockRejectedValue(persistError),
		})

		const getCurrentTask = vi.fn().mockReturnValue(parentTask)
		const createTask = vi.fn().mockImplementation(async () => {
			getCurrentTask.mockReturnValue(child)
			return child
		})

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask,
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			getTaskWithId,
			prepareProviderHandoffContext: makePreparationStub(makePreparedHandoff()),
			deleteTaskWithId,
			createTaskWithHistoryItem,
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		const error: unknown = await ClineProvider.prototype.delegateParentAndOpenChild
			.call(provider, {
				parentTaskId: "parent-1",
				message: "Do something",
				initialTodos: [],
				mode: "code",
			})
			.catch((caught: unknown) => caught)

		if (!(error instanceof AggregateError)) {
			throw new Error(`expected an AggregateError, got: ${String(error)}`)
		}

		// Original commit failure first, then the failed rollback steps.
		expect(error.errors).toEqual([persistError, cleanupError])
		expect(error.message).toContain("parent metadata persist failed")
		expect(createTaskWithHistoryItem).toHaveBeenCalledWith(parentHistoryItem, {
			transitionOwner: expect.anything(),
		})
	})

	it("projects global state only after the delegation commit and still starts the child when projection fails", async () => {
		const callOrder: string[] = []
		const parentTask = makeParentTask()
		const child = makeChildTask("child-1")
		child.run.mockImplementation(async () => {
			callOrder.push("child.run")
		})
		const providerEmit = vi.fn()
		const updateGlobalState = vi.fn(async (key: string) => {
			callOrder.push(`update:${key}`)
		})
		const setProviderSettings = vi.fn(async () => {
			callOrder.push("setProviderSettings")
		})
		const projectHandoffState = vi.fn(async () => {
			callOrder.push("projectHandoffState")
		})
		const listConfig = vi.fn(async () => {
			callOrder.push("listConfig")
			return []
		})

		const taskHistoryStore = makeStoreStub({
			atomicReadAndUpdate: vi.fn(async (_taskId: string, updater: (h: HistoryItem) => HistoryItem) => {
				callOrder.push("commit")
				updater(parentHistoryItem)
				return []
			}),
		})

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: providerEmit,
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockResolvedValue(child),
			prepareProviderHandoffContext: makePreparationStub(makePreparedHandoff()),
			// The real bounded queue: generation bookkeeping must be live for the
			// projection-result fences under test.
			enqueueProviderProfileMutation: ClineProvider.prototype["enqueueProviderProfileMutation"],
			updateGlobalState,
			contextProxy: { setProviderSettings },
			providerSettingsManager: { listConfig, projectHandoffState },
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})
		await Promise.resolve() // drain scheduler microtask so child.run() is invoked

		// The child starts immediately after the commit WITHOUT awaiting the
		// legacy projection.
		expect(callOrder.indexOf("commit")).toBeLessThan(callOrder.indexOf("child.run"))
		expect(child.run).toHaveBeenCalledTimes(1)

		// Deterministically await the exposed background-projection hook.
		await (provider as unknown as { providerHandoffProjectionCompletion?: Promise<unknown> })
			.providerHandoffProjectionCompletion

		// No global write happens before the durable delegation commit...
		expect(callOrder.indexOf("commit")).toBeLessThan(callOrder.indexOf("update:mode"))
		expect(callOrder.indexOf("commit")).toBeLessThan(callOrder.indexOf("update:currentApiConfigName"))
		expect(callOrder.indexOf("commit")).toBeLessThan(callOrder.indexOf("setProviderSettings"))
		// ...and child.run precedes every projection write.
		expect(callOrder).toContain("update:mode")
		expect(callOrder).toContain("projectHandoffState")

		// ...the durable mode mapping intent is projected with the prepared
		// profile as an explicit set intent...
		expect(projectHandoffState).toHaveBeenCalledWith({
			intent: { kind: "set", name: "profile-1" },
			mode: "code",
			modeConfigId: "profile-1-id",
		})
		// ...and the delegation is announced.
		expect(providerEmit).toHaveBeenCalledWith(RooCodeEventName.TaskDelegated, "parent-1", "child-1")
	})

	it("advances the shared handoff protocol to child-running on the happy path", async () => {
		const parentTask = makeParentTask()
		const child = makeChildTask("child-1")

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockResolvedValue(child),
			prepareProviderHandoffContext: makePreparationStub(makePreparedHandoff()),
			projectPreparedProviderHandoffState: vi.fn().mockResolvedValue({ ok: true }),
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore: makeStoreStub(),
		})

		await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})

		// Deterministically await the exposed background-projection hook.
		await (provider as unknown as { providerHandoffProjectionCompletion?: Promise<unknown> })
			.providerHandoffProjectionCompletion

		const protocol = (provider as unknown as { providerHandoffProtocol?: { snapshot(): { phase: string } } })
			.providerHandoffProtocol
		// Publication is asynchronous and policy-gated outside the method, so
		// the last landmark is child-running with the background projection
		// recorded as synchronized.
		expect(protocol?.snapshot()).toMatchObject({
			phase: "child-running",
			delegation: "committed",
			contextAuthority: "child",
			childPresence: "running",
			projection: "synchronized",
			publication: "none",
			commitAttempts: 1,
		})
	})

	it("records child-running with an unresolved projection before the background projection settles", async () => {
		const parentTask = makeParentTask()
		const child = makeChildTask("child-1")
		let releaseProjection!: (outcome: ProviderHandoffProjectionOutcome) => void
		const projectionGate = new Promise<ProviderHandoffProjectionOutcome>((resolve) => {
			releaseProjection = resolve
		})

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockResolvedValue(child),
			prepareProviderHandoffContext: makePreparationStub(makePreparedHandoff()),
			projectPreparedProviderHandoffState: vi.fn().mockReturnValue(projectionGate),
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore: makeStoreStub(),
		})

		await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})
		await Promise.resolve()

		const protocolState = (
			provider as unknown as {
				providerHandoffProtocol?: { snapshot(): { phase: string; projection: string } }
			}
		).providerHandoffProtocol?.snapshot()
		// The child is already running while the legacy projection is still
		// unresolved; the child start never awaits the background work.
		expect(protocolState).toMatchObject({ phase: "child-running", projection: "original" })
		expect(child.run).toHaveBeenCalledTimes(1)

		releaseProjection({ ok: true })
		await (provider as unknown as { providerHandoffProjectionCompletion?: Promise<unknown> })
			.providerHandoffProjectionCompletion
		expect(
			(
				provider as unknown as {
					providerHandoffProtocol?: { snapshot(): { phase: string; projection: string } }
				}
			).providerHandoffProtocol?.snapshot(),
		).toMatchObject({ phase: "child-running", projection: "synchronized" })
	})

	it("records a clean abort landmark when preparation rejects", async () => {
		const parentTask = makeParentTask()
		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn(),
			prepareProviderHandoffContext: vi.fn().mockRejectedValue(new Error("handoff preparation failed")),
			log: vi.fn(),
			isViewLaunched: false,
			taskHistoryStore: makeStoreStub(),
		})

		await expect(
			ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: "Do something",
				initialTodos: [],
				mode: "code",
			}),
		).rejects.toThrow("handoff preparation failed")

		const protocol = (provider as unknown as { providerHandoffProtocol?: { snapshot(): { phase: string } } })
			.providerHandoffProtocol
		expect(protocol?.snapshot()).toMatchObject({
			phase: "aborted",
			failure: { boundary: "preparation" },
			parentPresence: "current",
			childPresence: "absent",
		})
	})

	it("reconciles a rejected commit as uncommitted and records the resolved abort landmarks", async () => {
		const persistError = new Error("parent metadata persist failed")
		const parentTask = makeParentTask()
		const child = makeChildTask("child-1")

		const getCurrentTask = vi.fn().mockReturnValue(parentTask)
		const createTask = vi.fn().mockImplementation(async () => {
			getCurrentTask.mockReturnValue(child)
			return child
		})

		const taskHistoryStore = makeStoreStub({
			atomicReadAndUpdate: vi.fn().mockRejectedValue(persistError),
		})

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask,
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentHistoryItem }),
			prepareProviderHandoffContext: makePreparationStub(makePreparedHandoff()),
			deleteTaskWithId: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		await expect(
			ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: "Do something",
				initialTodos: [],
				mode: "code",
			}),
		).rejects.toThrow(persistError)

		const protocol = (provider as unknown as { providerHandoffProtocol?: { snapshot(): { phase: string } } })
			.providerHandoffProtocol
		// The strict fresh parent read shows the exact nondelegated preimage
		// (child history absent, as at any real commit boundary), so the
		// rejection is authoritatively uncommitted and the rollback settles.
		expect(protocol?.snapshot()).toMatchObject({
			phase: "aborted",
			commitAttempts: 1,
			failure: { boundary: "delegation-commit", commitDurability: "uncommitted", commitObservation: "unchanged" },
			parentPresence: "restored",
			childPresence: "absent",
			delegation: "none",
			rollbackFailures: [],
		})
		expect(taskHistoryStore.readFresh).toHaveBeenCalledWith("parent-1")
	})

	it("starts the committed child and keeps it current when the post-commit projection fails", async () => {
		const projectionError = new Error("projection failed")
		const parentTask = makeParentTask()
		const child = makeChildTask("child-1")
		const providerEmit = vi.fn()
		const log = vi.fn()

		const taskHistoryStore = makeStoreStub()

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: providerEmit,
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockResolvedValue(child),
			prepareProviderHandoffContext: makePreparationStub(
				makePreparedHandoff({
					apiConfiguration: {
						apiProvider: providerIdentifiers.openrouter,
						openRouterApiKey: SENTINEL_API_KEY,
					},
				}),
			),
			// The real bounded queue: generation bookkeeping must be live for the
			// projection-result fences under test.
			enqueueProviderProfileMutation: ClineProvider.prototype["enqueueProviderProfileMutation"],
			updateGlobalState: vi.fn().mockResolvedValue(undefined),
			contextProxy: { setProviderSettings: vi.fn().mockResolvedValue(undefined) },
			providerSettingsManager: {
				listConfig: vi.fn().mockRejectedValue(projectionError),
				projectHandoffState: vi.fn().mockResolvedValue(undefined),
			},
			log,
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		// The projection failure must not reject the delegation.
		const result = await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})
		await Promise.resolve() // drain scheduler microtask so child.run() is invoked
		// Deterministically await the exposed background-projection hook.
		await (provider as unknown as { providerHandoffProjectionCompletion?: Promise<unknown> })
			.providerHandoffProjectionCompletion

		expect(result).toBe(child)
		// Delegation was committed and announced; the child started.
		expect(taskHistoryStore.atomicReadAndUpdate).toHaveBeenCalledTimes(1)
		expect(providerEmit).toHaveBeenCalledWith(RooCodeEventName.TaskDelegated, "parent-1", "child-1")
		expect(child.run).toHaveBeenCalledTimes(1)
		// The failure was logged redacted — never with the sentinel secret value.
		const logged = log.mock.calls.map((call) => call.join(" ")).join("\n")
		expect(logged).toContain("Post-commit handoff projection failed")
		expect(logged).toContain("projection failed")
		expect(logged).not.toContain(SENTINEL_API_KEY)
		// The prepared context is still authoritative on the child.
		expect(child.adoptHandoffExecutionContext).toHaveBeenCalled()
	})

	it("treats a write-then-reject commit as observed committed and keeps the durable delegation", async () => {
		const persistError = new Error("store rejected after persisting")
		const parentTask = makeParentTask()
		const child = makeChildTask("child-1")
		const providerEmit = vi.fn()
		const deleteTaskWithId = vi.fn()
		const createTaskWithHistoryItem = vi.fn()

		// The store write persisted the delegation, then the store rejected.
		// Production-realistic: the parent task file is durably delegated while
		// the child's own history has not been written yet at all.
		const delegatedParent = { ...parentHistoryItem, status: "delegated", awaitingChildId: "child-1" }
		const taskHistoryStore = makeStoreStub({
			atomicReadAndUpdate: vi.fn(async () => {
				throw persistError
			}),
			readFresh: vi.fn(async (taskId: string) =>
				taskId === "parent-1"
					? { kind: "found" as const, item: delegatedParent }
					: { kind: "missing" as const },
			),
		})

		const getCurrentTask = vi.fn().mockReturnValue(parentTask)
		const createTask = vi.fn().mockImplementation(async () => {
			getCurrentTask.mockReturnValue(child)
			return child
		})

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: providerEmit,
			getCurrentTask,
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			prepareProviderHandoffContext: makePreparationStub(makePreparedHandoff()),
			projectPreparedProviderHandoffState: vi.fn().mockResolvedValue({ ok: true }),
			deleteTaskWithId,
			createTaskWithHistoryItem,
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		const result = await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})
		await Promise.resolve() // drain scheduler microtask so child.run() is invoked

		expect(result).toBe(child)
		// No destructive rollback over the committed lineage.
		expect(deleteTaskWithId).not.toHaveBeenCalled()
		expect(createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(child.run).toHaveBeenCalledTimes(1)
		expect(child.adoptHandoffExecutionContext).toHaveBeenCalled()
		expect(providerEmit).toHaveBeenCalledWith(RooCodeEventName.TaskDelegated, "parent-1", "child-1")
		// The committed child continues despite the missing child history.
		expect(taskHistoryStore.readFresh).toHaveBeenCalledWith("child-1")

		const protocol = (provider as unknown as { providerHandoffProtocol?: { snapshot(): { phase: string } } })
			.providerHandoffProtocol
		expect(protocol?.snapshot()).toMatchObject({
			phase: "child-running",
			delegation: "committed",
			contextAuthority: "child",
			childPresence: "running",
			commitAttempts: 1,
			failure: { boundary: "delegation-commit", commitDurability: "committed" },
		})
	})

	it("observes a reject-before-write commit as uncommitted and rolls back", async () => {
		const persistError = new Error("store rejected before writing")
		const parentTask = makeParentTask()
		const child = makeChildTask("child-1")
		const deleteTaskWithId = vi.fn().mockResolvedValue(undefined)
		const createTaskWithHistoryItem = vi.fn().mockResolvedValue(undefined)
		const activeParent = { ...parentHistoryItem, status: "active" }

		const taskHistoryStore = makeStoreStub({
			atomicReadAndUpdate: vi.fn(async () => {
				// The rejection happened before any persisted write.
				throw persistError
			}),
			// The preimage source (cache) and the strict fresh disk read agree:
			// an active, nondelegated parent record.
			get: vi.fn((taskId: string) => (taskId === "parent-1" ? activeParent : undefined)),
			readFresh: vi.fn(async (taskId: string) =>
				taskId === "parent-1" ? { kind: "found" as const, item: activeParent } : { kind: "missing" as const },
			),
		})

		const getCurrentTask = vi.fn().mockReturnValue(parentTask)
		const createTask = vi.fn().mockImplementation(async () => {
			getCurrentTask.mockReturnValue(child)
			return child
		})

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask,
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentHistoryItem }),
			prepareProviderHandoffContext: makePreparationStub(makePreparedHandoff()),
			deleteTaskWithId,
			createTaskWithHistoryItem,
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		await expect(
			ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: "Do something",
				initialTodos: [],
				mode: "code",
			}),
		).rejects.toThrow(persistError)

		expect(deleteTaskWithId).toHaveBeenCalledWith("child-1", false)
		expect(createTaskWithHistoryItem).toHaveBeenCalledWith(parentHistoryItem, {
			transitionOwner: expect.anything(),
		})
		expect(child.run).not.toHaveBeenCalled()
	})

	it("surfaces a degraded state without destructive rollback when the reconciliation re-read fails", async () => {
		const persistError = new Error("parent metadata persist failed")
		const readFailure = new Error("store unreadable during reconciliation")
		const parentTask = makeParentTask()
		const child = makeChildTask("child-1")
		const deleteTaskWithId = vi.fn()
		const createTaskWithHistoryItem = vi.fn()

		const taskHistoryStore = makeStoreStub({
			atomicReadAndUpdate: vi.fn(async () => {
				throw persistError
			}),
			readFresh: vi.fn().mockRejectedValue(readFailure),
		})

		const getCurrentTask = vi.fn().mockReturnValue(parentTask)
		const createTask = vi.fn().mockImplementation(async () => {
			getCurrentTask.mockReturnValue(child)
			return child
		})

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask,
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			prepareProviderHandoffContext: makePreparationStub(makePreparedHandoff()),
			deleteTaskWithId,
			createTaskWithHistoryItem,
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		const error: unknown = await ClineProvider.prototype.delegateParentAndOpenChild
			.call(provider, {
				parentTaskId: "parent-1",
				message: "Do something",
				initialTodos: [],
				mode: "code",
			})
			.catch((caught: unknown) => caught)

		if (!(error instanceof AggregateError)) {
			throw new Error(`expected an AggregateError, got: ${String(error)}`)
		}
		// The original commit failure is retained first; the unreadable-parent
		// observation follows. A strict-read failure is incoherent, never
		// collapsed into "missing".
		expect(error.errors).toEqual([persistError, readFailure])
		expect(error.message).toContain("durability could not be determined")

		// Nothing was destructively rolled back: the child stays paused and
		// the parent record is never restored over potentially committed lineage.
		expect(deleteTaskWithId).not.toHaveBeenCalled()
		expect(createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(child.run).not.toHaveBeenCalled()

		const protocol = (provider as unknown as { providerHandoffProtocol?: { snapshot(): { phase: string } } })
			.providerHandoffProtocol
		expect(protocol?.snapshot()).toMatchObject({
			phase: "degraded-abort",
			childPresence: "paused",
			parentPresence: "removed",
			delegation: "none",
			commitAttempts: 1,
			failure: { boundary: "delegation-commit", commitDurability: "incoherent" },
		})
	})

	it("keeps the paused child and avoids rollback when the child lineage does not match", async () => {
		const persistError = new Error("parent metadata persist failed")
		const parentTask = makeParentTask()
		const child = makeChildTask("child-1")
		const deleteTaskWithId = vi.fn()
		const createTaskWithHistoryItem = vi.fn()

		// The parent record claims this exact child, but the child record that
		// exists contradicts the lineage: durability is unknowable and the
		// reconciliation must be non-destructive.
		const delegatedParent = { ...parentHistoryItem, status: "delegated", awaitingChildId: "child-1" }
		const contradictoryChild = { ...parentHistoryItem, id: "child-1", parentTaskId: "other-parent" }
		const taskHistoryStore = makeStoreStub({
			atomicReadAndUpdate: vi.fn(async () => {
				throw persistError
			}),
			readFresh: vi.fn(async (taskId: string) => {
				if (taskId === "parent-1") return { kind: "found" as const, item: delegatedParent }
				if (taskId === "child-1") return { kind: "found" as const, item: contradictoryChild }
				return { kind: "missing" as const }
			}),
		})

		const getCurrentTask = vi.fn().mockReturnValue(parentTask)
		const createTask = vi.fn().mockImplementation(async () => {
			getCurrentTask.mockReturnValue(child)
			return child
		})

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask,
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			prepareProviderHandoffContext: makePreparationStub(makePreparedHandoff()),
			deleteTaskWithId,
			createTaskWithHistoryItem,
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		await expect(
			ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: "Do something",
				initialTodos: [],
				mode: "code",
			}),
		).rejects.toThrow(AggregateError)

		expect(deleteTaskWithId).not.toHaveBeenCalled()
		expect(createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(child.run).not.toHaveBeenCalled()

		const protocol = (provider as unknown as { providerHandoffProtocol?: { snapshot(): { phase: string } } })
			.providerHandoffProtocol
		expect(protocol?.snapshot()).toMatchObject({
			phase: "degraded-abort",
			childPresence: "paused",
			parentPresence: "removed",
			failure: {
				boundary: "delegation-commit",
				commitDurability: "incoherent",
				commitObservation: "contradictory-child",
			},
		})
	})

	it("keeps the paused child when the parent record shows a delegation to another child", async () => {
		const persistError = new Error("parent metadata persist failed")
		const parentTask = makeParentTask()
		const child = makeChildTask("child-1")
		const deleteTaskWithId = vi.fn()
		const createTaskWithHistoryItem = vi.fn()

		// Another writer delegated the parent to a different child: rolling
		// back would destroy someone else's committed lineage.
		const otherDelegation = { ...parentHistoryItem, status: "delegated", awaitingChildId: "child-other" }
		const taskHistoryStore = makeStoreStub({
			atomicReadAndUpdate: vi.fn(async () => {
				throw persistError
			}),
			readFresh: vi.fn(async (taskId: string) =>
				taskId === "parent-1"
					? { kind: "found" as const, item: otherDelegation }
					: { kind: "missing" as const },
			),
		})

		const getCurrentTask = vi.fn().mockReturnValue(parentTask)
		const createTask = vi.fn().mockImplementation(async () => {
			getCurrentTask.mockReturnValue(child)
			return child
		})

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask,
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			prepareProviderHandoffContext: makePreparationStub(makePreparedHandoff()),
			deleteTaskWithId,
			createTaskWithHistoryItem,
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		await expect(
			ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: "Do something",
				initialTodos: [],
				mode: "code",
			}),
		).rejects.toThrow(AggregateError)

		expect(deleteTaskWithId).not.toHaveBeenCalled()
		expect(createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(child.run).not.toHaveBeenCalled()

		const protocol = (provider as unknown as { providerHandoffProtocol?: { snapshot(): { phase: string } } })
			.providerHandoffProtocol
		expect(protocol?.snapshot()).toMatchObject({
			phase: "degraded-abort",
			failure: {
				boundary: "delegation-commit",
				commitDurability: "incoherent",
				commitObservation: "other-child",
			},
		})
	})

	it("keeps the paused child when the parent record drifted from the safe nondelegated preimage", async () => {
		const persistError = new Error("parent metadata persist failed")
		const parentTask = makeParentTask()
		const child = makeChildTask("child-1")
		const deleteTaskWithId = vi.fn()
		const createTaskWithHistoryItem = vi.fn()

		// The parent is non-delegated but no longer matches the preimage that
		// was captured before the commit attempt (a new childIds entry appeared
		// from another writer): durability is unknowable, so no rollback.
		const driftedParent = { ...parentHistoryItem, status: "active", childIds: ["unrelated-child"] }
		const taskHistoryStore = makeStoreStub({
			atomicReadAndUpdate: vi.fn(async () => {
				throw persistError
			}),
			readFresh: vi.fn(async (taskId: string) =>
				taskId === "parent-1" ? { kind: "found" as const, item: driftedParent } : { kind: "missing" as const },
			),
		})

		const getCurrentTask = vi.fn().mockReturnValue(parentTask)
		const createTask = vi.fn().mockImplementation(async () => {
			getCurrentTask.mockReturnValue(child)
			return child
		})

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask,
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			prepareProviderHandoffContext: makePreparationStub(makePreparedHandoff()),
			deleteTaskWithId,
			createTaskWithHistoryItem,
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		await expect(
			ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: "Do something",
				initialTodos: [],
				mode: "code",
			}),
		).rejects.toThrow(AggregateError)

		expect(deleteTaskWithId).not.toHaveBeenCalled()
		expect(createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(child.run).not.toHaveBeenCalled()

		const protocol = (provider as unknown as { providerHandoffProtocol?: { snapshot(): { phase: string } } })
			.providerHandoffProtocol
		expect(protocol?.snapshot()).toMatchObject({
			phase: "degraded-abort",
			failure: {
				boundary: "delegation-commit",
				commitDurability: "incoherent",
				commitObservation: "drifted",
			},
		})
	})

	it("treats a delegated parent with missing child history as committed and continues the child", async () => {
		const persistError = new Error("store rejected after persisting")
		const parentTask = makeParentTask()
		const child = makeChildTask("child-1")
		const providerEmit = vi.fn()

		// The rejected write persisted the exact parent delegation; the child
		// record is absent — expected at the commit boundary, and the parent
		// record alone is authoritative for the committed observation.
		const delegatedParent = { ...parentHistoryItem, status: "delegated", awaitingChildId: "child-1" }
		const taskHistoryStore = makeStoreStub({
			atomicReadAndUpdate: vi.fn(async () => {
				throw persistError
			}),
			readFresh: vi.fn(async (taskId: string) =>
				taskId === "parent-1"
					? { kind: "found" as const, item: delegatedParent }
					: { kind: "missing" as const },
			),
		})

		const getCurrentTask = vi.fn().mockReturnValue(parentTask)
		const createTask = vi.fn().mockImplementation(async () => {
			getCurrentTask.mockReturnValue(child)
			return child
		})

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: providerEmit,
			getCurrentTask,
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			prepareProviderHandoffContext: makePreparationStub(makePreparedHandoff()),
			projectPreparedProviderHandoffState: vi.fn().mockResolvedValue({ ok: true }),
			deleteTaskWithId: vi.fn(),
			createTaskWithHistoryItem: vi.fn(),
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		const result = await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})
		await (provider as unknown as { providerHandoffProjectionCompletion?: Promise<unknown> })
			.providerHandoffProjectionCompletion

		expect(result).toBe(child)
		expect(child.run).toHaveBeenCalledTimes(1)
		expect(providerEmit).toHaveBeenCalledWith(RooCodeEventName.TaskDelegated, "parent-1", "child-1")

		const protocol = (provider as unknown as { providerHandoffProtocol?: { snapshot(): { phase: string } } })
			.providerHandoffProtocol
		expect(protocol?.snapshot()).toMatchObject({
			phase: "child-running",
			delegation: "committed",
			failure: {
				boundary: "delegation-commit",
				commitDurability: "committed",
				commitObservation: "exact",
			},
		})
	})

	it("keeps the paused child when the strict parent read reports an unreadable record", async () => {
		const persistError = new Error("parent metadata persist failed")
		const parseFailure = new Error("parent task file is not valid JSON")
		const parentTask = makeParentTask()
		const child = makeChildTask("child-1")
		const deleteTaskWithId = vi.fn()
		const createTaskWithHistoryItem = vi.fn()

		// The strict read distinguishes an unreadable parent record from a
		// definitively missing one: unreadable is incoherent, not uncommitted.
		const taskHistoryStore = makeStoreStub({
			atomicReadAndUpdate: vi.fn(async () => {
				throw persistError
			}),
			readFresh: vi.fn(async () => ({ kind: "error" as const, reason: "parse" as const, error: parseFailure })),
		})

		const getCurrentTask = vi.fn().mockReturnValue(parentTask)
		const createTask = vi.fn().mockImplementation(async () => {
			getCurrentTask.mockReturnValue(child)
			return child
		})

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask,
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			prepareProviderHandoffContext: makePreparationStub(makePreparedHandoff()),
			deleteTaskWithId,
			createTaskWithHistoryItem,
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		const error: unknown = await ClineProvider.prototype.delegateParentAndOpenChild
			.call(provider, {
				parentTaskId: "parent-1",
				message: "Do something",
				initialTodos: [],
				mode: "code",
			})
			.catch((caught: unknown) => caught)

		if (!(error instanceof AggregateError)) {
			throw new Error(`expected an AggregateError, got: ${String(error)}`)
		}
		expect(error.errors).toEqual([persistError, parseFailure])
		expect(deleteTaskWithId).not.toHaveBeenCalled()
		expect(createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(child.run).not.toHaveBeenCalled()

		const protocol = (provider as unknown as { providerHandoffProtocol?: { snapshot(): { phase: string } } })
			.providerHandoffProtocol
		expect(protocol?.snapshot()).toMatchObject({
			phase: "degraded-abort",
			childPresence: "paused",
			failure: { boundary: "delegation-commit", commitDurability: "incoherent", commitObservation: "unreadable" },
		})
	})

	it("starts the child after the delegation and lets the projection fail afterwards", async () => {
		const parentTask = makeParentTask()
		const child = makeChildTask("child-1")
		const log = vi.fn()
		const projectionError = new Error("boom-listConfig-provider-detail")

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockResolvedValue(child),
			prepareProviderHandoffContext: makePreparationStub(makePreparedHandoff()),
			enqueueProviderProfileMutation: ClineProvider.prototype["enqueueProviderProfileMutation"],
			updateGlobalState: vi.fn().mockResolvedValue(undefined),
			contextProxy: { setProviderSettings: vi.fn().mockResolvedValue(undefined) },
			providerSettingsManager: {
				listConfig: vi.fn().mockRejectedValue(projectionError),
				projectHandoffState: vi.fn().mockResolvedValue(undefined),
			},
			log,
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore: makeStoreStub(),
		})

		await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})
		await (provider as unknown as { providerHandoffProjectionCompletion?: Promise<unknown> })
			.providerHandoffProjectionCompletion

		// The child started even though the background projection failed, and
		// the failure was logged as a stable boundary/category — never with
		// provider-originated error text or the sentinel secret.
		expect(child.run).toHaveBeenCalledTimes(1)
		const logged = log.mock.calls.map((call) => call.join(" ")).join("\n")
		expect(logged).toContain("Post-commit handoff projection failed")
		expect(logged).toContain("profile-meta-read (Error)")
		// The provider-originated message text is never interpolated.
		expect(logged).not.toContain("boom-listConfig-provider-detail")
		expect(logged).not.toContain(SENTINEL_API_KEY)
	})

	it("performs zero writes when a queued projection is cancelled before it starts", async () => {
		vi.useFakeTimers()
		try {
			const provider = makeProviderStub({ log: vi.fn() })
			// First operation starts immediately and hangs: it owns the queue
			// tail even past its timeout (non-cancellable underlying write).
			let releaseFirst!: () => void
			const firstGate = new Promise<void>((resolve) => {
				releaseFirst = resolve
			})
			const firstWrite = vi.fn(() => firstGate)
			const secondWrite = vi.fn(async () => "second")
			const thirdWrite = vi.fn(async () => "third")

			const first = ClineProvider.prototype["enqueueProviderProfileMutation"].call(provider, firstWrite)
			const second = ClineProvider.prototype["enqueueProviderProfileMutation"].call(provider, secondWrite)
			const firstOutcome = first.then(
				() => "resolved",
				(error: unknown) => (error as Error).message as string,
			)
			const secondOutcome = second.then(
				() => "resolved",
				(error: unknown) => (error as Error).message as string,
			)

			await vi.advanceTimersByTimeAsync(ClineProvider.PENDING_OPERATION_TIMEOUT_MS + 1)

			// Both callers are released at the bounded timeout...
			expect(await firstOutcome).toContain("timed out")
			expect(await secondOutcome).toContain("timed out")
			// ...but the second was cancelled BEFORE it started: zero writes.
			expect(firstWrite).toHaveBeenCalledTimes(1)
			expect(secondWrite).not.toHaveBeenCalled()

			// A newer write (fresh timeout window) still cannot overtake the
			// started, hung first write: the admission-aborted second did not
			// release the queue past the first operation's owned tail.
			const third = ClineProvider.prototype["enqueueProviderProfileMutation"].call(provider, thirdWrite)
			await vi.advanceTimersByTimeAsync(1)
			expect(thirdWrite).not.toHaveBeenCalled()

			// Once the started write settles, the queue it owns advances — and
			// the admission-aborted second callback is skipped without running.
			releaseFirst()
			await vi.advanceTimersByTimeAsync(0)
			expect(secondWrite).not.toHaveBeenCalled()
			expect(thirdWrite).toHaveBeenCalledTimes(1)
			await expect(third).resolves.toBe("third")
		} finally {
			vi.useRealTimers()
		}
	})

	it("serializes a newer mutation behind a started hung write even after the caller times out", async () => {
		vi.useFakeTimers()
		try {
			const provider = makeProviderStub({ log: vi.fn() })
			let releaseFirst!: () => void
			const firstGate = new Promise<void>((resolve) => {
				releaseFirst = resolve
			})
			const firstWrite = vi.fn(async () => {
				await firstGate
				return "first"
			})
			const secondWrite = vi.fn(async () => "second")

			const first = ClineProvider.prototype["enqueueProviderProfileMutation"].call(provider, firstWrite)
			// Attach the outcome mapping before the timer can fire so the
			// rejection always has a handler.
			const firstOutcome = first.then(
				() => "resolved",
				(error: unknown) => String(error),
			)

			await vi.advanceTimersByTimeAsync(ClineProvider.PENDING_OPERATION_TIMEOUT_MS + 1)

			// The timed-out caller is released...
			await expect(firstOutcome).resolves.toContain("timed out")

			// ...but the queue tail stays owned by the started write. A newer
			// mutation enqueued afterwards is not admitted and cannot overtake it.
			const second = ClineProvider.prototype["enqueueProviderProfileMutation"].call(provider, secondWrite)
			expect(firstWrite).toHaveBeenCalledTimes(1)
			await vi.advanceTimersByTimeAsync(1)
			expect(secondWrite).not.toHaveBeenCalled()

			releaseFirst()
			await vi.advanceTimersByTimeAsync(0)
			// Only after the underlying write settles does the newer mutation run.
			expect(secondWrite).toHaveBeenCalledTimes(1)
			await expect(second).resolves.toBe("second")
		} finally {
			vi.useRealTimers()
		}
	})

	it("serializes two same-parent delegations so the second observes the committed delegation", async () => {
		const parentTask = makeParentTask()
		const firstChild = makeChildTask("child-1")
		const deleteTaskWithId = vi.fn()

		let releaseCommit!: () => void
		const commitGate = new Promise<void>((resolve) => {
			releaseCommit = resolve
		})
		const taskHistoryStore = makeStoreStub({
			atomicReadAndUpdate: vi.fn(async (_taskId: string, updater: (h: HistoryItem) => HistoryItem) => {
				await commitGate
				updater(parentHistoryItem)
				return []
			}),
		})

		let currentTask: unknown = parentTask
		const getCurrentTask = vi.fn(() => currentTask)
		const createTask = vi.fn().mockImplementation(async () => {
			currentTask = firstChild
			return firstChild
		})

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask,
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			prepareProviderHandoffContext: makePreparationStub(makePreparedHandoff()),
			projectPreparedProviderHandoffState: vi.fn().mockResolvedValue({ ok: true }),
			deleteTaskWithId,
			createTaskWithHistoryItem: vi.fn(),
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		const first = ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "First",
			initialTodos: [],
			mode: "code",
		})
		const second = ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Second",
			initialTodos: [],
			mode: "code",
		})

		// The first delegation holds the per-parent transition lock at the
		// commit; the second must not have started any side effects yet.
		for (let i = 0; i < 25; i++) {
			await Promise.resolve()
		}
		expect(createTask).toHaveBeenCalledTimes(1)

		releaseCommit()
		await first

		// The queued second call observes the child as current and can neither
		// re-delegate nor remove the first delegation's child.
		await expect(second).rejects.toThrow(/Parent mismatch/)
		expect(createTask).toHaveBeenCalledTimes(1)
		expect(deleteTaskWithId).not.toHaveBeenCalled()
	})

	it("holds the per-parent lock so a completion cannot interleave with an in-flight delegation", async () => {
		const parentTask = makeParentTask()
		const child = makeChildTask("child-1")
		const order: string[] = []

		let releaseCommit!: () => void
		const commitGate = new Promise<void>((resolve) => {
			releaseCommit = resolve
		})
		const records = new Map<string, HistoryItem>([["parent-1", { ...parentHistoryItem }]])
		const taskHistoryStore = makeStoreStub({
			atomicReadAndUpdate: vi.fn(async (_taskId: string, updater: (h: HistoryItem) => HistoryItem) => {
				await commitGate
				records.set("parent-1", updater(structuredClone(records.get("parent-1")!)))
				order.push("committed")
				return []
			}),
			get: vi.fn((taskId: string) => records.get(taskId)),
		})
		const getTaskWithId = vi.fn(async (id: string) => {
			order.push(`read:${id}`)
			return { historyItem: records.get(id) }
		})

		let currentTask: unknown = parentTask
		const getCurrentTask = vi.fn(() => currentTask)
		const createTask = vi.fn().mockImplementation(async () => {
			currentTask = child
			return child
		})

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask,
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			getTaskWithId,
			prepareProviderHandoffContext: makePreparationStub(makePreparedHandoff()),
			projectPreparedProviderHandoffState: vi.fn().mockResolvedValue({ ok: true }),
			deleteTaskWithId: vi.fn(),
			createTaskWithHistoryItem: vi.fn(),
			contextProxy: { globalStorageUri: { fsPath: "/test/global-storage" } },
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		const delegation = ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "First",
			initialTodos: [],
			mode: "code",
		})
		// A completion for a different child starts while the delegation is
		// mid-transition; it must wait for the lock and then be rejected by the
		// delegation-ownership guard, never interleaving with the commit.
		const completion = ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
			parentTaskId: "parent-1",
			childTaskId: "child-other",
			completionResultSummary: "done",
		})

		for (let i = 0; i < 25; i++) {
			await Promise.resolve()
		}
		expect(order).toEqual([])

		releaseCommit()
		await delegation
		expect(await completion).toBe(false)
		// The completion's store read happened only after the delegation committed.
		expect(order[0]).toBe("committed")
		expect(order[1]).toBe("read:parent-1")
	})

	it("starts the child after a timed-out projection and ignores the late completion", async () => {
		vi.useFakeTimers()
		try {
			const parentTask = makeParentTask()
			const child = makeChildTask("child-1")
			const providerEmit = vi.fn()
			let releaseWrite!: () => void
			const writeGate = new Promise<void>((resolve) => {
				releaseWrite = resolve
			})
			const log = vi.fn()

			const provider = makeProviderStub({
				taskScheduler: new TaskScheduler(),
				emit: providerEmit,
				getCurrentTask: vi.fn(() => parentTask),
				removeClineFromStack: vi.fn().mockResolvedValue(undefined),
				createTask: vi.fn().mockResolvedValue(child),
				prepareProviderHandoffContext: makePreparationStub(makePreparedHandoff()),
				// Real projection on the real bounded queue: the first legacy
				// write hangs and ignores the abort, so only the timeout can
				// release the queue and let the delegation continue.
				enqueueProviderProfileMutation: ClineProvider.prototype["enqueueProviderProfileMutation"],
				updateGlobalState: vi.fn(() => writeGate),
				contextProxy: { setProviderSettings: vi.fn().mockResolvedValue(undefined) },
				providerSettingsManager: {
					listConfig: vi.fn().mockResolvedValue([]),
					projectHandoffState: vi.fn().mockResolvedValue(undefined),
				},
				log,
				isViewLaunched: false,
				recentTasksCache: undefined,
				taskHistoryStore: makeStoreStub(),
			})

			const delegation = ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: "Do something",
				initialTodos: [],
				mode: "code",
			})

			// The delegation resolves without awaiting the projection at all:
			// the child starts immediately, before any timeout fires.
			await expect(delegation).resolves.toBe(child)
			expect(child.run).toHaveBeenCalledTimes(1)
			expect(
				(provider as unknown as { staleProviderHandoffProjection?: unknown }).staleProviderHandoffProjection,
			).toBeUndefined()

			await vi.advanceTimersByTimeAsync(ClineProvider.PENDING_OPERATION_TIMEOUT_MS + 1)
			// The bounded queue released the caller at the timeout while the
			// started write stayed owned; the abandoned projection stamped the
			// generation-fenced stale marker.
			const marker = (provider as unknown as { staleProviderHandoffProjection?: { requestedMode: string } })
				.staleProviderHandoffProjection
			expect(marker).toMatchObject({ requestedMode: "code" })

			// The hung write eventually settles — the late completion is
			// inert: it neither clears the marker nor emits a mode change.
			releaseWrite()
			await (provider as unknown as { providerHandoffProjectionCompletion?: Promise<unknown> })
				.providerHandoffProjectionCompletion
			await vi.advanceTimersByTimeAsync(0)
			const markerAfterLateCompletion = (
				provider as unknown as { staleProviderHandoffProjection?: { requestedMode: string } }
			).staleProviderHandoffProjection
			expect(markerAfterLateCompletion).toMatchObject({ requestedMode: "code" })
			expect(providerEmit).not.toHaveBeenCalledWith(RooCodeEventName.ModeChanged, "code")
			const logged = log.mock.calls.map((call) => call.join(" ")).join("\n")
			expect(logged).toContain("completed after cancellation")
		} finally {
			vi.useRealTimers()
		}
	})

	it("supersedes a stale projection marker when a later profile mutation succeeds", async () => {
		const parentTask = makeParentTask()
		const child = makeChildTask("child-1")
		const projectionError = new Error("listConfig failed")

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockResolvedValue(child),
			prepareProviderHandoffContext: makePreparationStub(makePreparedHandoff()),
			enqueueProviderProfileMutation: ClineProvider.prototype["enqueueProviderProfileMutation"],
			updateGlobalState: vi.fn().mockResolvedValue(undefined),
			contextProxy: { setProviderSettings: vi.fn().mockResolvedValue(undefined) },
			providerSettingsManager: {
				listConfig: vi.fn().mockRejectedValue(projectionError),
				projectHandoffState: vi.fn().mockResolvedValue(undefined),
			},
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore: makeStoreStub(),
		})

		await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})
		await (provider as unknown as { providerHandoffProjectionCompletion?: Promise<unknown> })
			.providerHandoffProjectionCompletion

		const providerState = provider as unknown as {
			staleProviderHandoffProjection?: { requestedMode: string; generation: number }
			providerProfileMutationSettledGeneration: number
		}
		expect(providerState.staleProviderHandoffProjection).toMatchObject({ requestedMode: "code" })
		const markerGeneration = providerState.staleProviderHandoffProjection?.generation

		// Any later successful mode/profile mutation on the queue — the same
		// path a user-driven mode or profile switch takes — supersedes the
		// stale marker through the generation fence.
		await ClineProvider.prototype["enqueueProviderProfileMutation"].call(provider, async () => undefined)

		expect(providerState.staleProviderHandoffProjection).toBeUndefined()
		expect(providerState.providerProfileMutationSettledGeneration).toBeGreaterThan(markerGeneration ?? 0)
	})

	it("completes same-parent restoration under a held lock with exactly one interruption (no deadlock)", async () => {
		const activeChildHistory = {
			...parentHistoryItem,
			id: "child-1",
			status: "active",
			parentTaskId: "parent-1",
		} as unknown as HistoryItem
		const childTask = { taskId: "child-1" }
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const updateTaskHistory = vi.fn().mockResolvedValue(undefined)
		const postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		const getTaskWithId = vi.fn(async (taskId: string) => ({
			historyItem:
				taskId === "parent-1"
					? { ...parentHistoryItem, status: "delegated", awaitingChildId: "child-1" }
					: activeChildHistory,
		}))

		const provider = makeProviderStub({
			log: vi.fn(),
			getCurrentTask: vi.fn(() => childTask),
			removeClineFromStack,
			updateTaskHistory,
			postMessageToWebview,
			getTaskWithId,
			taskHistoryStore: makeStoreStub({
				get: vi.fn((taskId: string) => (taskId === "child-1" ? activeChildHistory : undefined)),
			}),
		})

		// Restoration under the already-held parent lock: the restoration path
		// evicts the current active persisted child of the SAME parent, whose
		// interruption must run the unlocked core instead of re-acquiring the
		// lock the caller owns. Before the transition-owner token this test
		// deadlocked until the test timeout — completion at all is the proof.
		const held = ClineProvider.prototype["runDelegationTransition"].call(
			provider,
			"parent-1",
			async (owner: symbol) => {
				// What createTaskWithHistoryItem(..., { transitionOwner }) does
				// before installing the restored parent: evict the current task.
				await ClineProvider.prototype.evictCurrentTask.call(provider, owner)
				return "restored"
			},
		)

		expect(await held).toBe("restored")

		// Exactly one interruption was recorded for the evicted child.
		expect(updateTaskHistory).toHaveBeenCalledTimes(1)
		expect(vi.mocked(updateTaskHistory).mock.calls[0][0]).toMatchObject({
			id: "child-1",
			status: "interrupted",
		})
	})

	it("serializes ordinary external eviction behind a held parent lock", async () => {
		const activeChildHistory = {
			...parentHistoryItem,
			id: "child-1",
			status: "active",
			parentTaskId: "parent-1",
		} as unknown as HistoryItem
		const childTask = { taskId: "child-1" }
		const updateTaskHistory = vi.fn().mockResolvedValue(undefined)
		const postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		const getTaskWithId = vi.fn(async (taskId: string) => ({
			historyItem:
				taskId === "parent-1"
					? { ...parentHistoryItem, status: "delegated", awaitingChildId: "child-1" }
					: activeChildHistory,
		}))

		const provider = makeProviderStub({
			log: vi.fn(),
			getCurrentTask: vi.fn(() => childTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			updateTaskHistory,
			postMessageToWebview,
			getTaskWithId,
			taskHistoryStore: makeStoreStub({
				get: vi.fn((taskId: string) => (taskId === "child-1" ? activeChildHistory : undefined)),
			}),
		})

		let releaseHeld!: () => void
		const heldGate = new Promise<void>((resolve) => {
			releaseHeld = resolve
		})
		const held = ClineProvider.prototype["runDelegationTransition"].call(provider, "parent-1", () => heldGate)

		// An external eviction without a transition owner must NOT run the
		// interruption under the held lock: it waits for ordinary serialization.
		const external = ClineProvider.prototype.evictCurrentTask.call(provider)
		let settled = false
		void external.then(() => {
			settled = true
		})
		for (let i = 0; i < 25; i++) {
			await Promise.resolve()
		}
		expect(updateTaskHistory).not.toHaveBeenCalled()
		expect(settled).toBe(false)

		releaseHeld()
		await held
		await external
		expect(settled).toBe(true)
		expect(updateTaskHistory).toHaveBeenCalledTimes(1)
	})

	it("yields child undefined and clears projections for a no-profile handoff", async () => {
		const parentTask = makeParentTask()
		const child = makeChildTask("child-1")
		const updateGlobalState = vi.fn().mockResolvedValue(undefined)
		const projectHandoffState = vi.fn().mockResolvedValue(undefined)

		// No current profile anywhere: the prepared profile has no name, which
		// is an explicit clear — never a skipped write.
		const prepared = createPreparedProviderHandoffContext({
			requestedMode: "code",
			profile: { source: "unsaved-current", name: undefined, id: undefined },
			apiConfiguration: { apiProvider: providerIdentifiers.openrouter },
			persistModeProfileId: undefined,
		})

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockResolvedValue(child),
			prepareProviderHandoffContext: vi.fn().mockResolvedValue(prepared),
			// The real bounded queue: generation bookkeeping must be live for the
			// projection-result fences under test.
			enqueueProviderProfileMutation: ClineProvider.prototype["enqueueProviderProfileMutation"],
			updateGlobalState,
			contextProxy: { setProviderSettings: vi.fn().mockResolvedValue(undefined) },
			providerSettingsManager: {
				listConfig: vi.fn().mockResolvedValue([]),
				projectHandoffState,
			},
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore: makeStoreStub(),
		})

		await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})
		await (provider as unknown as { providerHandoffProjectionCompletion?: Promise<unknown> })
			.providerHandoffProjectionCompletion

		// The child is adopted with an explicitly undefined sticky profile.
		expect(child.adoptHandoffExecutionContext).toHaveBeenCalledWith({
			mode: "code",
			apiConfigName: undefined,
			apiConfiguration: expect.anything(),
		})
		// The clear is written, not skipped: the legacy global identity is
		// explicitly set to undefined and the durable store clears its identity.
		expect(updateGlobalState).toHaveBeenCalledWith("currentApiConfigName", undefined)
		expect(projectHandoffState).toHaveBeenCalledWith({
			intent: { kind: "clear" },
			mode: "code",
			modeConfigId: undefined,
		})
		// The explicit clear stays in force for this child's publication.
		await expect(ClineProvider.prototype["isExplicitProfileClearInForce"].call(provider, "child-1")).resolves.toBe(
			true,
		)
	})

	it("publishes undefined for a stale cleared projection instead of the default fallback", async () => {
		const prepared = createPreparedProviderHandoffContext({
			requestedMode: "code",
			profile: { source: "unsaved-current", name: undefined, id: undefined },
			apiConfiguration: { apiProvider: providerIdentifiers.openrouter },
		})
		const provider = makeProviderStub({
			log: vi.fn(),
			staleProviderHandoffProjection: {
				childTaskId: "child-1",
				requestedMode: prepared.requestedMode,
				apiConfigName: undefined,
				profileIntent: prepared.profile.intent,
				apiConfiguration: structuredClone(prepared.apiConfiguration),
				generation: 3,
			},
			providerProfileMutationSettledGeneration: 0,
		})

		await expect(ClineProvider.prototype["isExplicitProfileClearInForce"].call(provider, "child-1")).resolves.toBe(
			true,
		)
		// A different child is not covered by the stale clear.
		await expect(
			ClineProvider.prototype["isExplicitProfileClearInForce"].call(provider, "child-other"),
		).resolves.toBe(false)
	})

	it("never invokes a queued callback whose caller timed out, even after the earlier write settles", async () => {
		vi.useFakeTimers()
		try {
			const providerEmit = vi.fn()
			const provider = makeProviderStub({ log: vi.fn(), emit: providerEmit })
			let releaseFirst!: () => void
			const firstGate = new Promise<void>((resolve) => {
				releaseFirst = resolve
			})
			// The first operation starts immediately and hangs past its timeout:
			// it owns the queue tail the whole time.
			const firstWrite = vi.fn(() => firstGate)
			// The second operation is queued behind it when the timeout fires.
			// A callback like this one that ignores its own signal is exactly
			// the case the central admission fence must stop: fn itself would
			// have written without ever checking the signal.
			const secondWrite = vi.fn(async () => "second")

			const first = ClineProvider.prototype["enqueueProviderProfileMutation"].call(provider, firstWrite)
			const second = ClineProvider.prototype["enqueueProviderProfileMutation"].call(provider, secondWrite)
			const firstOutcome = first.then(
				() => "resolved",
				(error: unknown) => (error as Error).message,
			)
			const secondOutcome = second.then(
				() => "resolved",
				(error: unknown) => (error as Error).message,
			)

			await vi.advanceTimersByTimeAsync(ClineProvider.PENDING_OPERATION_TIMEOUT_MS + 1)
			expect(await firstOutcome).toContain("timed out")
			expect(await secondOutcome).toContain("timed out")
			expect(firstWrite).toHaveBeenCalledTimes(1)
			expect(secondWrite).not.toHaveBeenCalled()

			// Releasing the earlier operation admits the queue head: the
			// cancelled callback is rejected at admission and fn never runs —
			// no storage write and no event can originate from it.
			releaseFirst()
			await vi.advanceTimersByTimeAsync(0)
			expect(secondWrite).not.toHaveBeenCalled()

			const providerState = provider as unknown as { providerProfileMutationSettledGeneration: number }
			expect(providerState.providerProfileMutationSettledGeneration).toBe(0)
			expect(providerEmit).not.toHaveBeenCalled()

			// The queue itself stays live: a later mutation is admitted.
			const thirdWrite = vi.fn(async () => "third")
			const third = ClineProvider.prototype["enqueueProviderProfileMutation"].call(provider, thirdWrite)
			await vi.advanceTimersByTimeAsync(1)
			expect(thirdWrite).toHaveBeenCalledTimes(1)
			await expect(third).resolves.toBe("third")
		} finally {
			vi.useRealTimers()
		}
	})

	it("provider disposal cancels queued-not-started mutations and rejects new work", async () => {
		vi.useFakeTimers()
		try {
			const provider = makeProviderStub({ log: vi.fn() })
			let releaseFirst!: () => void
			const firstGate = new Promise<void>((resolve) => {
				releaseFirst = resolve
			})
			const startedWrite = vi.fn(() => firstGate)
			const queuedWrite = vi.fn(async () => "queued")

			const started = ClineProvider.prototype["enqueueProviderProfileMutation"].call(provider, startedWrite)
			const queued = ClineProvider.prototype["enqueueProviderProfileMutation"].call(provider, queuedWrite)
			const startedOutcome = started.then(
				() => "resolved",
				(error: unknown) => (error as Error).message,
			)
			const queuedOutcome = queued.then(
				() => "resolved",
				(error: unknown) => (error as Error).message,
			)

			// Let the queue admit (start) the first write and keep the second
			// queued behind it.
			await vi.advanceTimersByTimeAsync(0)

			// Dispose while one write is started-and-hung and one is queued.
			// Disposal returns only at the bounded drain deadline.
			const disposed = ClineProvider.prototype["disposeProviderProfileMutationQueue"].call(provider)
			await vi.advanceTimersByTimeAsync(5001)
			await disposed

			expect(startedWrite).toHaveBeenCalledTimes(1)
			// The queued callback was cancelled at admission and never starts —
			// even after the started write settles.
			expect(queuedWrite).not.toHaveBeenCalled()
			releaseFirst()
			await vi.advanceTimersByTimeAsync(0)
			expect(queuedWrite).not.toHaveBeenCalled()
			expect(await queuedOutcome).toContain("cancelled before admission")
			await expect(startedOutcome).resolves.toBe("resolved")

			// No new work is admitted after disposal.
			await expect(
				ClineProvider.prototype["enqueueProviderProfileMutation"].call(provider, async () => "late"),
			).rejects.toThrow("provider is disposed")
		} finally {
			vi.useRealTimers()
		}
	})

	it("provider disposal bounds the drain of a started write and keeps late completions inert", async () => {
		vi.useFakeTimers()
		try {
			const providerEmit = vi.fn()
			const provider = makeProviderStub({
				log: vi.fn(),
				emit: providerEmit,
				staleProviderHandoffProjection: {
					childTaskId: "child-1",
					requestedMode: "code",
					apiConfigName: "profile-1",
					profileIntent: { kind: "set", name: "profile-1" },
					apiConfiguration: {},
					generation: 1,
				},
			})
			let releaseWrite!: () => void
			const writeGate = new Promise<void>((resolve) => {
				releaseWrite = resolve
			})
			const write = vi.fn(() => writeGate)
			const op = ClineProvider.prototype["enqueueProviderProfileMutation"].call(provider, write)
			const outcome = op.then(
				() => "resolved",
				(error: unknown) => (error as Error).message,
			)

			// Let the queue admit (start) the write.
			await vi.advanceTimersByTimeAsync(0)

			// Dispose while the write is started and hung: disposal must return
			// at the bounded deadline instead of awaiting the write forever.
			const disposed = ClineProvider.prototype["disposeProviderProfileMutationQueue"].call(provider)
			await vi.advanceTimersByTimeAsync(5001)
			await disposed
			expect(write).toHaveBeenCalledTimes(1)

			// The write settles after disposal: its completion is inert — no
			// marker supersession, no settled-generation advance, no events.
			releaseWrite()
			await vi.advanceTimersByTimeAsync(0)
			await expect(outcome).resolves.toBe("resolved")
			const providerState = provider as unknown as {
				providerProfileMutationSettledGeneration: number
				staleProviderHandoffProjection?: { requestedMode: string }
			}
			expect(providerState.providerProfileMutationSettledGeneration).toBe(0)
			expect(providerState.staleProviderHandoffProjection).toMatchObject({ requestedMode: "code" })
			expect(providerEmit).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})

	it("reconstructs an explicit clear from durable manager state after a reload", async () => {
		// After a reload the in-memory sets are empty; the durable profile
		// store identity was cleared and the resumed child still carries no
		// sticky profile, so the clear is reconstructed for publication.
		const resumedChild = { taskId: "child-1", taskApiConfigName: undefined }
		const provider = makeProviderStub({
			log: vi.fn(),
			getCurrentTask: vi.fn(() => resumedChild),
			providerSettingsManager: { getCurrentProfileName: vi.fn().mockResolvedValue(undefined) },
		})
		await expect(ClineProvider.prototype["isExplicitProfileClearInForce"].call(provider, "child-1")).resolves.toBe(
			true,
		)

		// A durable identity means no explicit clear: the ordinary default
		// fallback is unchanged (including fresh installs).
		const withIdentity = makeProviderStub({
			log: vi.fn(),
			getCurrentTask: vi.fn(() => resumedChild),
			providerSettingsManager: { getCurrentProfileName: vi.fn().mockResolvedValue("default") },
		})
		await expect(
			ClineProvider.prototype["isExplicitProfileClearInForce"].call(withIdentity, "child-1"),
		).resolves.toBe(false)

		// A child that later gained a sticky profile is no longer cleared.
		const profiledChild = { taskId: "child-1", taskApiConfigName: "chosen" }
		const withSticky = makeProviderStub({
			log: vi.fn(),
			getCurrentTask: vi.fn(() => profiledChild),
			providerSettingsManager: { getCurrentProfileName: vi.fn().mockResolvedValue(undefined) },
		})
		await expect(
			ClineProvider.prototype["isExplicitProfileClearInForce"].call(withSticky, "child-1"),
		).resolves.toBe(false)

		// A task that is no longer current is never covered by the fallback.
		const staleCheck = makeProviderStub({
			log: vi.fn(),
			getCurrentTask: vi.fn(() => ({ taskId: "child-other", taskApiConfigName: undefined })),
			providerSettingsManager: { getCurrentProfileName: vi.fn().mockResolvedValue(undefined) },
		})
		await expect(
			ClineProvider.prototype["isExplicitProfileClearInForce"].call(staleCheck, "child-1"),
		).resolves.toBe(false)
	})

	it("cleans a removed child's explicit-clear markers when it leaves the stack", async () => {
		const removed = {
			taskId: "child-1",
			instanceId: "instance-1",
			emit: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
		}
		const provider = makeProviderStub({
			log: vi.fn(),
			taskEventListeners: new WeakMap(),
			taskRegistry: {
				length: 1,
				current: removed,
				remove: vi.fn(() => removed),
			},
			staleProviderHandoffProjection: {
				childTaskId: "child-1",
				requestedMode: "code",
				apiConfigName: undefined,
				profileIntent: { kind: "clear" },
				apiConfiguration: {},
				generation: 2,
			},
		})
		const providerState = provider as unknown as {
			explicitProfileClearChildIds: Set<string>
			staleProviderHandoffProjection?: { childTaskId: string }
		}
		providerState.explicitProfileClearChildIds.add("child-1")
		providerState.explicitProfileClearChildIds.add("child-other")

		await ClineProvider.prototype.removeClineFromStack.call(provider)

		// Only the removed child's markers are cleaned; an unrelated child's
		// explicit-clear state is untouched.
		expect(providerState.explicitProfileClearChildIds.has("child-1")).toBe(false)
		expect(providerState.explicitProfileClearChildIds.has("child-other")).toBe(true)
		expect(providerState.staleProviderHandoffProjection).toBeUndefined()
	})

	it("invalidateProviderHandoffProjectionState drops only the named child's markers", () => {
		const provider = makeProviderStub({ log: vi.fn() })
		const providerState = provider as unknown as {
			explicitProfileClearChildIds: Set<string>
			staleProviderHandoffProjection?: {
				childTaskId: string
				requestedMode?: string
				apiConfigName?: string
				profileIntent?: unknown
				apiConfiguration?: unknown
				generation?: number
			}
		}
		providerState.explicitProfileClearChildIds.add("child-1")
		providerState.staleProviderHandoffProjection = {
			childTaskId: "child-1",
			requestedMode: "code",
			apiConfigName: undefined,
			profileIntent: { kind: "clear" },
			apiConfiguration: {},
			generation: 2,
		}

		ClineProvider.prototype["invalidateProviderHandoffProjectionState"].call(provider, "child-1")
		expect(providerState.explicitProfileClearChildIds.has("child-1")).toBe(false)
		expect(providerState.staleProviderHandoffProjection).toBeUndefined()

		// A marker belonging to a different child is left alone.
		providerState.staleProviderHandoffProjection = {
			childTaskId: "child-other",
			requestedMode: "code",
			apiConfigName: undefined,
			profileIntent: { kind: "clear" },
			apiConfiguration: {},
			generation: 3,
		}
		ClineProvider.prototype["invalidateProviderHandoffProjectionState"].call(provider, "child-1")
		expect(providerState.staleProviderHandoffProjection).toMatchObject({ childTaskId: "child-other" })
	})

	it("keeps a projection that settles after the child left the provider inert (no stale/clear resurrection)", async () => {
		const parentTask = makeParentTask()
		const child = makeChildTask("child-1")
		const providerEmit = vi.fn()
		const log = vi.fn()

		// The explicit no-profile handoff makes any late-failure resurrection
		// visible twice: as a re-stamped stale marker AND as a re-added
		// explicit-clear child id.
		const prepared = createPreparedProviderHandoffContext({
			requestedMode: "code",
			profile: { source: "unsaved-current", name: undefined, id: undefined },
			apiConfiguration: { apiProvider: providerIdentifiers.openrouter },
			persistModeProfileId: undefined,
		})

		// The first legacy write hangs until the test releases it, then fails:
		// the projection settles deferred, after the child already left.
		let releaseWrite!: () => void
		const writeGate = new Promise<void>((resolve) => {
			releaseWrite = resolve
		})
		const updateGlobalState = vi.fn((_key: string, _value: unknown) =>
			writeGate.then(() => {
				throw new Error("global write failed after child removal")
			}),
		)

		// Removal double used by the real removeClineFromStack call below.
		const removedChild = {
			taskId: "child-1",
			instanceId: "instance-1",
			emit: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
		}

		let currentTask: unknown = parentTask
		const getCurrentTask = vi.fn(() => currentTask)

		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: providerEmit,
			getCurrentTask,
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockResolvedValue(child),
			prepareProviderHandoffContext: makePreparationStub(prepared),
			// Real bounded queue and real projection: the deferred failure path
			// is exactly what the relevance fence must gate.
			enqueueProviderProfileMutation: ClineProvider.prototype["enqueueProviderProfileMutation"],
			updateGlobalState,
			contextProxy: { setProviderSettings: vi.fn().mockResolvedValue(undefined) },
			providerSettingsManager: {
				listConfig: vi.fn().mockResolvedValue([]),
				projectHandoffState: vi.fn().mockResolvedValue(undefined),
				// Durable identity for the reopened-task check below: a store
				// identity means no explicit clear.
				getCurrentProfileName: vi.fn().mockResolvedValue("default"),
			},
			log,
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore: makeStoreStub(),
			// Registry consulted only by the real removeClineFromStack call.
			taskEventListeners: new WeakMap(),
			taskRegistry: {
				length: 1,
				current: removedChild,
				remove: vi.fn(() => removedChild),
			},
		})

		await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})

		// Let the queue admit the projection: it starts and hangs on the
		// first legacy write.
		for (let i = 0; i < 25; i++) {
			await Promise.resolve()
		}
		expect(updateGlobalState).toHaveBeenCalledWith("mode", "code")

		// The child leaves the provider while the projection is in flight:
		// removal drops the projection-target registration BEFORE awaiting
		// the child's abort.
		await ClineProvider.prototype.removeClineFromStack.call(provider)
		expect(removedChild.abortTask).toHaveBeenCalledTimes(1)

		// Settle the projection failure. The settlement arrives after the
		// child's departure, so it must be inert: no stale marker, no
		// explicit-clear resurrection, no event.
		releaseWrite()
		const completion = await (
			provider as unknown as {
				providerHandoffProjectionCompletion?: Promise<ProviderHandoffProjectionOutcome>
			}
		).providerHandoffProjectionCompletion
		expect(completion).toMatchObject({ ok: false, boundary: "context-proxy" })

		const providerState = provider as unknown as {
			staleProviderHandoffProjection?: unknown
			explicitProfileClearChildIds: Set<string>
		}
		expect(providerState.staleProviderHandoffProjection).toBeUndefined()
		expect(providerState.explicitProfileClearChildIds.has("child-1")).toBe(false)
		expect(providerEmit).not.toHaveBeenCalledWith(RooCodeEventName.ModeChanged, "code")
		const logged = log.mock.calls.map((call) => call.join(" ")).join("\n")
		expect(logged).not.toContain("Post-commit handoff projection")

		// Reopening the same history task must not overlay the old context:
		// with the fence holding, publication takes the ordinary path.
		currentTask = { taskId: "child-1", taskApiConfigName: undefined }
		await expect(ClineProvider.prototype["isExplicitProfileClearInForce"].call(provider, "child-1")).resolves.toBe(
			false,
		)
		expect(providerState.staleProviderHandoffProjection).toBeUndefined()
	})

	it("keeps an admitted projection's failure authoritative when a newer mutation only enqueues and times out before admission", async () => {
		vi.useFakeTimers()
		try {
			const parentTask = makeParentTask()
			const child = makeChildTask("child-1")
			const providerEmit = vi.fn()
			const log = vi.fn()

			// The projection's first legacy write hangs on a gate: the
			// projection is admitted and in flight while the test enqueues an
			// unrelated mutation behind it.
			let releaseWrite!: () => void
			const writeGate = new Promise<void>((resolve) => {
				releaseWrite = resolve
			})
			const updateGlobalState = vi.fn(() => writeGate)

			const provider = makeProviderStub({
				taskScheduler: new TaskScheduler(),
				emit: providerEmit,
				getCurrentTask: vi.fn(() => parentTask),
				removeClineFromStack: vi.fn().mockResolvedValue(undefined),
				createTask: vi.fn().mockResolvedValue(child),
				prepareProviderHandoffContext: makePreparationStub(makePreparedHandoff()),
				enqueueProviderProfileMutation: ClineProvider.prototype["enqueueProviderProfileMutation"],
				updateGlobalState,
				contextProxy: { setProviderSettings: vi.fn().mockResolvedValue(undefined) },
				providerSettingsManager: {
					listConfig: vi.fn().mockRejectedValue(new Error("listConfig failed")),
					projectHandoffState: vi.fn().mockResolvedValue(undefined),
				},
				log,
				isViewLaunched: false,
				recentTasksCache: undefined,
				taskHistoryStore: makeStoreStub(),
			})

			const delegation = ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: "Do something",
				initialTodos: [],
				mode: "code",
			})
			await expect(delegation).resolves.toBe(child)
			// Let the queue admit the projection: it binds its admitted
			// generation and hangs on the mode write.
			for (let i = 0; i < 25; i++) {
				await Promise.resolve()
			}
			expect(updateGlobalState).toHaveBeenCalledWith("mode", "code")
			const registration = (
				provider as unknown as {
					providerHandoffProjectionTargets?: Map<string, { token: number; admittedGeneration?: number }>
				}
			).providerHandoffProjectionTargets?.get("child-1")
			expect(registration).toMatchObject({ token: expect.any(Number), admittedGeneration: 1 })

			// An unrelated mutation is ENQUEUED while the admitted projection
			// is in flight. Binding generations at admission (not enqueue)
			// means this reservation must not fence the in-flight projection.
			const unrelatedWrite = vi.fn(async () => "unrelated")
			const unrelated = ClineProvider.prototype["enqueueProviderProfileMutation"].call(provider, unrelatedWrite)
			const unrelatedOutcome = unrelated.then(
				() => "resolved",
				(error: unknown) => (error as Error).message,
			)

			// Both caller timeouts fire: the unrelated mutation is cancelled
			// BEFORE admission (zero writes, no generation consumed), and the
			// started projection's caller is released while its hung write
			// keeps the queue tail owned.
			await vi.advanceTimersByTimeAsync(ClineProvider.PENDING_OPERATION_TIMEOUT_MS + 1)
			expect(await unrelatedOutcome).toContain("timed out")
			expect(unrelatedWrite).not.toHaveBeenCalled()

			// The admitted projection's abandonment still counts: its exact
			// token/generation is registered and no newer mutation was ever
			// admitted, so the stale marker IS stamped — the child-local
			// context stays authoritative for publication.
			const providerState = provider as unknown as {
				staleProviderHandoffProjection?: { requestedMode: string; generation: number | undefined }
				providerProfileMutationSettledGeneration: number
			}
			expect(providerState.staleProviderHandoffProjection).toMatchObject({
				requestedMode: "code",
				generation: 1,
			})
			// A zero-write timeout never supersedes anything: no mutation
			// settled successfully, so the marker is not fenced off.
			expect(providerState.providerProfileMutationSettledGeneration).toBe(0)

			// The hung write settles; the aborted projection's late completion
			// is inert — the stamped marker survives and no mode change fires.
			releaseWrite()
			await (provider as unknown as { providerHandoffProjectionCompletion?: Promise<unknown> })
				.providerHandoffProjectionCompletion
			await vi.advanceTimersByTimeAsync(0)
			expect(providerState.staleProviderHandoffProjection).toMatchObject({ requestedMode: "code" })
			expect(providerEmit).not.toHaveBeenCalledWith(RooCodeEventName.ModeChanged, "code")
		} finally {
			vi.useRealTimers()
		}
	})

	it("keeps an old pre-admission projection inert when its task ID is reused by a newer registration", async () => {
		vi.useFakeTimers()
		try {
			const providerEmit = vi.fn()
			const log = vi.fn()
			const provider = makeProviderStub({
				emit: providerEmit,
				enqueueProviderProfileMutation: ClineProvider.prototype["enqueueProviderProfileMutation"],
				updateGlobalState: vi.fn().mockResolvedValue(undefined),
				contextProxy: { setProviderSettings: vi.fn().mockResolvedValue(undefined) },
				providerSettingsManager: {
					listConfig: vi.fn().mockResolvedValue([]),
					projectHandoffState: vi.fn().mockResolvedValue(undefined),
				},
				log,
				getCurrentTask: vi.fn(() => undefined),
				isViewLaunched: false,
				recentTasksCache: undefined,
				taskHistoryStore: makeStoreStub(),
			})

			// Block the queue tail with a started hung write so no queued
			// projection can be admitted yet. Its own caller timeout fires by
			// design (the started write keeps the tail); handle the caller
			// rejection so it cannot surface as an unhandled rejection.
			let releaseBlocker!: () => void
			const blockerGate = new Promise<void>((resolve) => {
				releaseBlocker = resolve
			})
			const blockerCaller = ClineProvider.prototype["enqueueProviderProfileMutation"].call(
				provider,
				() => blockerGate,
			)
			blockerCaller.catch(() => {})

			// Old projection for child-1 carrying a distinct OLD context,
			// registered and queued but never admitted.
			const oldPrepared = createPreparedProviderHandoffContext({
				requestedMode: "architect",
				profile: { source: "unsaved-current", name: "old-profile", id: "old-profile-id" },
				apiConfiguration: { apiProvider: providerIdentifiers.openrouter },
				persistModeProfileId: "old-profile-id",
			})
			const project = ClineProvider.prototype["projectPreparedProviderHandoffState"]
			const oldProjection = project.call(provider, oldPrepared, "child-1")

			// Advance partway, then simulate the old projection's child
			// leaving the provider and the SAME task ID being reused by a NEW
			// projection: the registry now carries a different token.
			await vi.advanceTimersByTimeAsync(10_000)
			ClineProvider.prototype["invalidateProviderHandoffProjectionState"].call(provider, "child-1")
			const newProjection = project.call(provider, makePreparedHandoff(), "child-1")

			// The old projection's caller timeout (registered at t≈0) fires
			// while it is still queued: it was never admitted and its token no
			// longer matches the registration, so the abandonment is entirely
			// inert. The advance stops short of the NEW projection's own
			// timeout window (it was enqueued 10s in).
			await vi.advanceTimersByTimeAsync(20_500)
			await expect(oldProjection).resolves.toMatchObject({ ok: false, boundary: "queue" })
			const providerState = provider as unknown as {
				staleProviderHandoffProjection?: { requestedMode: string }
				explicitProfileClearChildIds: Set<string>
			}
			// The old context is never stamped — no marker at all.
			expect(providerState.staleProviderHandoffProjection).toBeUndefined()
			expect(providerState.explicitProfileClearChildIds.size).toBe(0)

			// The new projection is still inside its own timeout window: it
			// runs once the blocker settles and is fully authoritative.
			releaseBlocker()
			await expect(newProjection).resolves.toMatchObject({ ok: true })
			expect(providerState.staleProviderHandoffProjection).toBeUndefined()
			expect(providerEmit).toHaveBeenCalledWith(RooCodeEventName.ModeChanged, "code")
			const registration = (
				provider as unknown as {
					providerHandoffProjectionTargets?: Map<string, { token: number; admittedGeneration?: number }>
				}
			).providerHandoffProjectionTargets?.get("child-1")
			expect(registration?.admittedGeneration).toBeDefined()
		} finally {
			vi.useRealTimers()
		}
	})

	it("a current normal projection clears a stale marker, binds its exact admitted generation, and emits", async () => {
		const parentTask = makeParentTask()
		const child = makeChildTask("child-1")
		const providerEmit = vi.fn()

		// A stale marker left by an older failed projection for the same
		// child; the new (successful) projection must clear it.
		const provider = makeProviderStub({
			taskScheduler: new TaskScheduler(),
			emit: providerEmit,
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockResolvedValue(child),
			prepareProviderHandoffContext: makePreparationStub(makePreparedHandoff()),
			enqueueProviderProfileMutation: ClineProvider.prototype["enqueueProviderProfileMutation"],
			updateGlobalState: vi.fn().mockResolvedValue(undefined),
			contextProxy: { setProviderSettings: vi.fn().mockResolvedValue(undefined) },
			providerSettingsManager: {
				listConfig: vi.fn().mockResolvedValue([]),
				projectHandoffState: vi.fn().mockResolvedValue(undefined),
			},
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore: makeStoreStub(),
			staleProviderHandoffProjection: {
				childTaskId: "child-1",
				requestedMode: "architect",
				apiConfigName: "old-profile",
				profileIntent: { kind: "set", name: "old-profile" },
				apiConfiguration: {},
				generation: 1,
			},
		})

		await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})
		await (provider as unknown as { providerHandoffProjectionCompletion?: Promise<unknown> })
			.providerHandoffProjectionCompletion

		const providerState = provider as unknown as {
			staleProviderHandoffProjection?: unknown
			providerHandoffProjectionTargets?: Map<string, { token: number; admittedGeneration?: number }>
		}
		expect(providerState.staleProviderHandoffProjection).toBeUndefined()
		expect(providerEmit).toHaveBeenCalledWith(RooCodeEventName.ModeChanged, "code")
		// Admission bound the exact generation into the registration — the
		// relevance fence can now require it.
		expect(providerState.providerHandoffProjectionTargets?.get("child-1")).toEqual({
			token: expect.any(Number),
			admittedGeneration: 1,
		})
	})

	it("deleteTaskFromState invalidates projection state synchronously, before the durable delete and any post", async () => {
		const targets = new Map<string, { token: number; admittedGeneration?: number }>([
			["child-1", { token: 41, admittedGeneration: 2 }],
		])
		const registrationPresentDuringDelete: boolean[] = []
		const provider = makeProviderStub({
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			recentTasksCache: undefined,
			taskHistoryStore: {
				delete: vi.fn(async () => {
					// Evaluated at the durable-delete boundary: the in-memory
					// invalidation must already have happened synchronously,
					// before this await even started.
					registrationPresentDuringDelete.push(targets.has("child-1"))
				}),
			},
		})
		const providerState = provider as unknown as {
			providerHandoffProjectionTargets?: Map<string, { token: number; admittedGeneration?: number }>
			explicitProfileClearChildIds: Set<string>
			staleProviderHandoffProjection?: { childTaskId: string }
		}
		providerState.providerHandoffProjectionTargets = targets
		providerState.explicitProfileClearChildIds.add("child-1")
		providerState.staleProviderHandoffProjection = { childTaskId: "child-1" }
		// Sanity: the registered identity (exact token) is relevant before the
		// delete.
		expect(ClineProvider.prototype["isProviderHandoffProjectionStillRelevant"].call(provider, "child-1", 41)).toBe(
			true,
		)

		await ClineProvider.prototype.deleteTaskFromState.call(provider, "child-1")

		// Invalidation was synchronous (nothing registered by the time the
		// durable delete ran) and stays clean afterwards: a deferred
		// projection settlement cannot pass the fence for the deleted task.
		expect(registrationPresentDuringDelete).toEqual([false])
		expect(targets.has("child-1")).toBe(false)
		expect(providerState.explicitProfileClearChildIds.has("child-1")).toBe(false)
		expect(providerState.staleProviderHandoffProjection).toBeUndefined()
		expect(ClineProvider.prototype["isProviderHandoffProjectionStillRelevant"].call(provider, "child-1", 41)).toBe(
			false,
		)
	})
})
