// pnpm --filter roo-cline test core/webview/__tests__/ClineProvider.mode-window.spec.ts

import * as vscode from "vscode"

import { makeCompositeDisposable } from "../../../test-utils/vscode"
import { TelemetryService } from "@roo-code/telemetry"
import type { ModeConfig } from "@roo-code/types"

import { ContextProxy } from "../../config/ContextProxy"
import { ClineProvider } from "../ClineProvider"
import { WebviewFocusTracker } from "../WebviewFocusTracker"

// Mock setup
vi.mock("fs/promises", () => ({
	mkdir: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn().mockResolvedValue(""),
	unlink: vi.fn().mockResolvedValue(undefined),
	rmdir: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../../utils/storage", () => ({
	getSettingsDirectoryPath: vi.fn().mockResolvedValue("/test/settings/path"),
	getTaskDirectoryPath: vi.fn().mockResolvedValue("/test/task/path"),
	getGlobalStoragePath: vi.fn().mockResolvedValue("/test/storage/path"),
}))

vi.mock("p-wait-for", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("delay", () => {
	const delayFn = (_ms: number) => Promise.resolve()
	delayFn.createDelay = delayFn
	delayFn.reject = delayFn
	delayFn.range = delayFn
	return { default: delayFn }
})

vi.mock("vscode", () => ({
	ExtensionContext: vi.fn(),
	OutputChannel: vi.fn(),
	WebviewView: vi.fn(),
	Disposable: { from: (...subscriptions: vscode.Disposable[]) => makeCompositeDisposable(...subscriptions) },
	Uri: {
		joinPath: vi.fn(),
		file: vi.fn(),
	},
	commands: {
		executeCommand: vi.fn().mockResolvedValue(undefined),
	},
	window: {
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
	},
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue([]),
			update: vi.fn(),
		}),
		onDidChangeConfiguration: vi.fn().mockImplementation(() => ({ dispose: vi.fn() })),
	},
	env: {
		uriScheme: "vscode",
		language: "en",
		appName: "Visual Studio Code",
	},
	extensions: {
		all: [],
	},
	ExtensionMode: {
		Production: 1,
		Development: 2,
		Test: 3,
	},
	version: "1.85.0",
}))

vi.mock("../../../utils/tts", () => ({
	setTtsEnabled: vi.fn(),
	setTtsSpeed: vi.fn(),
}))

vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn(),
}))

vi.mock("../../../integrations/workspace/WorkspaceTracker", () => ({
	default: vi.fn().mockImplementation(function () {
		return {
			initializeFilePaths: vi.fn(),
			dispose: vi.fn(),
		}
	}),
}))

vi.mock("../../task/Task", () => ({
	Task: vi.fn().mockImplementation(() => ({
		taskId: "mock-task-id",
		instanceId: "mock-instance-id",
		abortTask: vi.fn().mockResolvedValue(undefined),
		emit: vi.fn(),
	})),
}))

vi.mock("@roo-code/cloud", () => ({
	CloudService: {
		hasInstance: vi.fn().mockReturnValue(true),
		get instance() {
			return {
				isAuthenticated: vi.fn().mockReturnValue(false),
				off: vi.fn(),
			}
		},
	},
	getRooCodeApiUrl: vi.fn().mockReturnValue("https://app.roocode.com"),
}))

vi.mock("../../../integrations/theme/getTheme", () => ({
	getTheme: vi.fn().mockResolvedValue({ kind: "dark" }),
}))

vi.mock("../webviewMessageHandler", () => ({
	webviewMessageHandler: vi.fn().mockResolvedValue(undefined),
}))

function makeDeferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((res) => {
		resolve = res
	})
	return { promise, resolve }
}

describe("ClineProvider - mode decisions inside their own write window", () => {
	let provider: ClineProvider
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel

	beforeEach(() => {
		vi.clearAllMocks()

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const globalState: Record<string, unknown> = {}
		const secrets: Record<string, string | undefined> = {}

		// Structural double providing only the storage members ClineProvider and ContextProxy read.
		mockContext = {
			extensionPath: "/test/path",
			extensionUri: { fsPath: "/test/path" },
			globalState: {
				get: vi.fn().mockImplementation((key: string) => globalState[key]),
				update: vi.fn().mockImplementation((key: string, value: unknown) => {
					globalState[key] = value
					return Promise.resolve()
				}),
				keys: vi.fn().mockImplementation(() => Object.keys(globalState)),
			},
			secrets: {
				get: vi.fn().mockImplementation((key: string) => secrets[key]),
				store: vi.fn().mockImplementation((key: string, value: string | undefined) => {
					secrets[key] = value
					return Promise.resolve()
				}),
				delete: vi.fn().mockImplementation((key: string) => {
					delete secrets[key]
					return Promise.resolve()
				}),
			},
			workspaceState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			subscriptions: [],
			extension: {
				packageJSON: { version: "1.0.0" },
			},
			globalStorageUri: {
				fsPath: "/test/storage/path",
			},
		} as unknown as vscode.ExtensionContext

		// Structural double providing only the logging members ClineProvider calls.
		mockOutputChannel = {
			appendLine: vi.fn(),
			clear: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		provider = new ClineProvider(
			mockContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockContext),
			new WebviewFocusTracker(),
		)
	})

	afterEach(async () => {
		await provider.dispose()
	})

	it("keeps a brand-new mode whose definition arrives in the same configuration", async () => {
		const logSpy = vi.spyOn(provider, "log")
		// The manager has not seen the slug yet: createTask registers the definitions that
		// arrive with the configuration only after setValues returns, at blob rows
		// 6463-6471 of src/core/webview/ClineProvider.ts at 0197bbe98107.
		vi.spyOn(provider.customModesManager, "getCustomModes").mockResolvedValue([])

		const newMode: ModeConfig = {
			slug: "audit-review",
			name: "Audit Review",
			roleDefinition: "You review the diff before it lands.",
			groups: [],
		}

		await provider.setValues({ mode: newMode.slug, customModes: [newMode] })

		expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Ignoring invalid mode "audit-review"'))
		expect(mockContext.globalState.get("mode")).toBe("audit-review")
		expect(provider["viewLocalState"].mode).toBe("audit-review")

		// Control: the same lookup with no definition in the payload and none registered still
		// refuses the slug, so honouring the payload is not the same as trusting any string.
		await provider.setValues({ mode: "never-registered" })

		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Ignoring invalid mode "never-registered"'))
		expect(mockContext.globalState.get("mode")).toBe("audit-review")
		expect(provider["viewLocalState"].mode).toBe("audit-review")
	})

	it("keeps a mode cleared while the view-state load is in flight cleared", async () => {
		// A previous session pinned this view's mode; this instance's in-memory buffer has
		// never held one, which is the state a registration load starts from.
		await provider.contextProxy.setValue("viewStates", { "clear-during-load": { mode: "code" } })

		const customModes = makeDeferred<ModeConfig[]>()
		const getCustomModes = vi
			.spyOn(provider.customModesManager, "getCustomModes")
			.mockImplementation(() => customModes.promise)

		const load = provider.setViewStateId("clear-during-load")
		await vi.waitFor(() => expect(getCustomModes).toHaveBeenCalledTimes(1))

		// The clear lands while the persisted-mode lookup is parked: it removes the mode from
		// storage, and the buffer never held one, so its value before and after is undefined.
		await provider.saveViewState("mode", undefined)

		customModes.resolve([])
		await load

		expect(mockContext.globalState.get("viewStates")).toEqual({})
		expect(provider["viewLocalState"]).not.toHaveProperty("mode")
	})
})
