// pnpm --dir src exec vitest run core/tools/__tests__/attemptCompletionTool.backgroundRunLoop.spec.ts
//
// D5 run-loop termination (P1 permit-leak fix). The e2e replay exposed the
// defect: the D5 branch settled the host handle but never ended the child's
// own run loop, so the run promise never settled, the background scheduler
// permit leaked, and after DEFAULT_MAX_PARALLEL_SUBTASKS completions every
// later background child starved. These tests drive the REAL Task loop (real
// presentAssistantMessage, real AttemptCompletionTool) with the API request
// seam stubbed: the child must settle its run after exactly one
// attempt_completion turn, without issuing a second API request, and the late
// history writes must not regress the "completed" status.

import * as os from "os"
import * as path from "path"

import * as vscode from "vscode"
import { providerIdentifiers, type HistoryItem, type ProviderSettings } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../../task/Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { WebviewFocusTracker } from "../../webview/WebviewFocusTracker"
import { ContextProxy } from "../../config/ContextProxy"
import type { ApiStreamChunk } from "../../../api/transform/stream"

vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("uuid", async (importOriginal) => {
	const actual = await importOriginal<typeof import("uuid")>()
	return {
		...actual,
		v7: vi.fn(() => "00000000-0000-7000-8000-000000000000"),
	}
})

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

vi.mock("fs/promises", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	const mockFunctions = {
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockResolvedValue("[]"),
		unlink: vi.fn().mockResolvedValue(undefined),
		rmdir: vi.fn().mockResolvedValue(undefined),
		rm: vi.fn().mockResolvedValue(undefined),
		stat: vi.fn().mockRejectedValue({ code: "ENOENT" }),
		readdir: vi.fn().mockResolvedValue([]),
		access: vi.fn().mockResolvedValue(undefined),
	}

	return {
		...actual,
		...mockFunctions,
		default: mockFunctions,
	}
})

// p-wait-for stays REAL here: the regression hinges on the loop's own
// post-turn guard observing the latch the D5 branch sets, so the wait must
// actually poll for userMessageContentReady / abort / abandoned.

vi.mock("vscode", () => {
	const mockDisposable = { dispose: vi.fn() }

	return {
		workspace: {
			workspaceFolders: [{ uri: { fsPath: "/mock/workspace/path" }, name: "mock-workspace", index: 0 }],
			getConfiguration: vi.fn(() => ({ get: vi.fn() })),
			onDidChangeConfiguration: vi.fn(() => mockDisposable),
			createFileSystemWatcher: vi.fn(() => ({
				onDidCreate: vi.fn(() => mockDisposable),
				onDidDelete: vi.fn(() => mockDisposable),
				onDidChange: vi.fn(() => mockDisposable),
				dispose: vi.fn(),
			})),
			onDidSaveTextDocument: vi.fn(() => mockDisposable),
			fs: { stat: vi.fn().mockResolvedValue({ type: 1 }) },
		},
		window: {
			createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			visibleTextEditors: [],
			tabGroups: {
				all: [],
				close: vi.fn(),
				onDidChangeTabs: vi.fn(() => mockDisposable),
			},
			onDidChangeActiveTextEditor: vi.fn(() => mockDisposable),
			showErrorMessage: vi.fn(),
			showInformationMessage: vi.fn(),
			showWarningMessage: vi.fn(),
		},
		env: { uriScheme: "vscode", language: "en" },
		EventEmitter: vi.fn().mockImplementation(function () {
			return { event: vi.fn(), fire: vi.fn() }
		}),
		Disposable: { from: vi.fn() },
		Uri: { file: vi.fn().mockReturnValue({ toString: () => "file://test" }), joinPath: vi.fn() },
		commands: { executeCommand: vi.fn().mockResolvedValue(undefined) },
		ExtensionMode: { Production: 1, Development: 2, Test: 3 },
		version: "1.85.0",
	}
})

vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue(""),
}))

vi.mock("../../mentions/processUserContentMentions", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../mentions/processUserContentMentions")>()
	return {
		...actual,
		expandUserMentions: vi.fn().mockImplementation(actual.expandUserMentions),
	}
})

