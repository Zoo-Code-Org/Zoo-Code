// npx vitest run core/task/__tests__/Task.session-title.spec.ts

import type { HistoryItem, ProviderSettings } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import type { GenerateSessionTitleOptions } from "../session-title"

vi.mock("../session-title", () => ({
	generateSessionTitle: vi.fn().mockResolvedValue(undefined),
}))

// Import the mocked module for spy access.
import { generateSessionTitle } from "../session-title"

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		hasInstance: vi.fn().mockReturnValue(true),
		createInstance: vi.fn(),
		get instance() {
			return {
				captureTaskCreated: vi.fn(),
				captureTaskRestarted: vi.fn(),
				captureModeSwitch: vi.fn(),
				captureConversationMessage: vi.fn(),
				captureLlmCompletion: vi.fn(),
				captureConsecutiveMistakeError: vi.fn(),
				captureCodeActionUsed: vi.fn(),
				setProvider: vi.fn(),
			}
		},
	},
}))

vi.mock("vscode", () => {
	const mockDisposable = { dispose: vi.fn() }

	return {
		TabInputTextDiff: vi.fn(),
		CodeActionKind: {
			QuickFix: { value: "quickfix" },
			RefactorRewrite: { value: "refactor.rewrite" },
		},
		window: {
			createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			showErrorMessage: vi.fn(),
		},
		workspace: {
			getConfiguration: vi.fn(() => ({ get: (_k: string, d: unknown) => d })),
			workspaceFolders: [{ uri: { fsPath: "/mock/workspace/path" }, name: "mock-workspace", index: 0 }],
			createFileSystemWatcher: vi.fn(() => ({
				onDidCreate: vi.fn(() => mockDisposable),
				onDidDelete: vi.fn(() => mockDisposable),
				onDidChange: vi.fn(() => mockDisposable),
				dispose: vi.fn(),
			})),
			onDidSaveTextDocument: vi.fn(() => mockDisposable),
		},
		env: { uriScheme: "vscode", language: "en" },
		EventEmitter: vi.fn(),
		Disposable: { from: vi.fn() },
		TabInputText: vi.fn(),
		version: "1.85.0",
	}
})

vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue(""),
}))

vi.mock("../../ignore/RooIgnoreController")

vi.mock("p-wait-for", () => ({
	default: vi.fn().mockImplementation(async () => Promise.resolve()),
}))

vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

type StartTaskAccess = {
	startTask: (task?: string, images?: string[]) => Promise<void>
	resumeTaskFromHistory: () => Promise<void>
	getEnabledMcpToolsCount: () => Promise<{ enabledToolCount: number; enabledServerCount: number }>
	initiateTaskLoop: (userContent: unknown[]) => Promise<void>
}

// The private-member double assertion is the established Task-spec pattern
// (see Task.spec.ts getTaskTestAccess): the spies below must reach private
// startup collaborators without widening their production visibility.
function getStartTaskAccess(task: Task): StartTaskAccess {
	return task as unknown as StartTaskAccess
}

type ProviderStateShaped = Partial<Awaited<ReturnType<ClineProvider["getState"]>>>

/**
 * The trigger path only reads provider startup collaborators; the double is
 * cast once here (AGENTS.md) naming the members tests rely on: postStateToWebviewWithoutTaskHistory,
 * getState, updateTaskHistory, log, on, off.
 */
function createMockProvider(): ClineProvider {
	return {
		context: { globalStorageUri: { fsPath: "/test/storage" } },
		getState: vi.fn().mockResolvedValue({} as ProviderStateShaped),
		log: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
		updateTaskHistory: vi.fn().mockResolvedValue(undefined),
	} as unknown as ClineProvider
}

function createTestTask(provider: ClineProvider, parentTask?: Task, historyItem?: HistoryItem): Task {
	const apiConfiguration: ProviderSettings = {
		apiProvider: providerIdentifiers.anthropic,
		apiModelId: "claude-3-5-sonnet-20241022",
		apiKey: "test-api-key",
	}

	return new Task({
		provider,
		apiConfiguration,
		// A history item must be the only task source or it is not a history
		// task; omit the task text for that case.
		task: historyItem ? undefined : "example root task",
		parentTask,
		historyItem,
		startTask: false,
	})
}

function stubStartup(task: Task): void {
	vi.spyOn(task, "say").mockResolvedValue(undefined)
	const taskAccess = getStartTaskAccess(task)
	vi.spyOn(taskAccess, "getEnabledMcpToolsCount").mockResolvedValue({ enabledToolCount: 0, enabledServerCount: 0 })
	vi.spyOn(taskAccess, "initiateTaskLoop").mockResolvedValue(undefined)
}

function lastTitleCall(): GenerateSessionTitleOptions | undefined {
	const calls = vi.mocked(generateSessionTitle).mock.calls
	return calls.length > 0 ? calls[calls.length - 1][0] : undefined
}

