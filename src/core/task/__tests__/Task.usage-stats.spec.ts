// npx vitest core/task/__tests__/Task.usage-stats.spec.ts
//
// Commit 3 테스트: API attempt 최종 usage 계측 검증.
// - chunk별 기록이 없고 terminal finalize에서만 기록
// - completed/failed/cancelled partial usage 구분
// - idempotency key가 동일 terminal path 중복 호출 차단
// - store 오류가 기존 task 결과에 영향을 주지 않음

import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import type { GlobalState, ProviderSettings } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { ContextProxy } from "../../config/ContextProxy"
import { UsageRecorder } from "../../../services/stats/UsageRecorder"
import type { UsageRecordingContext } from "../../../services/stats/UsageRecorder"
import { UsageEventStore } from "../../../services/stats/UsageEventStore"

// Mock @roo-code/core
vi.mock("@roo-code/core", () => ({
	customToolRegistry: {
		getTools: vi.fn().mockReturnValue([]),
		hasTool: vi.fn().mockReturnValue(false),
		getTool: vi.fn().mockReturnValue(undefined),
	},
}))

// Mock delay before any imports that might use it
vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

vi.mock("fs/promises", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	const mockFunctions = {
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockImplementation(() => Promise.resolve("[]")),
		unlink: vi.fn().mockResolvedValue(undefined),
		rmdir: vi.fn().mockResolvedValue(undefined),
		stat: vi.fn().mockRejectedValue({ code: "ENOENT" }),
		readdir: vi.fn().mockResolvedValue([]),
	}
	return {
		...actual,
		...mockFunctions,
		default: mockFunctions,
	}
})

vi.mock("p-wait-for", () => ({
	default: vi.fn().mockImplementation(async () => Promise.resolve()),
}))

vi.mock("vscode", () => {
	const mockDisposable = { dispose: vi.fn() }
	const mockEventEmitter = { event: vi.fn(), fire: vi.fn() }
	const mockTextDocument = { uri: { fsPath: "/mock/workspace/path/file.ts" } }
	const mockTextEditor = { document: mockTextDocument }
	const mockTab = { input: { uri: { fsPath: "/mock/workspace/path/file.ts" } } }
	const mockTabGroup = { tabs: [mockTab] }

	return {
		TabInputTextDiff: vi.fn(),
		CodeActionKind: {
			QuickFix: { value: "quickfix" },
			RefactorRewrite: { value: "refactor.rewrite" },
		},
		window: {
			createTextEditorDecorationType: vi.fn().mockReturnValue({
				dispose: vi.fn(),
			}),
			visibleTextEditors: [mockTextEditor],
			tabGroups: {
				all: [mockTabGroup],
				close: vi.fn(),
				onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })),
			},
			showErrorMessage: vi.fn(),
		},
		workspace: {
			workspaceFolders: [
				{
					uri: { fsPath: "/mock/workspace/path" },
					name: "mock-workspace",
					index: 0,
				},
			],
			createFileSystemWatcher: vi.fn(() => ({
				onDidCreate: vi.fn(() => mockDisposable),
				onDidDelete: vi.fn(() => mockDisposable),
				onDidChange: vi.fn(() => mockDisposable),
				dispose: vi.fn(),
			})),
			fs: {
				stat: vi.fn().mockResolvedValue({ type: 1 }),
			},
			onDidSaveTextDocument: vi.fn(() => mockDisposable),
			getConfiguration: vi.fn(() => ({ get: (_key: string, defaultValue: unknown) => defaultValue })),
		},
		env: {
			uriScheme: "vscode",
			language: "en",
		},
		EventEmitter: vi.fn().mockImplementation(function () {
			return mockEventEmitter
		}),
		Disposable: {
			from: vi.fn(),
		},
		TabInputText: vi.fn(),
	}
})

vi.mock("../../mentions", () => ({
	parseMentions: vi.fn().mockImplementation((text) => {
		return Promise.resolve({ text: `processed: ${text}`, mode: undefined, contentBlocks: [] })
	}),
	openMention: vi.fn(),
	getLatestTerminalOutput: vi.fn(),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockResolvedValue("Mock file content"),
}))

vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue(""),
}))

vi.mock("../../ignore/RooIgnoreController")

vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath, taskId) => Promise.resolve(`${globalStoragePath}/tasks/${taskId}`)),
	getSettingsDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath) => Promise.resolve(`${globalStoragePath}/settings`)),
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockImplementation(() => false),
}))

// ── Test Helpers ─────────────────────────────────────────────────────────────

