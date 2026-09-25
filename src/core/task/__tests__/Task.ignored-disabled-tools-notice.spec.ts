// npx vitest run core/task/__tests__/Task.ignored-disabled-tools-notice.spec.ts

import * as vscode from "vscode"

import type { ClineMessage, HistoryItem, ModelInfo, ProviderSettings } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import type { ApiMessage } from "../../task-persistence"

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
			getConfiguration: vi.fn(() => ({ get: (_k: string, d: unknown) => d })),
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
	getSavedClineMessages: () => Promise<ClineMessage[]>
	getSavedApiConversationHistory: () => Promise<ApiMessage[]>
	initiateTaskLoop: (userContent: unknown[]) => Promise<void>
}

// The private-member double assertion is the established Task-spec pattern
// (see Task.spec.ts getTaskTestAccess): the spies below must reach private
// startup collaborators without widening their production visibility.
function getStartTaskAccess(task: Task): StartTaskAccess {
	return task as unknown as StartTaskAccess
}

type ProviderStateShaped = Partial<Awaited<ReturnType<ClineProvider["getState"]>>> & {
	disabledTools?: string[]
}

function createMockProvider(disabledTools: string[] | undefined): ClineProvider {
	const providerState = { disabledTools } as ProviderStateShaped
	return {
		context: {
			globalStorageUri: { fsPath: "/test/storage" },
		},
		getState: vi.fn().mockResolvedValue(providerState),
		log: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
		updateTaskHistory: vi.fn().mockResolvedValue(undefined),
		// ClineProvider's surface is too broad to type this fixture fully; double assertion is the last resort (AGENTS.md) — only task-scoped fields are read.
	} as unknown as ClineProvider
}

async function startTaskWithDisabledTools(disabledTools: string[] | undefined, profileExcludedTools?: string[]) {
	const mockProvider = createMockProvider(disabledTools)

	const apiConfiguration: ProviderSettings = {
		apiProvider: providerIdentifiers.anthropic,
		apiModelId: "claude-3-5-sonnet-20241022",
		apiKey: "test-api-key",
	}

	const task = new Task({
		provider: mockProvider,
		apiConfiguration,
		task: "example task",
		startTask: false,
	})

	const saySpy = vi.spyOn(task, "say").mockResolvedValue(undefined)
	// The model-profile suppression route is fed through the model info, never
	// the provider state, so the fixture can vary it independently of the list.
	const modelInfo: ModelInfo = {
		contextWindow: 50_000,
		maxTokens: 1024,
		supportsPromptCache: false,
		excludedTools: profileExcludedTools,
	}
	vi.spyOn(task.api, "getModel").mockReturnValue({
		id: "claude-3-5-sonnet-20241022",
		info: modelInfo,
	})
	const taskAccess = getStartTaskAccess(task)
	vi.spyOn(taskAccess, "getEnabledMcpToolsCount").mockResolvedValue({
		enabledToolCount: 0,
		enabledServerCount: 0,
	})
	vi.spyOn(taskAccess, "initiateTaskLoop").mockResolvedValue(undefined)

	await taskAccess.startTask("example task")

	return saySpy.mock.calls.filter(([type]) => type === "ignored_disabled_tools_warning")
}

async function resumeTaskWithDisabledTools(disabledTools: string[] | undefined) {
	const mockProvider = createMockProvider(disabledTools)

	const apiConfiguration: ProviderSettings = {
		apiProvider: providerIdentifiers.anthropic,
		apiModelId: "claude-3-5-sonnet-20241022",
		apiKey: "test-api-key",
	}

	const historyItem: HistoryItem = {
		id: "resume-notice-task",
		number: 7,
		task: "historical task",
		ts: Date.now() - 60_000,
		tokensIn: 10,
		tokensOut: 5,
		totalCost: 0.01,
	}

	const task = new Task({
		provider: mockProvider,
		apiConfiguration,
		historyItem,
		startTask: false,
	})

	const saySpy = vi.spyOn(task, "say").mockResolvedValue(undefined)
	const askSpy = vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked" })
	// Persisted-history reads are stubbed so the resume path drives entirely in
	// memory; the saved API history ends on an assistant turn, the ordinary
	// interrupted-task shape that reaches the resume ask and loop start.
	const taskAccess = getStartTaskAccess(task)
	vi.spyOn(taskAccess, "getSavedClineMessages").mockResolvedValue([
		{ ts: historyItem.ts, type: "say", say: "text", text: "historical task" },
	])
	vi.spyOn(taskAccess, "getSavedApiConversationHistory").mockResolvedValue([
		{ role: "user", content: [{ type: "text", text: "historical task" }], ts: historyItem.ts },
		{ role: "assistant", content: [{ type: "text", text: "Working on it." }], ts: historyItem.ts + 1 },
	])
	vi.spyOn(task, "overwriteApiConversationHistory").mockResolvedValue(undefined)
	const initiateLoopSpy = vi.spyOn(taskAccess, "initiateTaskLoop").mockResolvedValue(undefined)

	await taskAccess.resumeTaskFromHistory()

	return {
		noticeCalls: saySpy.mock.calls.filter(([type]) => type === "ignored_disabled_tools_warning"),
		askSpy,
		initiateLoopSpy,
	}
}

describe("Task - ignored disabled-tools notice", () => {
	it("notifies exactly once when disabledTools lists a tool that cannot be disabled", async () => {
		const noticeCalls = await startTaskWithDisabledTools(["execute_command", "attempt_completion"])

		expect(noticeCalls).toHaveLength(1)
		const [, text, , , , , options] = noticeCalls[0]
		expect(JSON.parse(text as string)).toEqual({ ignoredTools: ["attempt_completion"] })
		expect(options).toEqual({ isNonInteractive: true })
	})

	it("stays silent when the user list is absent or names only ordinary tools", async () => {
		expect(await startTaskWithDisabledTools(undefined)).toHaveLength(0)
		expect(await startTaskWithDisabledTools([])).toHaveLength(0)
		expect(await startTaskWithDisabledTools(["execute_command", "read_file"])).toHaveLength(0)
	})

	it("stays silent when only the model profile excludes the completion tool", async () => {
		const noticeCalls = await startTaskWithDisabledTools(["execute_command"], ["attempt_completion"])

		expect(noticeCalls).toHaveLength(0)
	})

	it("still notifies when the completion tool is user-disabled and profile-excluded", async () => {
		// The notice keys on the raw user list, not the effective policy.
		const noticeCalls = await startTaskWithDisabledTools(["attempt_completion"], ["attempt_completion"])

		expect(noticeCalls).toHaveLength(1)
		expect(JSON.parse(noticeCalls[0][1] as string)).toEqual({ ignoredTools: ["attempt_completion"] })
	})

	it("stays silent when a task carrying the same disabledTools entry resumes from history", async () => {
		const { noticeCalls, askSpy, initiateLoopSpy } = await resumeTaskWithDisabledTools(["attempt_completion"])

		// Liveness: without these, the zero below could pass on a resume path
		// that returned early instead of reaching the point a notice could occur.
		expect(askSpy).toHaveBeenCalledWith("resume_task")
		expect(initiateLoopSpy).toHaveBeenCalledTimes(1)

		expect(noticeCalls).toHaveLength(0)
	})
})
