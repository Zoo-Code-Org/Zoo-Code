const mockState = vi.hoisted(() => ({
	stores: [] as any[],
	storeBaseDirs: [] as string[],
	collectors: [] as any[],
	analyzers: [] as any[],
	appliers: [] as any[],
	adapters: [] as any[],
	memoryStores: [] as any[],
	memoryStoreBaseDirs: [] as string[],
	skillUsageStores: [] as any[],
	skillUsageStoreBaseDirs: [] as string[],
	actionExecutors: [] as any[],
	curatorServices: [] as any[],
	curatorBaseDirs: [] as string[],
	reviewPromptFactories: [] as any[],
	transcriptRecalls: [] as any[],
	transcriptRecallBaseDirs: [] as string[],
}))

const DEFAULT_CURATOR_STATUS = {
	lastRunAt: 0,
	firstRunDone: false,
	config: {
		intervalMs: 3_600_000,
		minIdleMs: 300_000,
		firstRunDeferred: true,
		staleAfterDays: 14,
		archiveAfterDays: 60,
		backupsEnabled: true,
		maxBackups: 5,
	},
}

function createStoreMock() {
	return {
		initialize: vi.fn().mockResolvedValue(undefined),
		persist: vi.fn().mockResolvedValue(undefined),
		reset: vi.fn().mockResolvedValue(undefined),
		getConfig: vi.fn().mockReturnValue({
			reviewOnTurnCount: 10,
			reviewOnToolIterationCount: 2,
			maxPromptPatterns: 5,
			curatorEnabled: true,
			curatorIntervalMs: 5_000,
			staleAfterDays: 14,
			archiveAfterDays: 60,
			codeIndexCorrelationEnabled: true,
		}),
		getPatterns: vi.fn().mockReturnValue([]),
		getRecentEvents: vi.fn().mockReturnValue([]),
		getPendingActions: vi.fn().mockReturnValue([]),
		getTelemetry: vi.fn().mockReturnValue({
			promptEnrichmentUses: 0,
			toolPreferenceUses: 0,
			errorAvoidanceUses: 0,
			skillSuggestionCount: 0,
		}),
		getCounters: vi.fn().mockReturnValue({ userTurnsSinceReview: 0, toolIterationsSinceReview: 0 }),
		addEvent: vi.fn(),
		addPattern: vi.fn(),
		addAction: vi.fn(),
		removeAction: vi.fn(),
		incrementToolIterations: vi.fn(),
		incrementUserTurns: vi.fn(),
		resetCounters: vi.fn(),
		updateTelemetry: vi.fn(),
		updatePattern: vi.fn(),
		archivePattern: vi.fn(),
	}
}

function createMemoryStoreMock() {
	return {
		backendType: "builtin",
		initialize: vi.fn().mockResolvedValue(undefined),
		getSnapshotString: vi.fn().mockReturnValue(""),
		getStats: vi.fn().mockResolvedValue({ entryCount: 0, backend: "builtin" }),
		takeSnapshot: vi.fn(),
		dispose: vi.fn().mockResolvedValue(undefined),
	}
}

function createSkillUsageStoreMock() {
	return {
		initialize: vi.fn().mockResolvedValue(undefined),
		getStats: vi.fn().mockReturnValue({ total: 0, active: 0, stale: 0, archived: 0, pinned: 0, agentCreated: 0 }),
	}
}

function createActionExecutorMock() {
	return {
		executeBatch: vi.fn().mockResolvedValue(new Set()),
	}
}

function createCuratorServiceMock() {
	return {
		initialize: vi.fn().mockResolvedValue(undefined),
		run: vi.fn().mockResolvedValue({
			runId: "curator-run-1",
			timestamp: 1,
			durationMs: 1,
			transitions: [],
			stats: {
				totalSkills: 0,
				activeSkills: 0,
				staleSkills: 0,
				archivedSkills: 0,
				pinnedSkills: 0,
				transitionsApplied: 0,
			},
		}),
		getStatus: vi.fn().mockReturnValue({ ...DEFAULT_CURATOR_STATUS, config: { ...DEFAULT_CURATOR_STATUS.config } }),
	}
}

function createTranscriptRecallMock() {
	return {
		initialize: vi.fn().mockResolvedValue(undefined),
		record: vi.fn().mockResolvedValue(undefined),
	}
}

vi.mock("../LearningStore", () => ({
	LearningStore: vi.fn().mockImplementation((baseDir: string) => {
		const store = createStoreMock()
		mockState.storeBaseDirs.push(baseDir)
		mockState.stores.push(store)
		return store
	}),
}))

