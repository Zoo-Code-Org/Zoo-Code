// npx vitest core/webview/__tests__/ClineProvider.handoffConcurrency.spec.ts
//
// Regression coverage for issue #921: delegation across parallel tabs with
// different view-local mode/profile state. Two ClineProvider instances share
// one durable profile store (like SecretStorage-backed profiles shared across
// webviews) while each holds its own view-local configuration. A concurrent
// provider's mutation between this provider's read-only preparation and its
// durable delegation commit must never leak into the child's execution
// context — the prepared immutable snapshot is authoritative.

import { TaskScheduler } from "../../task/TaskScheduler"
import {
	createPreparedProviderHandoffContext,
	type PreparedProviderHandoffContext,
} from "../../task-persistence/providerHandoff"
import { delegateTaskToChild } from "../../task-persistence/taskLifecycle"
import { ClineProvider } from "../ClineProvider"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"
import type { HistoryItem, ProviderSettings } from "@roo-code/types"

/** Mutable durable profile store shared by both provider "tabs". */
interface SharedProfileStore {
	currentApiConfigName: string | undefined
	entries: Array<{ name: string; id: string; apiProvider: string; modelId: string }>
	modeApiConfigId: Record<string, string>
	profiles: Record<string, ProviderSettings & { id: string }>
}

interface SharedWorld {
	profileStore: SharedProfileStore
	/** Shared legacy global settings (ContextProxy-backed in production). */
	globalProviderSettings: ProviderSettings
	lockAcrossModes: boolean
}

function buildSharedWorld(): SharedWorld {
	return {
		profileStore: {
			currentApiConfigName: "profile-a",
			entries: [
				{
					name: "profile-a",
					id: "profile-a-id",
					apiProvider: providerIdentifiers.openai,
					modelId: "gpt-test",
				},
			],
			modeApiConfigId: {},
			profiles: {
				"profile-a": { id: "profile-a-id", apiProvider: providerIdentifiers.openai, openAiApiKey: "sk-tab-a" },
			},
		},
		globalProviderSettings: { apiProvider: providerIdentifiers.openai, openAiApiKey: "sk-tab-a" },
		lockAcrossModes: false,
	}
}

/** Double of `ProviderSettingsManager.snapshotForHandoff` reading the shared store live. */
function snapshotForHandoff(world: SharedWorld) {
	return async (mode: string) => {
		const store = world.profileStore
		const modeApiConfigId = store.modeApiConfigId[mode]
		let savedProfile: (ProviderSettings & { id: string; name: string }) | undefined
		if (modeApiConfigId) {
			const entry = Object.entries(store.profiles).find(([, profile]) => profile.id === modeApiConfigId)
			if (entry) savedProfile = structuredClone({ name: entry[0], ...entry[1] })
		}
		return {
			currentApiConfigName: store.currentApiConfigName,
			currentProfile: store.currentApiConfigName
				? structuredClone({ name: store.currentApiConfigName, ...store.profiles[store.currentApiConfigName] })
				: undefined,
			entries: structuredClone(store.entries),
			modeApiConfigId,
			savedProfile,
		}
	}
}

/** Shared map-backed history store double for both providers. */
function makeSharedStore() {
	const records = new Map<string, HistoryItem>()
	/** Every child WAL write, captured before the post-commit strip removes it. */
	const walWrites: HistoryItem[] = []
	return {
		records,
		walWrites,
		get: (taskId: string) => records.get(taskId),
		upsert: async (item: HistoryItem) => {
			walWrites.push(item)
			records.set(item.id, item)
			return [item]
		},
		atomicReadAndUpdate: async (taskId: string, updater: (current: HistoryItem) => HistoryItem) => {
			const current = records.get(taskId)
			if (!current) throw new Error(`[TaskHistoryStore] atomicReadAndUpdate: ${taskId} not found`)
			records.set(taskId, updater(current))
			return []
		},
		readFresh: async (taskId: string) =>
			records.has(taskId) ? { kind: "found" as const, item: records.get(taskId)! } : { kind: "missing" as const },
		invalidate: async () => {},
	}
}

type SharedStore = ReturnType<typeof makeSharedStore>

const handoffPrototype = {
	prepareProviderHandoffContext: ClineProvider.prototype["prepareProviderHandoffContext"],
	projectPreparedProviderHandoffState: ClineProvider.prototype["projectPreparedProviderHandoffState"],
	rollbackFailedDelegation: ClineProvider.prototype["rollbackFailedDelegation"],
	restoreParentAfterFailedChildCreation: ClineProvider.prototype["restoreParentAfterFailedChildCreation"],
	reconcileDelegationCommitFailure: ClineProvider.prototype["reconcileDelegationCommitFailure"],
	delegateParentAndOpenChildUnlocked: ClineProvider.prototype["delegateParentAndOpenChildUnlocked"],
	runDelegationTransition: ClineProvider.prototype["runDelegationTransition"],
}