function makeMockProvider(mockExtensionContext: vscode.ExtensionContext, mockOutputChannel: vscode.OutputChannel) {
	const provider = new ClineProvider(
		mockExtensionContext,
		mockOutputChannel,
		"sidebar",
		new ContextProxy(mockExtensionContext),
	) as unknown as Record<string, unknown>

	provider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
	provider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
	provider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
	provider.getState = vi.fn().mockResolvedValue({})
	return provider
}

function makeMockExtensionContext(): vscode.ExtensionContext {
	return {
		globalState: {
			get: vi.fn().mockImplementation((_key: keyof GlobalState) => undefined),
			update: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
			keys: vi.fn().mockReturnValue([]),
		},
		globalStorageUri: {
			fsPath: path.join(os.tmpdir(), "test-storage-usage-stats"),
		},
		workspaceState: {
			get: vi.fn().mockImplementation((_key) => undefined),
			update: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
			keys: vi.fn().mockReturnValue([]),
		},
		secrets: {
			get: vi.fn().mockImplementation((_key) => Promise.resolve(undefined)),
			store: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
			delete: vi.fn().mockImplementation((_key) => Promise.resolve()),
		},
		extensionUri: {
			fsPath: "/mock/extension/path",
		},
		extension: {
			packageJSON: {
				version: "1.0.0",
			},
		},
	} as unknown as vscode.ExtensionContext
}

function makeMockApiConfig(): ProviderSettings {
	return {
		apiProvider: "anthropic",
		apiModelId: "claude-3-5-sonnet-20241022",
		apiKey: "test-api-key",
	}
}

function makeMockOutputChannel() {
	return {
		appendLine: vi.fn(),
		append: vi.fn(),
		clear: vi.fn(),
		show: vi.fn(),
		hide: vi.fn(),
		dispose: vi.fn(),
	}
}