vi.mock("../FeedbackCollector", () => ({
	FeedbackCollector: vi.fn().mockImplementation(() => {
		const collector = {
			createTaskEvent: vi.fn().mockImplementation((info) => ({
				id: "evt-task",
				signal: info.success ? "TASK_SUCCESS" : "TASK_FAILURE",
				timestamp: 1,
				taskId: info.taskId,
				context: { toolNames: info.toolNames },
				outcome: { success: info.success },
			})),
			createCorrectionEvent: vi.fn().mockReturnValue({
				id: "evt-correction",
				signal: "USER_CORRECTION",
				timestamp: 1,
				context: {},
				outcome: { corrected: true },
			}),
			createCodeIndexEvent: vi.fn().mockReturnValue({
				id: "evt-code-index",
				signal: "CODE_INDEX_HIT",
				timestamp: 1,
				context: {},
				outcome: {},
			}),
		}
		mockState.collectors.push(collector)
		return collector
	}),
}))

vi.mock("../PatternAnalyzer", () => ({
	PatternAnalyzer: vi.fn().mockImplementation(() => {
		const analyzer = { analyze: vi.fn().mockReturnValue([]) }
		mockState.analyzers.push(analyzer)
		return analyzer
	}),
}))

vi.mock("../ImprovementApplier", () => ({
	ImprovementApplier: vi.fn().mockImplementation(() => {
		const applier = {
			generateActions: vi.fn().mockReturnValue([]),
			getPromptContext: vi.fn().mockReturnValue({ entries: [], revision: 0 }),
		}
		mockState.appliers.push(applier)
		return applier
	}),
}))

vi.mock("../CodeIndexAdapter", () => ({
	CodeIndexAdapter: vi.fn().mockImplementation(() => {
		const adapter = {
			getInfo: vi.fn().mockReturnValue({ available: true, hits: 3, topScore: 0.9 }),
			isAvailable: vi.fn().mockReturnValue(true),
			searchVectorStore: vi.fn().mockResolvedValue([]),
			setCodeIndexManager: vi.fn(),
		}
		mockState.adapters.push(adapter)
		return adapter
	}),
}))

vi.mock("../MemoryStore", () => ({
	MemoryStore: vi.fn().mockImplementation(function (this: Record<string, unknown>, baseDir: string) {
		Object.assign(this, createMemoryStoreMock())
		mockState.memoryStoreBaseDirs.push(baseDir)
		mockState.memoryStores.push(this)
	}),
}))

vi.mock("../SkillUsageStore", () => ({
	SkillUsageStore: vi.fn().mockImplementation((baseDir: string) => {
		const store = createSkillUsageStoreMock()
		mockState.skillUsageStoreBaseDirs.push(baseDir)
		mockState.skillUsageStores.push(store)
		return store
	}),
}))

vi.mock("../ActionExecutor", () => ({
	ActionExecutor: vi.fn().mockImplementation(() => {
		const executor = createActionExecutorMock()
		mockState.actionExecutors.push(executor)
		return executor
	}),
}))

vi.mock("../CuratorService", () => ({
	CuratorService: vi.fn().mockImplementation((baseDir: string) => {
		const service = createCuratorServiceMock()
		mockState.curatorBaseDirs.push(baseDir)
		mockState.curatorServices.push(service)
		return service
	}),
}))

vi.mock("../ReviewPromptFactory", () => ({
	ReviewPromptFactory: vi.fn().mockImplementation(() => {
		const factory = {}
		mockState.reviewPromptFactories.push(factory)
		return factory
	}),
}))

vi.mock("../TranscriptRecall", () => ({
	TranscriptRecall: vi.fn().mockImplementation((baseDir: string) => {
		const store = createTranscriptRecallMock()
		mockState.transcriptRecallBaseDirs.push(baseDir)
		mockState.transcriptRecalls.push(store)
		return store
	}),
}))

import { SelfImprovingManager } from "../SelfImprovingManager"