describe("Task#startTask session title trigger", () => {
	beforeEach(() => {
		vi.mocked(generateSessionTitle).mockClear()
	})

	it("fires title generation for a root task without awaiting it", async () => {
		const provider = createMockProvider()
		const task = createTestTask(provider)
		stubStartup(task)

		let resolved = false
		vi.mocked(generateSessionTitle).mockImplementation(async () => {
			resolved = true
		})

		await getStartTaskAccess(task).startTask("title trigger message")

		const call = lastTitleCall()
		expect(call).toBeDefined()
		expect(call?.taskId).toBe(task.taskId)
		expect(call?.userMessage).toBe("title trigger message")
		expect(call?.provider).toBe(provider)
		// The trigger is fire-and-forget: startTask resolved and the generation
		// ran to completion without startTask ever awaiting it beyond its own
		// synchronous promise chain.
		expect(resolved).toBe(true)
	})

	it("starts title generation only after the first message is stored", async () => {
		const provider = createMockProvider()
		const task = createTestTask(provider)
		stubStartup(task)

		let releaseSay: () => void = () => {}
		vi.spyOn(task, "say").mockImplementation(
			() =>
				new Promise<undefined>((resolve) => {
					releaseSay = () => resolve(undefined)
				}),
		)

		const started = getStartTaskAccess(task).startTask("stored first")
		await Promise.resolve()
		expect(vi.mocked(generateSessionTitle)).not.toHaveBeenCalled()

		releaseSay()
		await started

		expect(lastTitleCall()?.userMessage).toBe("stored first")
	})

	it("does not wait for a pending title before starting the task loop", async () => {
		const provider = createMockProvider()
		const task = createTestTask(provider)
		stubStartup(task)

		let releaseTitle: () => void = () => {}
		vi.mocked(generateSessionTitle).mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					releaseTitle = resolve
				}),
		)

		// startTask resolving while the title promise is still pending proves it is not awaited.
		await getStartTaskAccess(task).startTask("slow title message")

		expect(getStartTaskAccess(task).initiateTaskLoop).toHaveBeenCalled()
		expect(lastTitleCall()?.userMessage).toBe("slow title message")
		releaseTitle()
	})

	it.each([
		["Production", 1, true],
		["Development", 2, true],
		["Test", 3, false],
	])("in %s extension mode fires title generation: %s", async (_name, extensionMode, shouldFire) => {
		const provider = createMockProvider()
		// The double only carries the context members the trigger reads.
		Object.assign(provider.context, { extensionMode })
		const task = createTestTask(provider)
		stubStartup(task)

		await getStartTaskAccess(task).startTask("mode gated message")

		expect(vi.mocked(generateSessionTitle).mock.calls.length > 0).toBe(shouldFire)
	})

	it("does not fire for a subtask", async () => {
		const provider = createMockProvider()
		const parentTask = createTestTask(provider)
		const childTask = createTestTask(provider, parentTask)
		stubStartup(childTask)

		await getStartTaskAccess(childTask).startTask("child task message")

		expect(vi.mocked(generateSessionTitle)).not.toHaveBeenCalled()
	})

	it("does not fire when the root message is empty", async () => {
		const provider = createMockProvider()
		const task = createTestTask(provider)
		stubStartup(task)

		await getStartTaskAccess(task).startTask(undefined)

		expect(vi.mocked(generateSessionTitle)).not.toHaveBeenCalled()
	})

	it("routes a history task away from startTask, so resumes never trigger", async () => {
		const provider = createMockProvider()
		const historyItem: HistoryItem = {
			id: "resume-title-task",
			number: 3,
			task: "historical task",
			ts: Date.now() - 60_000,
			tokensIn: 10,
			tokensOut: 5,
			totalCost: 0.01,
		}
		// A history item with no task text marks the task as a history task, so
		// run() routes through resumeTaskFromHistory and never reaches the
		// startTask trigger (Task.ts `_isHistoryTask` routing).
		const task = createTestTask(provider, undefined, historyItem)
		const taskAccess = getStartTaskAccess(task)
		const startTaskSpy = vi.spyOn(taskAccess, "startTask")
		vi.spyOn(taskAccess, "resumeTaskFromHistory").mockResolvedValue(undefined)

		await task.run()

		expect(startTaskSpy).not.toHaveBeenCalled()
		expect(vi.mocked(generateSessionTitle)).not.toHaveBeenCalled()
	})

	it("keeps the run alive when generation rejects", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const provider = createMockProvider()
		const task = createTestTask(provider)
		stubStartup(task)
		vi.mocked(generateSessionTitle).mockRejectedValue(new Error("boom"))

		await expect(getStartTaskAccess(task).startTask("survives rejection")).resolves.toBeUndefined()
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("[Task#startTask] session title generation failed: Error: boom"),
		)
		consoleErrorSpy.mockRestore()
	})
})