vi.mock("../../../i18n", () => ({
	t: (key: string) => key,
}))

vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath: string, taskId: string) =>
			Promise.resolve(`${globalStoragePath}/tasks/${taskId}`),
		),
	getSettingsDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath: string) => Promise.resolve(`${globalStoragePath}/settings`)),
	getGlobalStoragePath: vi.fn().mockResolvedValue("/test/storage/path"),
	getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => defaultPath),
}))

vi.mock("../../ignore/RooIgnoreController")

// The provider's TaskHistoryStore is real here so status semantics stay
// production-shaped, but its writes go through safeWriteJson: with the fs
// mock's mkdir creating no directory, the real write rejects (ENOENT on the
// advisory lock) and the terminal settlement hangs waiting on it. Stub the
// write boundary only; the in-memory cache and status transitions remain real.
vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: vi.fn().mockResolvedValue(undefined),
}))

const apiConfig: ProviderSettings = {
	apiProvider: providerIdentifiers.anthropic,
	apiModelId: "claude-3-5-sonnet-20241022",
	apiKey: "test-api-key",
}

// One complete native attempt_completion call, the shape a finished
// background investigation produces.
function attemptCompletionStream(result: string): AsyncGenerator<ApiStreamChunk> {
	return (async function* (): AsyncGenerator<ApiStreamChunk> {
		yield {
			type: "tool_call",
			id: "call_bg_complete_1",
			name: "attempt_completion",
			arguments: JSON.stringify({ result }),
		}
	})()
}

// Fails the test fast instead of hanging when the run loop never settles.
function withSettleDeadline(run: Promise<void>, ms = 5000): Promise<void> {
	return Promise.race([
		run,
		new Promise<never>((_resolve, reject) =>
			setTimeout(() => reject(new Error(`child run() did not settle within ${ms}ms`)), ms),
		),
	])
}

