// npx vitest run src/core/task/__tests__/Task.new-task-effort.spec.ts
//
// DTE series 5/5 — new_task thinking effort plumbing on Task:
// resolveNewTaskEffectiveEffort (task-local override → settings reasoningEffort
// → model default, with the settings "disable" sentinel mapped to undefined),
// the single-consume takeNewTaskAskThinkingEffort, the ask-response capture in
// handleWebviewAskResponse, and the dispose() discard.

import { ProviderSettings } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"

// Mock dependencies (same lightweight set as Task.runtime-thinking-effort.test.ts)
vi.mock("../../webview/ClineProvider")
vi.mock("../../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: {
		releaseTerminalsForTask: vi.fn(),
	},
}))
vi.mock("../../ignore/RooIgnoreController")
vi.mock("../../protect/RooProtectedController")
vi.mock("../../context-tracking/FileContextTracker")
vi.mock("../../../integrations/editor/DiffViewProvider")
vi.mock("../../tools/ToolRepetitionDetector")

// The model info object the mocked API handler reports; tests mutate it to steer
// the model-default branch of resolveNewTaskEffectiveEffort.
const { modelInfo } = vi.hoisted(() => ({
	modelInfo: {} as { reasoningEffort?: string },
}))

vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn(() => ({
		getModel: () => ({ info: modelInfo, id: "test-model" }),
	})),
}))

// Mock TelemetryService
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureTaskCreated: vi.fn(),
			captureTaskRestarted: vi.fn(),
		},
	},
}))

// Mock task persistence to avoid disk writes
vi.mock("../../task-persistence", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../task-persistence")>()),
	readApiMessages: vi.fn().mockResolvedValue([]),
	saveApiMessages: vi.fn().mockResolvedValue(undefined),
	readTaskMessages: vi.fn().mockResolvedValue([]),
	saveTaskMessages: vi.fn().mockResolvedValue(undefined),
	taskMetadata: vi.fn().mockResolvedValue({
		historyItem: {
			id: "test-task-id",
			number: 1,
			task: "Test task",
			ts: Date.now(),
			totalCost: 0.01,
			tokensIn: 100,
			tokensOut: 50,
		},
		tokenUsage: {
			totalTokensIn: 100,
			totalTokensOut: 50,
			totalCost: 0.01,
			contextTokens: 150,
			totalCacheWrites: 0,
			totalCacheReads: 0,
		},
	}),
}))

describe("Task new_task thinking effort (DTE series 5/5)", () => {
	let mockProvider: Record<string, unknown>
	let mockApiConfiguration: ProviderSettings
	let task: Task

	const makeTask = (apiConfiguration: ProviderSettings) =>
		new Task({
			// mockProvider is a minimal structural double (ClineProvider is auto-mocked
			// by the vi.mock above); the task only touches the members supplied here.
			provider: mockProvider as unknown as ClineProvider,
			apiConfiguration,
			startTask: false,
		})

	beforeEach(() => {
		vi.clearAllMocks()
		vi.useFakeTimers()
		modelInfo.reasoningEffort = undefined

		mockProvider = {
			context: {
				globalStorageUri: { fsPath: "/test/path" },
			},
			getState: vi.fn().mockResolvedValue({ mode: "code" }),
			log: vi.fn(),
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
			postStateToWebviewThrottled: vi.fn().mockResolvedValue(undefined),
			flushPostStateToWebviewThrottled: vi.fn().mockResolvedValue(undefined),
			updateTaskHistory: vi.fn().mockResolvedValue(undefined),
		}

		mockApiConfiguration = {
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "claude-opus-4-7",
			apiKey: "test-key",
			reasoningEffort: "low",
		} as ProviderSettings

		task = makeTask(mockApiConfiguration)
	})

	afterEach(() => {
		vi.useRealTimers()
		if (task && !task.abort) {
			task.dispose()
		}
	})

	describe("resolveNewTaskEffectiveEffort", () => {
		it("prefers the task-local runtime override", () => {
			task.setRuntimeThinkingEffort("xhigh", "source")

			expect(task.resolveNewTaskEffectiveEffort()).toBe("xhigh")
		})

		it("falls back to the settings reasoningEffort without an override", () => {
			expect(task.resolveNewTaskEffectiveEffort()).toBe("low")
		})

		it("falls back to the model default when settings carries no effort", () => {
			modelInfo.reasoningEffort = "high"
			const noSettingsTask = makeTask({
				apiProvider: providerIdentifiers.anthropic,
				apiModelId: "claude-opus-4-7",
				apiKey: "test-key",
			} as ProviderSettings)

			expect(noSettingsTask.resolveNewTaskEffectiveEffort()).toBe("high")
			noSettingsTask.dispose()
		})

		it("maps the settings 'disable' sentinel to undefined", () => {
			const disableTask = makeTask({
				apiProvider: providerIdentifiers.anthropic,
				apiModelId: "claude-opus-4-7",
				apiKey: "test-key",
				reasoningEffort: "disable",
			} as ProviderSettings)

			expect(disableTask.resolveNewTaskEffectiveEffort()).toBeUndefined()
			disableTask.dispose()
		})
	})

	describe("takeNewTaskAskThinkingEffort", () => {
		it("is empty until the ask response carries a selection", () => {
			expect(task.takeNewTaskAskThinkingEffort()).toBeUndefined()
		})

		it("stores the selection from handleWebviewAskResponse and consumes it once", () => {
			task.handleWebviewAskResponse("yesButtonClicked", undefined, undefined, "high")

			expect(task.takeNewTaskAskThinkingEffort()).toBe("high")
			// Consumed: a second read (or a later, different ask) cannot reuse it.
			expect(task.takeNewTaskAskThinkingEffort()).toBeUndefined()
		})

		it("leaves a stored selection untouched when a later response carries none", () => {
			task.handleWebviewAskResponse("yesButtonClicked", undefined, undefined, "medium")
			// A non-new_task response never carries the field, so the stored value
			// survives until the new_task approval consumes it.
			task.handleWebviewAskResponse("yesButtonClicked", undefined, undefined)

			expect(task.takeNewTaskAskThinkingEffort()).toBe("medium")
		})
	})

	describe("dispose", () => {
		it("discards the pending ask-block selection at task end", () => {
			task.handleWebviewAskResponse("yesButtonClicked", undefined, undefined, "max")
			task.dispose()

			expect(task.takeNewTaskAskThinkingEffort()).toBeUndefined()
		})
	})
})
