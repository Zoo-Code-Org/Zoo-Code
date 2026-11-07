// pnpm --filter roo-cline test core/task/__tests__/Task.session-title.spec.ts

import * as os from "os"
import * as path from "path"

import type { GlobalState, HistoryItem, ProviderSettings } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"

const { mockGenerateSessionTitle, mockSaveTaskMessages, mockSaveApiMessages } = vi.hoisted(() => ({
	mockGenerateSessionTitle: vi.fn(),
	mockSaveTaskMessages: vi.fn().mockResolvedValue(undefined),
	mockSaveApiMessages: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../session-title", () => ({
	generateSessionTitle: mockGenerateSessionTitle,
}))

// vscode is globally aliased to __mocks__/vscode.js by vitest.config.ts.
vi.mock("delay", () => ({ __esModule: true, default: vi.fn().mockResolvedValue(undefined) }))
vi.mock("execa", () => ({ execa: vi.fn() }))
vi.mock("p-wait-for", () => ({ default: vi.fn().mockResolvedValue(undefined) }))

vi.mock("../../task-persistence", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../../task-persistence")>()
	return {
		...mod,
		saveApiMessages: mockSaveApiMessages,
		saveTaskMessages: mockSaveTaskMessages,
		TaskHistoryStore: vi.fn().mockImplementation(function () {
			return {
				initialize: vi.fn().mockResolvedValue(undefined),
				dispose: vi.fn(),
				get: vi.fn(),
				getAll: vi.fn().mockReturnValue([]),
				upsert: vi.fn().mockResolvedValue([]),
				delete: vi.fn().mockResolvedValue(undefined),
				deleteMany: vi.fn().mockResolvedValue(undefined),
				reconcile: vi.fn().mockResolvedValue(undefined),
				initialized: Promise.resolve(),
			}
		}),
	}
})

vi.mock("../../mentions", () => ({
	parseMentions: vi
		.fn()
		.mockImplementation((text) =>
			Promise.resolve({ text: `processed: ${text}`, mode: undefined, contentBlocks: [] }),
		),
	openMention: vi.fn(),
	getLatestTerminalOutput: vi.fn(),
}))

vi.mock("../../mentions/processUserContentMentions", () => ({
	processUserContentMentions: vi.fn().mockImplementation(async ({ userContent }: { userContent: unknown[] }) => ({
		content: userContent,
		mode: undefined,
	})),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockResolvedValue(""),
}))

vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue(""),
}))

vi.mock("../../ignore/RooIgnoreController")

vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: vi
		.fn()
		.mockImplementation((base: string, id: string) => Promise.resolve(`${base}/tasks/${id}`)),
	getSettingsDirectoryPath: vi.fn().mockImplementation((base: string) => Promise.resolve(`${base}/settings`)),
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockReturnValue(false),
}))

vi.mock("../../../i18n", () => ({
	t: (key: string) => key,
}))