describe("SelfImprovingManager", () => {
	let experiments: Record<string, boolean> | undefined
	let memoryBackend: "builtin" | "agentmemory" | undefined
	let agentMemoryUrl: string | undefined
	let selfImprovingScope: "workspace" | "global" | undefined
	let selfImprovingAutoSkillsScope: "workspace" | "global" | undefined
	let workspacePath: string | undefined
	let logger: { appendLine: ReturnType<typeof vi.fn> }

	const createManager = () =>
		new SelfImprovingManager({
			globalStoragePath: "/tmp/zoo-code-tests",
			logger,
			getExperiments: () => experiments,
			getMemoryBackend: () => memoryBackend,
			getAgentMemoryUrl: () => agentMemoryUrl,
			getSelfImprovingScope: () => selfImprovingScope,
			getAutoSkillsScope: () => selfImprovingAutoSkillsScope,
			getWorkspacePath: () => workspacePath,
		})

	beforeEach(() => {
		vi.clearAllMocks()
		vi.useFakeTimers()
		mockState.stores.length = 0
		mockState.storeBaseDirs.length = 0
		mockState.collectors.length = 0
		mockState.analyzers.length = 0
		mockState.appliers.length = 0
		mockState.adapters.length = 0
		mockState.memoryStores.length = 0
		mockState.memoryStoreBaseDirs.length = 0
		mockState.skillUsageStores.length = 0
		mockState.skillUsageStoreBaseDirs.length = 0
		mockState.actionExecutors.length = 0
		mockState.curatorServices.length = 0
		mockState.curatorBaseDirs.length = 0
		mockState.reviewPromptFactories.length = 0
		mockState.transcriptRecalls.length = 0
		mockState.transcriptRecallBaseDirs.length = 0
		experiments = undefined
		memoryBackend = undefined
		agentMemoryUrl = undefined
		selfImprovingScope = undefined
		selfImprovingAutoSkillsScope = undefined
		workspacePath = "/tmp/workspace-one"
		logger = { appendLine: vi.fn() }
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("requires self-improving to be enabled before auto-skills activates", () => {
		expect(SelfImprovingManager.isAutoSkillsEnabled(undefined)).toBe(false)
		expect(SelfImprovingManager.isAutoSkillsEnabled({ selfImprovingAutoSkills: true } as any)).toBe(false)
		expect(
			SelfImprovingManager.isAutoSkillsEnabled({ selfImproving: true, selfImprovingAutoSkills: false } as any),
		).toBe(false)
		expect(
			SelfImprovingManager.isAutoSkillsEnabled({ selfImproving: true, selfImprovingAutoSkills: true } as any),
		).toBe(true)
	})

	it("has zero runtime overhead when disabled", async () => {
		const manager = createManager()

		await manager.initialize()
		await manager.recordTaskCompletion({ taskId: "task-1", success: true, toolNames: ["read_file"] })

		// getOrCreateRuntime is called during initialize, so store is created
		expect(mockState.stores).toHaveLength(1)
		// but no timers are started since experiment is disabled
		expect(vi.getTimerCount()).toBe(0)
		expect(await manager.getStatus()).toMatchObject({
			enabled: false,
			started: false,
			patternCount: 0,
			eventCount: 0,
			actionCount: 0,
			memoryEntries: 0,
			skillRecords: 0,
			curatorStatus: DEFAULT_CURATOR_STATUS,
			autoMode: expect.objectContaining({ autoModeEnabled: true }),
			reviewTeam: {
				enabled: true,
				innovatorWeight: 0.3,
				contrarianWeight: 0.3,
				devilsAdvocateWeight: 0.3,
				deciderThreshold: 0.6,
			},
			questionEvaluator: expect.objectContaining({ enabled: true }),
			resilience: expect.objectContaining({ enabled: true, consecutiveFailures: 0 }),
			toolErrorHealer: expect.objectContaining({ enabled: true, knownTools: 10 }),
			preventionEngine: { initialized: true },
			verificationEngine: { enabled: true, lastVerifyAt: undefined, lastResult: undefined },
			requirementsVerification: { enabled: true, requirementCount: 0, activeCount: 0, supersededCount: 0, lastVerifyResult: undefined },
		})
	})

	it("initializes store state and schedules timers when enabled", async () => {
		experiments = { selfImproving: true }
		const manager = createManager()

		await manager.initialize()

		expect(mockState.stores).toHaveLength(1)
		expect(mockState.stores[0].initialize).toHaveBeenCalledTimes(1)
		expect(mockState.memoryStores[0].initialize).toHaveBeenCalledTimes(1)
		expect(mockState.skillUsageStores[0].initialize).toHaveBeenCalledTimes(1)
		expect(mockState.transcriptRecalls[0].initialize).toHaveBeenCalledTimes(1)
		expect(mockState.curatorServices[0].initialize).toHaveBeenCalledTimes(1)
		// 2 existing timers + 1 auto mode review timer
		expect(vi.getTimerCount()).toBe(3)
		expect(await manager.getStatus()).toMatchObject({ enabled: true, started: true })
	})

	it("runs a review cycle from task completion triggers", async () => {
		experiments = { selfImproving: true }
		const manager = createManager()
		await manager.initialize()

		const store = mockState.stores[0]
		const analyzer = mockState.analyzers[0]
		const applier = mockState.appliers[0]
		const executor = mockState.actionExecutors[0]
		const transcriptRecall = mockState.transcriptRecalls[0]
		const pattern = {
			id: "pattern-1",
			patternType: "prompt",
			state: "active",
			summary: "Prefer semantic search before regex search",
			confidenceScore: 0.9,
			frequency: 3,
			successRate: 0.8,
			firstSeenAt: 1,
			lastSeenAt: 1,
			sourceSignals: ["TASK_SUCCESS"],
			context: {},
		}
		const action = {
			id: "action-1",
			actionType: "PROMPT_ENRICHMENT",
			target: "system-prompt",
			payload: { summary: "Prefer semantic search before regex search" },
			timestamp: 1,
		}

		store.getCounters.mockReturnValue({ userTurnsSinceReview: 0, toolIterationsSinceReview: 2 })
		store.getRecentEvents.mockReturnValue([
			{ id: "evt-1", signal: "TASK_SUCCESS", timestamp: 1, context: {}, outcome: {} },
		])
		store.getPatterns.mockReturnValueOnce([]).mockReturnValue([pattern])
		store.getPendingActions.mockReturnValue([action])
		analyzer.analyze.mockReturnValue([pattern])
		applier.generateActions.mockReturnValue([action])
		executor.executeBatch.mockResolvedValue(new Set(["action-1"]))

		await manager.recordTaskCompletion({ taskId: "task-1", success: true, toolNames: ["search_files"] })

		expect(store.addEvent).toHaveBeenCalledTimes(1)
		expect(transcriptRecall.record).toHaveBeenCalledWith({
			id: "evt-task",
			timestamp: 1,
			taskId: "task-1",
			mode: undefined,
			summary: "Task completed: unknown",
			signal: "TASK_SUCCESS",
			workspacePath: undefined,
			toolNames: ["search_files"],
			errorKey: undefined,
			success: true,
		})
		expect(store.incrementToolIterations).toHaveBeenCalledWith(1)
		expect(analyzer.analyze).toHaveBeenCalledTimes(1)
		expect(store.addPattern).toHaveBeenCalledWith(pattern)
		expect(store.addAction).toHaveBeenCalledWith(action)
		expect(executor.executeBatch).toHaveBeenCalledWith([action])
		expect(store.removeAction).toHaveBeenCalledWith("action-1")
		expect(store.persist).toHaveBeenCalled()
	})

	it("formats prompt context and disposes cleanly on experiment disable", async () => {
		experiments = { selfImproving: true }
		const manager = createManager()
		await manager.initialize()

		const memoryStore = mockState.memoryStores[0]
		memoryStore.getSnapshotString.mockReturnValue("\n## Learned Context\n- Search relevant code before editing\n")
		memoryStore.getStats.mockResolvedValue({ entryCount: 3, backend: "builtin" })
		mockState.skillUsageStores[0].getStats.mockReturnValue({
			total: 4,
			active: 3,
			stale: 1,
			archived: 0,
			pinned: 1,
			agentCreated: 2,
		})

		expect(manager.getPromptContextString()).toBe("\n## Learned Context\n- Search relevant code before editing\n")
		expect(await manager.getStatus()).toMatchObject({ memoryEntries: 3, memoryBackend: "builtin", skillRecords: 4 })

		experiments = { selfImproving: false }
		await manager.handleExperimentChange(false)

		expect(mockState.stores[0].persist).toHaveBeenCalledTimes(1)
		expect(memoryStore.takeSnapshot).toHaveBeenCalledTimes(1)
		expect(memoryStore.dispose).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)
		expect(await manager.getStatus()).toMatchObject({
			enabled: false,
			started: false,
			patternCount: 0,
			eventCount: 0,
			actionCount: 0,
			memoryEntries: 0,
			skillRecords: 0,
			curatorStatus: DEFAULT_CURATOR_STATUS,
			autoMode: expect.objectContaining({ autoModeEnabled: true }),
			reviewTeam: {
				enabled: true,
				innovatorWeight: 0.3,
				contrarianWeight: 0.3,
				devilsAdvocateWeight: 0.3,
				deciderThreshold: 0.6,
			},
			questionEvaluator: expect.objectContaining({ enabled: true }),
			resilience: expect.objectContaining({ enabled: true, consecutiveFailures: 0 }),
			toolErrorHealer: expect.objectContaining({ enabled: true, knownTools: 10 }),
			preventionEngine: { initialized: true },
			verificationEngine: { enabled: true, lastVerifyAt: undefined, lastResult: undefined },
			requirementsVerification: { enabled: true, requirementCount: 0, activeCount: 0, supersededCount: 0, lastVerifyResult: undefined },
		})
	})

	it("rebuilds the memory backend when settings change", async () => {
		experiments = { selfImproving: true }
		const manager = createManager()
		await manager.initialize()

		const originalStore = mockState.memoryStores[0]
		memoryBackend = "agentmemory"
		agentMemoryUrl = "http://agentmemory.internal:4001"

		await manager.onSettingsChanged(experiments as any)

		expect(originalStore.takeSnapshot).toHaveBeenCalledTimes(1)
		expect(originalStore.dispose).toHaveBeenCalledTimes(1)
		expect((manager.memoryStore as any).backendType).toBe("agentmemory")
		expect(logger.appendLine).toHaveBeenCalledWith(
			"[SelfImprovingManager] Memory backend configured: agentmemory (http://agentmemory.internal:4001)",
		)
	})

	it("rebuilds self-improving stores when scope changes to workspace", async () => {
		experiments = { selfImproving: true }
		const manager = createManager()
		await manager.initialize()

		selfImprovingScope = "workspace"
		selfImprovingAutoSkillsScope = "global"
		workspacePath = "/tmp/workspace-two"

		await manager.onSettingsChanged(experiments as any)

		expect(mockState.storeBaseDirs.at(-1)).toContain("workspace-scopes")
		expect(mockState.memoryStoreBaseDirs.at(-1)).toContain("workspace-scopes")
		expect(mockState.skillUsageStoreBaseDirs.at(-1)).toContain("workspace-scopes")
		expect(mockState.curatorBaseDirs.at(-1)).toContain("workspace-scopes")
		expect(mockState.transcriptRecallBaseDirs.at(-1)).toContain("workspace-scopes")
		expect(mockState.stores.length).toBeGreaterThanOrEqual(2)
		expect(mockState.memoryStores.length).toBeGreaterThanOrEqual(2)
	})

	it("runs curator cycles through the curator service", async () => {
		experiments = { selfImproving: true }
		const manager = createManager()
		await manager.initialize()

		const report = {
			runId: "curator-run-2",
			timestamp: 123,
			durationMs: 5,
			transitions: [
				{
					skillId: "skill-1",
					skillName: "Skill 1",
					fromState: "active",
					toState: "stale",
					reason: "No activity for 14 days",
				},
			],
			stats: {
				totalSkills: 1,
				activeSkills: 0,
				staleSkills: 1,
				archivedSkills: 0,
				pinnedSkills: 0,
				transitionsApplied: 1,
			},
		}
		mockState.curatorServices[0].run.mockResolvedValue(report)

		const result = await manager.runCuratorCycle()

		expect(mockState.curatorServices[0].run).toHaveBeenCalledTimes(1)
		expect(mockState.stores[0].updateTelemetry).toHaveBeenCalledWith({ lastCuratorRunAt: 123 })
		expect(result).toEqual(report)
	})

	it("records code index events with explicit search hit details", async () => {
		experiments = { selfImproving: true }
		const manager = createManager()
		await manager.initialize()

		const store = mockState.stores[0]
		const collector = mockState.collectors[0]
		store.getConfig.mockReturnValue({
			reviewOnTurnCount: 10,
			reviewOnToolIterationCount: 2,
			maxPromptPatterns: 5,
			curatorEnabled: true,
			curatorIntervalMs: 5_000,
			staleAfterDays: 14,
			archiveAfterDays: 60,
			codeIndexCorrelationEnabled: true,
		})

		await manager.recordCodeIndexEvent("task-1", { available: true, hits: 4, topScore: 0.91 })

		expect(collector.createCodeIndexEvent).toHaveBeenCalledWith(
			{ available: true, hits: 4, topScore: 0.91 },
			"task-1",
		)
		expect(store.addEvent).toHaveBeenCalledWith(expect.objectContaining({ signal: "CODE_INDEX_HIT" }))
	})
})