function makeRecordingContext(overrides?: Partial<UsageRecordingContext>): UsageRecordingContext {
	return {
		taskId: "test-task-001",
		provider: "anthropic",
		model: "claude-3-5-sonnet-20241022",
		mode: "code",
		attempt: 0,
		inputTokens: 100,
		outputTokens: 200,
		cacheWriteTokens: 10,
		cacheReadTokens: 5,
		totalCost: 0.001,
		cacheReadInInput: "unknown",
		cacheWriteInInput: "unknown",
		reasoningInOutput: "unknown",
		costSource: "provider",
		tokenSource: "provider",
		...overrides,
	}
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Usage Stats Recording", () => {
	let mockProvider: ClineProvider
	let mockApiConfig: ProviderSettings
	let mockOutputChannel: vscode.OutputChannel
	let mockExtensionContext: vscode.ExtensionContext

	beforeEach(() => {
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		mockExtensionContext = makeMockExtensionContext()
		mockOutputChannel = makeMockOutputChannel() as unknown as vscode.OutputChannel
		mockProvider = makeMockProvider(mockExtensionContext, mockOutputChannel) as unknown as ClineProvider
		mockApiConfig = makeMockApiConfig()
	})

	// ── UsageRecorder Unit Tests ──────────────────────────────────────────────

	describe("UsageRecorder", () => {
		it("should initialize usageRecorder on Task construction", () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// usageRecorder should be initialized (not null)
			// We access it via the private property for testing
			expect((task as unknown as Record<string, unknown>).usageRecorder).toBeDefined()
			expect((task as unknown as Record<string, unknown>).usageRecorder).not.toBeNull()
			expect((task as unknown as Record<string, unknown>).usageRecorder).toBeInstanceOf(UsageRecorder)
		})

		it("should record exactly one event per terminal finalize call", async () => {
			const mockStore = {
				append: vi.fn().mockResolvedValue(true),
				initialize: vi.fn().mockResolvedValue(undefined),
			} as unknown as UsageEventStore
			const recorder = new UsageRecorder(mockStore)

			const ctx = makeRecordingContext()
			await recorder.finalizeUsageEvent("task-1:0", "completed", ctx)

			expect(mockStore.append).toHaveBeenCalledTimes(1)
			const recordedEvent = (mockStore.append as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
			expect(recordedEvent.schemaVersion).toBe(1)
			expect(recordedEvent.status).toBe("completed")
			expect(recordedEvent.taskId).toBe("test-task-001")
			expect(recordedEvent.provider).toBe("anthropic")
			expect(recordedEvent.usage.inputTokens.value).toBe(100)
			expect(recordedEvent.usage.outputTokens.value).toBe(200)
			expect(recordedEvent.usage.costUsd.value).toBe(0.001)
			expect(recordedEvent.provenance).toBe("live")
		})

		it("should not record duplicate events for same requestKey + status (idempotency)", async () => {
			const mockStore = {
				append: vi.fn().mockResolvedValue(true),
				initialize: vi.fn().mockResolvedValue(undefined),
			} as unknown as UsageEventStore
			const recorder = new UsageRecorder(mockStore)

			const ctx = makeRecordingContext()
			const requestKey = "task-1:0"

			// First call should record
			await recorder.finalizeUsageEvent(requestKey, "completed", ctx)
			expect(mockStore.append).toHaveBeenCalledTimes(1)

			// Second call with same key + status should be deduplicated
			await recorder.finalizeUsageEvent(requestKey, "completed", ctx)
			expect(mockStore.append).toHaveBeenCalledTimes(1)

			// Different status for same requestKey should record (failed vs completed)
			await recorder.finalizeUsageEvent(requestKey, "failed", ctx)
			expect(mockStore.append).toHaveBeenCalledTimes(2)
		})

		it("should record separate events for different attempts", async () => {
			const mockStore = {
				append: vi.fn().mockResolvedValue(true),
				initialize: vi.fn().mockResolvedValue(undefined),
			} as unknown as UsageEventStore
			const recorder = new UsageRecorder(mockStore)

			const ctx0 = makeRecordingContext({ attempt: 0 })
			const ctx1 = makeRecordingContext({ attempt: 1, inputTokens: 150 })

			await recorder.finalizeUsageEvent("task-1:0", "completed", ctx0)
			await recorder.finalizeUsageEvent("task-1:1", "completed", ctx1)

			expect(mockStore.append).toHaveBeenCalledTimes(2)
			const event0 = (mockStore.append as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
			const event1 = (mockStore.append as unknown as ReturnType<typeof vi.fn>).mock.calls[1][0]
			expect(event0.attempt).toBe(0)
			expect(event1.attempt).toBe(1)
			expect(event1.usage.inputTokens.value).toBe(150)
		})

		it("should not throw when store.append fails (error isolation)", async () => {
			const mockStore = {
				append: vi.fn().mockRejectedValue(new Error("disk full")),
				initialize: vi.fn().mockResolvedValue(undefined),
			} as unknown as UsageEventStore
			const recorder = new UsageRecorder(mockStore)

			const ctx = makeRecordingContext()

			// Should not throw
			await expect(recorder.finalizeUsageEvent("task-1:0", "completed", ctx)).resolves.toBeUndefined()
			expect(mockStore.append).toHaveBeenCalledTimes(1)
		})

		it("should omit token fields with zero values", async () => {
			const mockStore = {
				append: vi.fn().mockResolvedValue(true),
				initialize: vi.fn().mockResolvedValue(undefined),
			} as unknown as UsageEventStore
			const recorder = new UsageRecorder(mockStore)

			const ctx = makeRecordingContext({
				inputTokens: 0,
				outputTokens: 0,
				cacheWriteTokens: 0,
				cacheReadTokens: 0,
				totalCost: undefined,
			})

			await recorder.finalizeUsageEvent("task-1:0", "completed", ctx)

			const recordedEvent = (mockStore.append as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
			expect(recordedEvent.usage.inputTokens).toBeUndefined()
			expect(recordedEvent.usage.outputTokens).toBeUndefined()
			expect(recordedEvent.usage.cacheWriteTokens).toBeUndefined()
			expect(recordedEvent.usage.cacheReadTokens).toBeUndefined()
			expect(recordedEvent.usage.costUsd).toBeUndefined()
		})

		it("should include parentTaskId when provided", async () => {
			const mockStore = {
				append: vi.fn().mockResolvedValue(true),
				initialize: vi.fn().mockResolvedValue(undefined),
			} as unknown as UsageEventStore
			const recorder = new UsageRecorder(mockStore)

			const ctx = makeRecordingContext({ parentTaskId: "parent-task-001" })
			await recorder.finalizeUsageEvent("task-1:0", "completed", ctx)

			const recordedEvent = (mockStore.append as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
			expect(recordedEvent.parentTaskId).toBe("parent-task-001")
		})

		it("should generate unique eventId for each event", async () => {
			const mockStore = {
				append: vi.fn().mockResolvedValue(true),
				initialize: vi.fn().mockResolvedValue(undefined),
			} as unknown as UsageEventStore
			const recorder = new UsageRecorder(mockStore)

			const ctx = makeRecordingContext()
			await recorder.finalizeUsageEvent("task-1:0", "completed", ctx)
			await recorder.finalizeUsageEvent("task-2:0", "completed", ctx)

			const event1 = (mockStore.append as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
			const event2 = (mockStore.append as unknown as ReturnType<typeof vi.fn>).mock.calls[1][0]
			expect(event1.eventId).not.toBe(event2.eventId)
		})

		it("should set idempotencyKey as requestKey:status", async () => {
			const mockStore = {
				append: vi.fn().mockResolvedValue(true),
				initialize: vi.fn().mockResolvedValue(undefined),
			} as unknown as UsageEventStore
			const recorder = new UsageRecorder(mockStore)

			const ctx = makeRecordingContext()
			await recorder.finalizeUsageEvent("task-42:3", "cancelled", ctx)

			const recordedEvent = (mockStore.append as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
			expect(recordedEvent.idempotencyKey).toBe("task-42:3:cancelled")
		})

		it("should set occurredAt as valid ISO 8601 string", async () => {
			const mockStore = {
				append: vi.fn().mockResolvedValue(true),
				initialize: vi.fn().mockResolvedValue(undefined),
			} as unknown as UsageEventStore
			const recorder = new UsageRecorder(mockStore)

			const ctx = makeRecordingContext()
			await recorder.finalizeUsageEvent("task-1:0", "completed", ctx)

			const recordedEvent = (mockStore.append as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
			const date = new Date(recordedEvent.occurredAt)
			expect(date.getTime()).not.toBeNaN()
		})

		it("should set semantics fields from context", async () => {
			const mockStore = {
				append: vi.fn().mockResolvedValue(true),
				initialize: vi.fn().mockResolvedValue(undefined),
			} as unknown as UsageEventStore
			const recorder = new UsageRecorder(mockStore)

			const ctx = makeRecordingContext({
				cacheReadInInput: "included",
				cacheWriteInInput: "excluded",
				reasoningInOutput: "unknown",
			})
			await recorder.finalizeUsageEvent("task-1:0", "completed", ctx)

			const recordedEvent = (mockStore.append as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
			expect(recordedEvent.semantics.cacheReadInInput).toBe("included")
			expect(recordedEvent.semantics.cacheWriteInInput).toBe("excluded")
			expect(recordedEvent.semantics.reasoningInOutput).toBe("unknown")
		})
	})

	// ── Task Integration Tests ────────────────────────────────────────────────

	describe("Task integration", () => {
		it("should construct usageRecorder as non-null when globalStoragePath is valid", () => {
			// The Task constructor wraps UsageEventStore/UsageRecorder initialization
			// in a try-catch. With a valid globalStoragePath, the recorder should be
			// successfully constructed (store initialization is deferred to first append).
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// usageRecorder should be a UsageRecorder instance (not null)
			expect((task as unknown as Record<string, unknown>).usageRecorder).not.toBeNull()
			expect((task as unknown as Record<string, unknown>).usageRecorder).toBeInstanceOf(UsageRecorder)
		})

		it("should have usageRecorder accessible as private property", () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// The property should exist
			expect((task as unknown as Record<string, unknown>).usageRecorder).toBeDefined()
		})

		it("should construct UsageRecorder with globalStoragePath from provider context", () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const recorder = (task as unknown as Record<string, unknown>).usageRecorder as UsageRecorder
			expect(recorder).toBeInstanceOf(UsageRecorder)
			// The recorder should have a store that was constructed with the globalStoragePath
			expect((recorder as unknown as Record<string, unknown>)["store"]).toBeDefined()
		})
	})

	// ── Terminal Finalize Boundary Tests ─────────────────────────────────────

	describe("Terminal finalize boundary", () => {
		it("should use taskId:attempt as requestKey format", async () => {
			const mockStore = {
				append: vi.fn().mockResolvedValue(true),
				initialize: vi.fn().mockResolvedValue(undefined),
			} as unknown as UsageEventStore
			const recorder = new UsageRecorder(mockStore)

			const ctx = makeRecordingContext({ taskId: "abc-123", attempt: 5 })
			await recorder.finalizeUsageEvent("abc-123:5", "completed", ctx)

			const recordedEvent = (mockStore.append as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
			// idempotencyKey = requestKey:status
			expect(recordedEvent.idempotencyKey).toBe("abc-123:5:completed")
			expect(recordedEvent.taskId).toBe("abc-123")
			expect(recordedEvent.attempt).toBe(5)
		})

		it("should distinguish completed, failed, and cancelled for same request", async () => {
			const mockStore = {
				append: vi.fn().mockResolvedValue(true),
				initialize: vi.fn().mockResolvedValue(undefined),
			} as unknown as UsageEventStore
			const recorder = new UsageRecorder(mockStore)

			const ctx = makeRecordingContext()
			const requestKey = "task-1:0"

			await recorder.finalizeUsageEvent(requestKey, "completed", ctx)
			await recorder.finalizeUsageEvent(requestKey, "failed", ctx)
			await recorder.finalizeUsageEvent(requestKey, "cancelled", ctx)

			// All three should be recorded (different statuses)
			expect(mockStore.append).toHaveBeenCalledTimes(3)
			const statuses = (mockStore.append as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
				(c: Record<string, unknown>[]) => c[0].status,
			)
			expect(statuses).toContain("completed")
			expect(statuses).toContain("failed")
			expect(statuses).toContain("cancelled")
		})
	})
})