function makeWorldProvider(
	world: SharedWorld,
	store: SharedStore,
	options: {
		parentHistory: HistoryItem
		parentTask: unknown
		child: unknown
		/** This provider's own view-local settings (tab-local in production). */
		viewSettings: ProviderSettings
		createTaskGate?: () => Promise<void>
	},
): ClineProvider {
	const child = options.child as {
		adoptHandoffExecutionContext: ReturnType<typeof vi.fn>
		run: ReturnType<typeof vi.fn>
	}
	return {
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
		context: {
			workspaceState: {
				get: (_key: string, defaultValue?: unknown) =>
					_key === "lockApiConfigAcrossModes" ? world.lockAcrossModes : defaultValue,
			},
		},
		contextProxy: {
			getProviderSettings: () => structuredClone(options.viewSettings),
		},
		providerSettingsManager: {
			snapshotForHandoff: snapshotForHandoff(world),
		},
		taskHistoryStore: store,
		getCurrentTask: vi.fn(() => options.parentTask),
		removeClineFromStack: vi.fn().mockResolvedValue(undefined),
		createTask: vi.fn().mockImplementation(async () => {
			if (options.createTaskGate) await options.createTaskGate()
			return options.child
		}),
		getTaskWithId: vi.fn(async (id: string) => ({ historyItem: store.records.get(id) })),
		createTaskWithHistoryItem: vi.fn().mockResolvedValue(undefined),
		deleteTaskWithId: vi.fn().mockResolvedValue(undefined),
		log: vi.fn(),
		isViewLaunched: false,
		recentTasksCache: undefined,
		taskScheduler: new TaskScheduler(),
		emit: vi.fn(),
		...handoffPrototype,
		// The real prototype method needs the bounded profile-mutation queue;
		// these tests stub the background projection instead.
		projectPreparedProviderHandoffState: vi.fn().mockResolvedValue({ ok: true }),
	} as unknown as ClineProvider
}

function makeParent(id: string): HistoryItem {
	return {
		id,
		number: 1,
		ts: 1,
		task: "Parent",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		status: "active",
		mode: "code",
		childIds: [],
	}
}

function makeTaskDouble(taskId: string) {
	return {
		taskId,
		rootTaskId: undefined,
		taskNumber: 2,
		workspacePath: "/test/workspace",
		flushPendingToolResultsToHistory: vi.fn().mockResolvedValue(true),
		retrySaveApiConversationHistory: vi.fn(),
		adoptHandoffExecutionContext: vi.fn(),
		run: vi.fn().mockResolvedValue(undefined),
	}
}