describe("AttemptCompletionTool D5 run-loop termination (background child permit leak)", () => {
	let mockProvider: ClineProvider
	let mockOutputChannel: vscode.OutputChannel
	let mockExtensionContext: vscode.ExtensionContext
	let warnSpy: ReturnType<typeof vi.spyOn>
	// Children built directly below never enter the provider's background
	// registry (finishBackgroundChild early-returns for unknown ids), so
	// provider disposal alone never releases their resources.
	const createdTasks: Task[] = []

	function createBackgroundChild(prompt: string): Task {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: apiConfig,
			task: prompt,
			startTask: false,
			backgroundToolPolicy: { disabledTools: ["write_to_file"], experiments: { customTools: false } },
			// P1-2: the non-interactive background-child mode derives from this
			// hosted flag (spawn path only), not from policy presence.
			backgroundChildHosted: true,
		})
		createdTasks.push(task)
		return task
	}

	function stubRequestSeam(task: Task, onExtraRequest: () => never) {
		let apiCalls = 0
		const attemptApiRequest = vi.spyOn(task, "attemptApiRequest").mockImplementation(() => {
			apiCalls += 1
			if (apiCalls > 1) {
				// A background child that already reported must never start a
				// second turn; the e2e replay looped exactly here.
				onExtraRequest()
			}
			// The real attemptApiRequestWithActiveApi captures this before
			// streaming; presentAssistantMessage refuses to run without it.
			task["requestPolicySnapshot"] = {
				disabledTools: ["write_to_file"],
				experiments: { customTools: false },
			}
			return attemptCompletionStream("child findings")
		})
		return { attemptApiRequest, callCount: () => apiCalls }
	}

	beforeEach(async () => {
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		mockExtensionContext = {
			globalState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: { fsPath: path.join(os.tmpdir(), "test-storage") },
			workspaceState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn().mockResolvedValue(undefined),
				store: vi.fn().mockResolvedValue(undefined),
				delete: vi.fn().mockResolvedValue(undefined),
			},
			extensionUri: { fsPath: "/mock/extension/path" },
			extension: { packageJSON: { version: "1.0.0" } },
			subscriptions: [],
		} as unknown as vscode.ExtensionContext

		mockOutputChannel = {
			name: "test-output",
			appendLine: vi.fn(),
			append: vi.fn(),
			replace: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		mockProvider = new ClineProvider(
			mockExtensionContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockExtensionContext),
			new WebviewFocusTracker(),
		)

		mockProvider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebviewThrottled = vi.fn().mockResolvedValue(undefined)
		mockProvider.flushPostStateToWebviewThrottled = vi.fn().mockResolvedValue(undefined)

		const state = await mockProvider.getState()
		vi.spyOn(mockProvider, "getState").mockResolvedValue({ ...state, mcpEnabled: false })
	})

	afterEach(async () => {
		// Release every child this suite constructed, including after a failed
		// assertion or a settle-deadline rejection: disposal sets the abort
		// latch, so it also unwinds a run that never reached D5. dispose() is
		// memoized, so children already released by the host are untouched.
		// Teardown failures must not mask the assertion failure under test.
		//
		// `Task.dispose()` writes to the console, so the teardown emits
		// worker->parent console RPCs while the worker is closing. Vitest reports
		// that as `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog"
		// was pending` and exits non-zero even though every test passed. The repo
		// runs with `silent: true`, so silencing it here drops no diagnostic.
		const consoleQuiet = ["log", "info", "warn", "error", "debug"].map((key) =>
			vi.spyOn(console, key as "log").mockImplementation(() => {}),
		)
		try {
			for (const task of createdTasks.splice(0)) {
				await task.dispose().catch(() => {})
			}
			await mockProvider.dispose().catch(() => {})
		} finally {
			for (const spy of consoleQuiet) {
				spy.mockRestore()
			}
		}
		warnSpy.mockRestore()
	})

	it("settles the child's run after one attempt_completion turn without a second API request", async () => {
		const task = createBackgroundChild("investigate the api surface")
		vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
		const resolveBackgroundChild = vi.spyOn(mockProvider, "resolveBackgroundChild")
		const failBackgroundChild = vi.spyOn(mockProvider, "failBackgroundChild")
		const askSpy = vi.spyOn(task, "ask")
		const requestAbort = vi.spyOn(task, "requestAbort")
		const seam = stubRequestSeam(task, () => {
			throw new Error("background child issued a second API request after D5")
		})

		await withSettleDeadline(task.run())

		expect(seam.callCount()).toBe(1)
		expect(resolveBackgroundChild).toHaveBeenCalledTimes(1)
		expect(resolveBackgroundChild).toHaveBeenCalledWith(task.taskId, "child findings")
		expect(failBackgroundChild).not.toHaveBeenCalled()
		// The D5 branch ends the loop itself; no user ask ever happens.
		expect(askSpy).not.toHaveBeenCalled()
		expect(requestAbort).toHaveBeenCalledTimes(1)
		expect(requestAbort).toHaveBeenCalledWith(true)
		expect(task.abandoned).toBe(true)
		expect(task.abort).toBe(true)
		// requestAbort over requestAbandon: a reducer rejection or an
		// abandoned-field divergence would surface as this warning.
		const divergenceWarnings = warnSpy.mock.calls.filter((call: unknown[]) =>
			String(call[0]).includes("[RunState] divergence"),
		)
		expect(divergenceWarnings).toEqual([])
	})

	it("keeps the terminal history status completed after the loop ends", async () => {
		const task = createBackgroundChild("investigate the debug logs")
		vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
		vi.spyOn(mockProvider, "resolveBackgroundChild")
		const seam = stubRequestSeam(task, () => {
			throw new Error("background child issued a second API request after D5")
		})

		// The host persists "completed" when it collects the result; every late
		// saveClineMessages() during loop teardown must preserve it.
		const historyItem: HistoryItem = {
			id: task.taskId,
			number: 1,
			ts: Date.now(),
			task: "investigate the debug logs",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			status: "completed",
		}
		await mockProvider.taskHistoryStore.upsert(historyItem)

		await withSettleDeadline(task.run())

		expect(seam.callCount()).toBe(1)
		expect(mockProvider.taskHistoryStore.get(task.taskId)?.status).toBe("completed")
	})
})
