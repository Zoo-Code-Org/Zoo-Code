// npx vitest run core/task/__tests__/background-policy-snapshot.spec.ts

import * as os from "os"
import * as path from "path"

import type { ExtensionContext } from "vscode"
import { providerIdentifiers, type GlobalState, type ModelInfo, type ProviderSettings } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { ContextProxy } from "../../config/ContextProxy"
import { WebviewFocusTracker } from "../../webview/WebviewFocusTracker"
import type { RequestPolicySnapshot } from "../../prompts/tools/effective-tool-policy"
import type { ApiStreamChunk } from "../../../api/transform/stream"
import { asyncStreamFrom } from "../../../test-utils/stream"
import { BACKGROUND_CHILD_DISABLED_TOOLS, BACKGROUND_CHILD_EXPERIMENTS } from "../../background-subtasks/policy"

// Mock delay before any imports that might use it
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

const mockMessages = [
	{
		ts: Date.now(),
		type: "say",
		say: "text",
		text: "historical task",
	},
]

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	const mockFunctions = {
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockImplementation((filePath) => {
			if (filePath.includes("ui_messages.json")) {
				return Promise.resolve(JSON.stringify(mockMessages))
			}
			if (filePath.includes("api_conversation_history.json")) {
				return Promise.resolve("[]")
			}
			return Promise.resolve("[]")
		}),
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

// Task tests do not exercise indexing; keep workspace resolution and its cache out of this suite.
vi.mock("../../../services/code-index/code-index-manager-registry", () => ({
	CodeIndexManagerRegistry: {
		getOrCreate: vi.fn().mockReturnValue(undefined),
		getAllInstances: vi.fn().mockReturnValue([]),
		disposeAll: vi.fn(),
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
				stat: vi.fn().mockResolvedValue({ type: 1 }), // FileType.File = 1
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

vi.mock("../../../i18n", () => {
	return {
		t: (key: string, args?: Record<string, unknown>) => {
			if (key === "tools:missingToolParameterWithPath") {
				return `${args?.toolName}|${args?.relPath}|${args?.paramName}`
			}
			if (key === "tools:missingToolParameter") {
				return `${args?.toolName}|${args?.paramName}`
			}
			return key
		},
	}
})

// Mock storagePathManager to prevent dynamic import issues.
vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath, taskId) => Promise.resolve(`${globalStoragePath}/tasks/${taskId}`)),
	getSettingsDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath) => Promise.resolve(`${globalStoragePath}/settings`)),
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockImplementation((filePath) => {
		return filePath.includes("ui_messages.json") || filePath.includes("api_conversation_history.json")
	}),
}))

// Model-info stand-in: the settled snapshot only needs a defined ModelInfo.
const stubModelInfo: ModelInfo = {
	contextWindow: 200_000,
	maxTokens: 4096,
	supportsPromptCache: true,
}

type TaskTestAccess = {
	getSystemPrompt: (requestState: ProviderState | undefined, requestModelInfo?: ModelInfo) => Promise<string>
	safeEnsureModelFetched: () => Promise<ModelInfo>
	requestPolicySnapshot?: RequestPolicySnapshot
}

type ProviderState = Awaited<ReturnType<ClineProvider["getState"]>>

function getTaskTestAccess(task: Task): TaskTestAccess {
	return task as unknown as TaskTestAccess
}

function requireDefined<T>(value: T | null | undefined): T {
	if (value == null) {
		throw new Error("Expected test value to be defined")
	}
	return value
}