function makeMockProvider() {
	return {
		log: vi.fn(),
		taskHistoryStore: { get: () => undefined },
		updateTaskHistory: vi.fn().mockResolvedValue([]),
		applyGeneratedSessionTitle: vi.fn().mockResolvedValue(true),
		getState: vi.fn().mockResolvedValue({}),
		getSkillsManager: vi.fn().mockReturnValue(undefined),
		postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
		flushPostStateToWebviewThrottled: vi.fn().mockResolvedValue(undefined),
		postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		postStateToWebviewThrottled: vi.fn().mockResolvedValue(undefined),
		context: {
			globalStorageUri: { fsPath: path.join(os.tmpdir(), "test-storage-session-title") },
			globalState: {
				get: vi.fn().mockImplementation((_key: keyof GlobalState) => undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			workspaceState: {
				get: vi.fn().mockImplementation(() => undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn().mockResolvedValue(undefined),
				store: vi.fn().mockResolvedValue(undefined),
				delete: vi.fn().mockResolvedValue(undefined),
			},
			extensionUri: { fsPath: "/mock/extension" },
			extension: { packageJSON: { version: "1.0.0" } },
		},
	}
}

const mockApiConfig: ProviderSettings = {
	apiProvider: providerIdentifiers.anthropic,
	apiModelId: "claude-3-5-sonnet-20241022",
	apiKey: "test-api-key",
}

describe("Task session title generation", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockSaveTaskMessages.mockResolvedValue(undefined)
		mockGenerateSessionTitle.mockResolvedValue("Login bug fix")

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}
	})

	function makeTask(provider: unknown, overrides: Record<string, unknown> = {}): Task {
		return new Task({
			provider: provider as unknown as ClineProvider,
			apiConfiguration: mockApiConfig,
			task: "Fix the login bug",
			startTask: false,
			...overrides,
		})
	}

	it("starts title generation in the background when a new root task starts", async () => {
		const mockProvider = makeMockProvider()
		const task = makeTask(mockProvider)
		vi.spyOn(task as never, "initiateTaskLoop").mockResolvedValue(undefined)

		await task["startTask"]("Fix the login bug")

		expect(mockGenerateSessionTitle).toHaveBeenCalledWith(task.api, "Fix the login bug", { taskId: task.taskId })
		// Fire-and-forget: the write happens in the background, not awaited by startTask.
		await vi.waitFor(() => {
			expect(mockProvider.applyGeneratedSessionTitle).toHaveBeenCalledWith(task.taskId, "Login bug fix")
		})
	})

	it("passes the generated title through the provider write path", async () => {
		mockGenerateSessionTitle.mockResolvedValue("  Generated title  ")
		const mockProvider = makeMockProvider()
		const task = makeTask(mockProvider)

		task["generateSessionTitleInBackground"]("Fix the login bug")

		await vi.waitFor(() => {
			expect(mockProvider.applyGeneratedSessionTitle).toHaveBeenCalledWith(task.taskId, "  Generated title  ")
		})
	})

	it("does not generate a title for a subtask", () => {
		const mockProvider = makeMockProvider()
		const parentTask = { taskId: "parent-1" } as Task
		const task = makeTask(mockProvider, { task: "child task", parentTask })

		expect(task.parentTaskId).toBe("parent-1")

		task["generateSessionTitleInBackground"]("child task message")

		expect(mockGenerateSessionTitle).not.toHaveBeenCalled()
		expect(mockProvider.applyGeneratedSessionTitle).not.toHaveBeenCalled()
	})

	it("does not generate a title for a task resumed from history", () => {
		const mockProvider = makeMockProvider()
		const historyItem = { id: "resumed-1", task: "Fix the login bug" } as HistoryItem
		const task = makeTask(mockProvider, { task: undefined, images: undefined, historyItem })

		expect(task["_isHistoryTask"]).toBe(true)

		task["generateSessionTitleInBackground"]("Fix the login bug")

		expect(mockGenerateSessionTitle).not.toHaveBeenCalled()
		expect(mockProvider.applyGeneratedSessionTitle).not.toHaveBeenCalled()
	})

	it("does not generate a title for an empty first message", () => {
		const mockProvider = makeMockProvider()
		const task = makeTask(mockProvider)

		task["generateSessionTitleInBackground"]("")

		expect(mockGenerateSessionTitle).not.toHaveBeenCalled()
		expect(mockProvider.applyGeneratedSessionTitle).not.toHaveBeenCalled()
	})

	it("never lets a generation failure escape to the chat", async () => {
		mockGenerateSessionTitle.mockRejectedValue(new Error("provider down"))
		const mockProvider = makeMockProvider()
		const task = makeTask(mockProvider)

		expect(() => task["generateSessionTitleInBackground"]("Fix the login bug")).not.toThrow()

		await vi.waitFor(() => {
			expect(mockGenerateSessionTitle).toHaveBeenCalled()
		})
		// Let the rejection settle inside the background chain.
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(mockProvider.applyGeneratedSessionTitle).not.toHaveBeenCalled()
	})
})
