// npx vitest run core/task/__tests__/Task.abort-reason-race.spec.ts

import * as os from "os"
import * as path from "path"

import type { GlobalState, ProviderSettings } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"
import { findLast } from "../../../shared/array"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"

const { mockSaveTaskMessages, mockSaveApiMessages } = vi.hoisted(() => ({
	mockSaveTaskMessages: vi.fn().mockResolvedValue(undefined),
	mockSaveApiMessages: vi.fn().mockResolvedValue(undefined),
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
		getState: vi.fn().mockResolvedValue({}),
		getSkillsManager: vi.fn().mockReturnValue(undefined),
		postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
		flushPostStateToWebviewThrottled: vi.fn().mockResolvedValue(undefined),
		postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		postStateToWebviewThrottled: vi.fn().mockResolvedValue(undefined),
		context: {
			globalStorageUri: { fsPath: path.join(os.tmpdir(), "test-storage-abort-race") },
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

describe("Task abort-reason race (RSK-19 regression)", () => {
	let mockApiConfig: ProviderSettings

	beforeEach(() => {
		vi.clearAllMocks()
		mockSaveTaskMessages.mockResolvedValue(undefined)

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		mockApiConfig = {
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		}
	})

	it("keeps user_cancelled when a cancel lands during abortStream cleanup", async () => {
		const mockProvider = makeMockProvider()

		// Double cast: plain object satisfies only the methods called by this code path.
		const task = new Task({
			provider: mockProvider as unknown as ClineProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})

		vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
		vi.spyOn(task, "dispose").mockResolvedValue(undefined)
		const abortTaskSpy = vi.spyOn(task, "abortTask")

		// eslint-disable-next-line require-yield -- intentional error-only async source
		task["attemptApiRequest"] = async function* () {
			throw new Error("mid-stream API failure")
		}

		// abortStream calls updateApiReqMsg("streaming_failed") synchronously before saving,
		// so the api_req_started row has cancelReason="streaming_failed" when we are inside it.
		mockSaveTaskMessages.mockImplementation(async () => {
			const apiReqMsg = findLast(task.clineMessages, (m) => m.say === "api_req_started")
			const parsed = apiReqMsg?.text ? (JSON.parse(apiReqMsg.text) as { cancelReason?: string }) : {}
			if (parsed.cancelReason === "streaming_failed" && !task.didFinishAbortingStream) {
				// cancelTask sets abortReason before abort=true.
				task["abortReason"] = "user_cancelled"
				task["abort"] = true
			}
		})

		// The outer catch in recursivelyMakeClineRequests swallows the abort throw and returns true.
		const result = await task.recursivelyMakeClineRequests([{ type: "text", text: "help me" }])
		expect(result).toBe(true)
		expect(abortTaskSpy).toHaveBeenCalledOnce()
		expect(task.abortReason).toBe("user_cancelled")
	})
})