describe("ClineProvider two-provider handoff concurrency (issue #921)", () => {
	it("freezes the delegating tab's context against a concurrent other-tab profile mutation", async () => {
		const world = buildSharedWorld()
		const store = makeSharedStore()
		store.records.set("parent-a", makeParent("parent-a"))

		let releaseChildCreation!: () => void
		const childCreationGate = new Promise<void>((resolve) => {
			releaseChildCreation = resolve
		})

		const parentTask = makeTaskDouble("parent-a")
		const childA = makeTaskDouble("child-a")
		const tabASettings: ProviderSettings = {
			apiProvider: providerIdentifiers.openai,
			openAiApiKey: "sk-tab-a",
		}
		const providerA = makeWorldProvider(world, store, {
			parentHistory: makeParent("parent-a"),
			parentTask,
			child: childA,
			viewSettings: tabASettings,
			// Pause provider A between its read-only preparation and its commit:
			// exactly the window a concurrent tab's mutation must not leak into.
			createTaskGate: async () => {
				await childCreationGate
			},
		})

		// Tab B: a different view-local mode/profile with its own secret.
		const tabBSettings: ProviderSettings = {
			apiProvider: providerIdentifiers.openai,
			openAiApiKey: "sk-tab-b",
		}
		world.profileStore.profiles["profile-b"] = {
			id: "profile-b-id",
			apiProvider: providerIdentifiers.openai,
			openAiApiKey: "sk-tab-b",
		}
		world.profileStore.entries.push({
			name: "profile-b",
			id: "profile-b-id",
			apiProvider: providerIdentifiers.openai,
			modelId: "gpt-test",
		})
		const providerB = makeWorldProvider(world, store, {
			parentHistory: makeParent("parent-b"),
			parentTask: makeTaskDouble("parent-b"),
			child: makeTaskDouble("child-b"),
			viewSettings: tabBSettings,
		})

		// Provider A starts its delegation; it pauses inside child creation
		// (preparation already captured the tab-A snapshot).
		const delegationA = ClineProvider.prototype.delegateParentAndOpenChild.call(providerA, {
			parentTaskId: "parent-a",
			message: "Do tab-A work",
			initialTodos: [],
			mode: "code",
		})
		await vi.waitFor(() => {
			expect(vi.mocked(providerA["createTask"] as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0)
		})

		// Concurrent tab-B activity: tab B "activates" profile-b — mutating the
		// shared durable store and legacy global settings while A is paused —
		// and then prepares its own handoff from the mutated world.
		world.profileStore.currentApiConfigName = "profile-b"
		world.globalProviderSettings = { apiProvider: providerIdentifiers.openai, openAiApiKey: "sk-tab-b" }
		const preparedB: PreparedProviderHandoffContext = await providerB["prepareProviderHandoffContext"].call(
			providerB,
			"architect" as never,
		)

		// Release provider A: commit + child start happen after B's mutation.
		releaseChildCreation()
		const childResult = await delegationA

		expect(childResult).toBe(childA)

		// Tab A's child runs with the FROZEN tab-A context, never tab-B values.
		const createTaskCall = vi.mocked(providerA["createTask"] as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(createTaskCall![3]).toMatchObject({
			initialStatus: "active",
			startTask: false,
			handoffExecutionContext: {
				mode: "code",
				apiConfigName: "profile-a",
			},
		})
		const handedConfig = (createTaskCall![3] as { handoffExecutionContext: { apiConfiguration: ProviderSettings } })
			.handoffExecutionContext.apiConfiguration
		expect(handedConfig.openAiApiKey).toBe("sk-tab-a")

		expect(childA.adoptHandoffExecutionContext).toHaveBeenCalledWith({
			mode: "code",
			apiConfigName: "profile-a",
			apiConfiguration: expect.objectContaining({ openAiApiKey: "sk-tab-a" }),
		})
		expect(childA.run).toHaveBeenCalledTimes(1)

		// The durable child WAL record carries tab A's identity, not tab B's.
		const walRecord = store.walWrites[0]
		expect(walRecord?.pendingHandoff).toEqual({
			kind: "set",
			version: 1,
			mode: "code",
			profileName: "profile-a",
		})
		expect(walRecord?.apiConfigName).toBe("profile-a")
		const parentRecord = store.records.get("parent-a")
		expect(parentRecord?.status).toBe("delegated")
		expect(parentRecord).toEqual(delegateTaskToChild(makeParent("parent-a"), "child-a"))

		// Tab B's own prepared context is its own: cross-provider isolation is
		// symmetric and B's snapshot is unaffected by A's frozen context.
		expect(preparedB.requestedMode).toBe("architect")
		expect(preparedB.profile.name).toBe("profile-b")
		expect(preparedB.apiConfiguration.openAiApiKey).toBe("sk-tab-b")
	})

	it("keeps an explicit profile clear against a concurrent other-tab profile set", async () => {
		const world = buildSharedWorld()
		// Tab A's view has no current profile at all: an explicit clear handoff.
		world.profileStore.currentApiConfigName = undefined

		const store = makeSharedStore()
		store.records.set("parent-a", makeParent("parent-a"))

		let releaseChildCreation!: () => void
		const childCreationGate = new Promise<void>((resolve) => {
			releaseChildCreation = resolve
		})

		const childA = makeTaskDouble("child-a")
		const providerA = makeWorldProvider(world, store, {
			parentHistory: makeParent("parent-a"),
			parentTask: makeTaskDouble("parent-a"),
			child: childA,
			viewSettings: { apiProvider: providerIdentifiers.openai, openAiApiKey: "sk-tab-a" },
			createTaskGate: async () => {
				await childCreationGate
			},
		})

		const delegationA = ClineProvider.prototype.delegateParentAndOpenChild.call(providerA, {
			parentTaskId: "parent-a",
			message: "Do tab-A work",
			initialTodos: [],
			mode: "code",
		})
		await vi.waitFor(() => {
			expect(vi.mocked(providerA["createTask"] as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0)
		})

		// Concurrent tab-B set of a named profile must not turn the clear handoff
		// into a set handoff.
		world.profileStore.currentApiConfigName = "profile-b"

		releaseChildCreation()
		await delegationA

		const createTaskCall = vi.mocked(providerA["createTask"] as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(createTaskCall![3]).toMatchObject({
			handoffExecutionContext: {
				mode: "code",
				apiConfigName: undefined,
			},
		})
		// The durable WAL record preserves the explicit clear intent (captured
		// at write time; the post-commit strip removes the marker afterward).
		const walRecord = store.walWrites[0]
		expect(walRecord?.pendingHandoff).toEqual({
			kind: "clear",
			version: 1,
			mode: "code",
		})
		expect(walRecord?.apiConfigName).toBeUndefined()
	})
})