describe("background child tool policy in the request snapshot (D3)", () => {
	let mockProvider: ClineProvider
	let mockContextProxy: ContextProxy
	let mockApiConfig: ProviderSettings
	let mockExtensionContext: ExtensionContext

	// Builds provider-state doubles on top of the real getState() result, so
	// required fields stay compile-checked while each test states only its own
	// overrides. mcpEnabled defaults to false so doubles skip the MCP-hub path.
	let baseProviderState: ProviderState
	const providerStateWith = (overrides: Partial<ProviderState> = {}): ProviderState => ({
		...baseProviderState,
		mcpEnabled: false,
		...overrides,
	})

	beforeEach(async () => {
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const storageUri = {
			fsPath: path.join(os.tmpdir(), "test-storage"),
		}

		mockExtensionContext = {
			globalState: {
				get: vi.fn().mockImplementation((_key: keyof GlobalState) => undefined),
				update: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: storageUri,
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
		} as unknown as ExtensionContext

		const mockOutputChannel = {
			name: "test-output",
			appendLine: vi.fn(),
			append: vi.fn(),
			replace: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		}

		mockContextProxy = new ContextProxy(mockExtensionContext)
		mockProvider = new ClineProvider(
			mockExtensionContext,
			mockOutputChannel,
			"sidebar",
			mockContextProxy,
			new WebviewFocusTracker(),
		)

		mockApiConfig = {
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		}

		mockProvider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebviewThrottled = vi.fn().mockResolvedValue(undefined)
		mockProvider.flushPostStateToWebviewThrottled = vi.fn().mockResolvedValue(undefined)

		baseProviderState = await mockProvider.getState()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	// Common seams so attemptApiRequest runs its capture and streams a first
	// chunk without touching prompt building, context management, or UX.
	function armRequestSeams(task: Task) {
		vi.spyOn(getTaskTestAccess(task), "getSystemPrompt").mockResolvedValue("mock system prompt")
		vi.spyOn(task, "getTokenUsage").mockReturnValue({
			totalCost: 0,
			totalTokensIn: 0,
			totalTokensOut: 0,
			contextTokens: 0,
		})
		vi.spyOn(task, "say").mockResolvedValue({ ts: 0, type: "say", say: "text", text: "" })
	}

	async function captureRequest(
		requestTimeState: ProviderState,
		backgroundToolPolicy?: ConstructorParameters<typeof Task>[0]["backgroundToolPolicy"],
	): Promise<{ task: Task; snapshot: RequestPolicySnapshot; toolNames: string[] }> {
		// Install the state read before construction: the constructor's mode
		// initialization consumes the same request-time state the request will.
		vi.spyOn(mockProvider, "getState").mockResolvedValue(requestTimeState)
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
			backgroundToolPolicy,
			// P1-2: a LIVE background child is marked by the hosted flag, not by
			// policy presence. Passing a policy here always means "live child".
			backgroundChildHosted: backgroundToolPolicy !== undefined,
		})
		await task.getTaskMode()
		armRequestSeams(task)
		vi.spyOn(getTaskTestAccess(task), "safeEnsureModelFetched").mockResolvedValue(stubModelInfo)
		const createMessageSpy = vi
			.spyOn(task.api, "createMessage")
			.mockReturnValue(asyncStreamFrom<ApiStreamChunk>([{ type: "text", text: "ok" }]))

		await task.attemptApiRequest(0).next()

		const [, , metadata] = requireDefined(createMessageSpy.mock.calls[0])
		const toolNames = requireDefined(metadata?.tools).map((tool) => {
			if (tool.type !== "function") {
				throw new Error(`Unexpected tool type: ${tool.type}`)
			}
			return tool.function.name
		})

		return {
			task,
			snapshot: requireDefined(getTaskTestAccess(task).requestPolicySnapshot),
			toolNames,
		}
	}

	it("marks the task as a background child and folds the block list into the snapshot as a state-first union", async () => {
		const requestTimeState = providerStateWith({
			autoApprovalEnabled: false,
			disabledTools: ["read_file", "execute_command"],
			experiments: { customTools: true, imageGeneration: true },
		})

		const { task, snapshot } = await captureRequest(requestTimeState, {
			disabledTools: BACKGROUND_CHILD_DISABLED_TOOLS,
			experiments: BACKGROUND_CHILD_EXPERIMENTS,
		})

		expect(task.isBackgroundSubtaskChild).toBe(true)
		// State entries first, then the background entries, de-duplicated: the
		// ambient execute_command must not appear twice.
		expect(snapshot.disabledTools).toEqual([
			"read_file",
			"execute_command",
			...BACKGROUND_CHILD_DISABLED_TOOLS.filter((tool) => tool !== "execute_command"),
		])
		// The background experiments win on conflict while ambient entries survive.
		expect(snapshot.experiments).toEqual({ customTools: false, imageGeneration: true })
	})

	it("captures the snapshot from a fresh array, never aliasing the provider-state array", async () => {
		const stateDisabledTools: ProviderState["disabledTools"] = ["read_file", "execute_command"]
		const stateExperiments = { customTools: true }
		const requestTimeState = providerStateWith({
			autoApprovalEnabled: false,
			disabledTools: stateDisabledTools,
			experiments: stateExperiments,
		})

		const { snapshot } = await captureRequest(requestTimeState, {
			disabledTools: BACKGROUND_CHILD_DISABLED_TOOLS,
			experiments: BACKGROUND_CHILD_EXPERIMENTS,
		})

		// A later mutation of the snapshot (or of the state) must not write
		// through into the other: the union is a fresh array and object.
		expect(snapshot.disabledTools).not.toBe(stateDisabledTools)
		expect(snapshot.experiments).not.toBe(stateExperiments)
		expect(stateDisabledTools).toEqual(["read_file", "execute_command"])
		expect(stateExperiments).toEqual({ customTools: true })
	})

	it("falls back to exactly the ambient state when no background policy is present", async () => {
		const requestTimeState = providerStateWith({
			autoApprovalEnabled: false,
			disabledTools: ["read_file"],
			experiments: { customTools: true },
		})

		const { task, snapshot } = await captureRequest(requestTimeState)

		expect(task.isBackgroundSubtaskChild).toBe(false)
		expect(snapshot.disabledTools).toEqual(["read_file"])
		expect(snapshot.experiments).toEqual({ customTools: true })
		// Byte-identical to the pre-D3 capture: same references, not copies, so
		// a normal task's snapshot cannot drift from what it published before.
		expect(snapshot.disabledTools).toBe(requestTimeState.disabledTools)
		expect(snapshot.experiments).toBe(requestTimeState.experiments)
		// No background entry may leak into a normal task's snapshot.
		expect(snapshot.disabledTools).not.toContain("write_to_file")
	})

	it("never writes the background policy into provider state during capture", async () => {
		const requestTimeState = providerStateWith({
			autoApprovalEnabled: false,
			disabledTools: ["read_file"],
			experiments: { customTools: true },
		})
		const setValueSpy = vi.spyOn(mockContextProxy, "setValue")
		const setValuesSpy = vi.spyOn(mockContextProxy, "setValues")
		const providerSetValueSpy = vi.spyOn(mockProvider, "setValue")
		const providerSetValuesSpy = vi.spyOn(mockProvider, "setValues")
		const globalUpdateSpy = mockExtensionContext.globalState.update as ReturnType<typeof vi.fn>

		await captureRequest(requestTimeState, {
			disabledTools: BACKGROUND_CHILD_DISABLED_TOOLS,
			experiments: BACKGROUND_CHILD_EXPERIMENTS,
		})

		const touchesPolicyKey = ([key]: unknown[]) => key === "disabledTools" || key === "experiments"
		const writesPolicyKey = (values: unknown) => {
			if (typeof values !== "object" || values === null) {
				return false
			}
			const record = values as Record<string, unknown>
			return "disabledTools" in record || "experiments" in record
		}
		// Every write sink between the task and global storage must stay
		// untouched by the fold: the policy is task-local by construction.
		expect(globalUpdateSpy.mock.calls.some(touchesPolicyKey)).toBe(false)
		expect(setValueSpy.mock.calls.some(touchesPolicyKey)).toBe(false)
		expect(setValuesSpy.mock.calls.some(([values]) => writesPolicyKey(values))).toBe(false)
		expect(providerSetValueSpy.mock.calls.some(touchesPolicyKey)).toBe(false)
		expect(providerSetValuesSpy.mock.calls.some(([values]) => writesPolicyKey(values))).toBe(false)
	})

	it("drops every block-listed tool from the model-facing array a background child sends", async () => {
		const stateForRequest = () =>
			providerStateWith({
				mode: "code",
				autoApprovalEnabled: false,
				disabledTools: [],
				experiments: { customTools: true },
			})

		const normal = await captureRequest(stateForRequest())
		const child = await captureRequest(stateForRequest(), {
			disabledTools: BACKGROUND_CHILD_DISABLED_TOOLS,
			experiments: BACKGROUND_CHILD_EXPERIMENTS,
		})

		// Non-vacuous control: code mode offers the writable, command, delegation,
		// and question surfaces today, so their removal below is the block list
		// doing work, not a mode that never granted them.
		const blockedForNormalTasks = BACKGROUND_CHILD_DISABLED_TOOLS.filter((tool) => normal.toolNames.includes(tool))
		expect(blockedForNormalTasks).toEqual(
			expect.arrayContaining([
				"write_to_file",
				"execute_command",
				"new_task",
				"switch_mode",
				"ask_followup_question",
			]),
		)

		for (const tool of blockedForNormalTasks) {
			expect(child.toolNames).not.toContain(tool)
		}
		// The read-only surface and the completion exit still reach the model.
		expect(child.toolNames).toEqual(expect.arrayContaining(["read_file", "attempt_completion"]))
	})

	it("keeps the model-facing tool array unchanged for a normal task", async () => {
		const requestTimeState = providerStateWith({ mode: "code", autoApprovalEnabled: false, disabledTools: [] })

		const { task, toolNames } = await captureRequest(requestTimeState)

		expect(task.isBackgroundSubtaskChild).toBe(false)
		expect(task.taskMode).toBe("code")
		expect(toolNames).toEqual(expect.arrayContaining(["read_file", "write_to_file", "execute_command"]))
	})
})
