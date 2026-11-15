// npx vitest run core/webview/__tests__/ClineProvider.pinnedProfileEndpoint.spec.ts

import * as vscode from "vscode"
import { WebviewFocusTracker } from "../WebviewFocusTracker"
import { makeCompositeDisposable } from "../../../test-utils/vscode"
import { TelemetryService } from "@roo-code/telemetry"
import { ClineProvider } from "../ClineProvider"
import { Task } from "../../task/Task"

import { ContextProxy } from "../../config/ContextProxy"
import type { HistoryItem } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"
import { ORGANIZATION_ALLOW_ALL } from "@roo-code/types"

vi.mock("vscode", () => ({
	ExtensionContext: vi.fn(),
	OutputChannel: vi.fn(),
	WebviewView: vi.fn(),
	Disposable: { from: (...subscriptions: vscode.Disposable[]) => makeCompositeDisposable(...subscriptions) },
	Uri: {
		joinPath: vi.fn(),
		file: vi.fn(),
	},
	CodeActionKind: {
		QuickFix: { value: "quickfix" },
		RefactorRewrite: { value: "refactor.rewrite" },
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
		onDidChangeConfiguration: vi.fn().mockImplementation(() => {
			return {
				dispose: vi.fn(),
			}
		}),
		onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidOpenTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
	},
	env: {
		uriScheme: "vscode",
		language: "en",
		appName: "Visual Studio Code",
	},
	ExtensionMode: {
		Production: 1,
		Development: 2,
		Test: 3,
	},
	version: "1.85.0",
}))

// Create a counter for unique task IDs.
let taskIdCounter = 0

vi.mock("../../task/Task", () => ({
	Task: vi.fn().mockImplementation(function (options) {
		return {
			taskId: options.taskId || `test-task-id-${++taskIdCounter}`,
			saveClineMessages: vi.fn(),
			clineMessages: [],
			apiConversationHistory: [],
			overwriteClineMessages: vi.fn(),
			overwriteApiConversationHistory: vi.fn(),
			abortTask: vi.fn(),
			handleWebviewAskResponse: vi.fn(),
			getTaskNumber: vi.fn().mockReturnValue(0),
			setTaskNumber: vi.fn(),
			setParentTask: vi.fn(),
			setRootTask: vi.fn(),
			emit: vi.fn(),
			parentTask: options.parentTask,
			updateApiConfiguration: vi.fn(),
			setTaskApiConfigName: vi.fn(),
			_taskApiConfigName: options.historyItem?.apiConfigName,
			taskApiConfigName: options.historyItem?.apiConfigName,
		}
	}),
}))

vi.mock("../../prompts/sections/custom-instructions")

vi.mock("../../../utils/safeWriteJson")

vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn().mockReturnValue({
		getModel: vi.fn().mockReturnValue({
			id: "claude-3-sonnet",
		}),
	}),
}))

vi.mock("../../../integrations/workspace/WorkspaceTracker", () => ({
	default: vi.fn().mockImplementation(function () {
		return {
			initializeFilePaths: vi.fn(),
			dispose: vi.fn(),
		}
	}),
}))

vi.mock("../../diff/strategies/multi-search-replace", () => ({
	MultiSearchReplaceDiffStrategy: vi.fn().mockImplementation(function () {
		return {
			getName: () => "test-strategy",
			applyDiff: vi.fn(),
		}
	}),
}))

vi.mock("@roo-code/cloud", () => ({
	CloudService: {
		hasInstance: vi.fn().mockReturnValue(true),
		get instance() {
			return {
				isAuthenticated: vi.fn().mockReturnValue(false),
				isCloudAgent: vi.fn().mockReturnValue(false),
				getAllowList: vi.fn().mockResolvedValue(ORGANIZATION_ALLOW_ALL),
				getUserInfo: vi.fn().mockReturnValue(undefined),
				getOrganizationMemberships: vi.fn().mockReturnValue([]),
				getOrganizationSettings: vi.fn().mockReturnValue(undefined),
				logout: vi.fn().mockResolvedValue(undefined),
				on: vi.fn(),
				off: vi.fn(),
			}
		},
	},
	getRooCodeApiUrl: vi.fn().mockReturnValue("https://app.roocode.com"),
}))

vi.mock("../../../shared/modes", () => ({
	modes: [
		{
			slug: "code",
			name: "Code Mode",
			roleDefinition: "You are a code assistant",
			groups: ["read", "edit"],
		},
		{
			slug: "architect",
			name: "Architect Mode",
			roleDefinition: "You are an architect",
			groups: ["read", "edit"],
		},
	],
	getModeBySlug: vi.fn().mockReturnValue({
		slug: "code",
		name: "Code Mode",
		roleDefinition: "You are a code assistant",
		groups: ["read", "edit"],
	}),
	defaultModeSlug: "code",
}))

vi.mock("../../prompts/system", () => ({
	SYSTEM_PROMPT: vi.fn().mockResolvedValue("mocked system prompt"),
	codeMode: "code",
}))

vi.mock("../../../api/providers/fetchers/modelCache", () => ({
	getModels: vi.fn().mockResolvedValue({}),
	flushModels: vi.fn(),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockResolvedValue("Mock file content"),
}))

vi.mock("p-wait-for", () => ({
	default: vi.fn().mockImplementation(async () => Promise.resolve()),
}))

vi.mock("fs/promises", () => ({
	mkdir: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn().mockResolvedValue(""),
	readdir: vi.fn().mockResolvedValue([]),
	unlink: vi.fn().mockResolvedValue(undefined),
	rmdir: vi.fn().mockResolvedValue(undefined),
	access: vi.fn().mockResolvedValue(undefined),
	rm: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../../utils/storage", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../utils/storage")>()
	return {
		...actual,
		getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => {
			return defaultPath
		}),
		getSettingsDirectoryPath: vi.fn().mockResolvedValue("/test/settings/path"),
		getTaskDirectoryPath: vi.fn().mockResolvedValue("/test/task/path"),
	}
})

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		hasInstance: vi.fn().mockReturnValue(true),
		createInstance: vi.fn(),
		get instance() {
			return {
				trackEvent: vi.fn(),
				trackError: vi.fn(),
				setProvider: vi.fn(),
				captureModeSwitch: vi.fn(),
			}
		},
	},
}))

const VIEW_A_PROFILE = "view-a-openrouter"
const VIEW_B_PROFILE = "view-b-openrouter"
const VIEW_B_ENDPOINT = "https://router-b.example"

const viewAProfileSettings = {
	name: VIEW_A_PROFILE,
	id: "view-a-id",
	apiProvider: providerIdentifiers.openrouter,
	openRouterApiKey: "view-a-key",
	openRouterModelId: "view-a-model",
}

const viewBProfileSettings = {
	name: VIEW_B_PROFILE,
	id: "view-b-id",
	apiProvider: providerIdentifiers.openrouter,
	openRouterApiKey: "view-b-key",
	openRouterBaseUrl: VIEW_B_ENDPOINT,
	openRouterModelId: "view-b-model",
}

const profileEntries = [
	{ name: VIEW_A_PROFILE, id: "view-a-id", apiProvider: providerIdentifiers.openrouter },
	{ name: VIEW_B_PROFILE, id: "view-b-id", apiProvider: providerIdentifiers.openrouter },
]

// A history item that names neither a mode nor a profile: the restoration has no profile of its
// own to activate, so the task is built from whatever the restoring view is serving.
const HISTORY_ITEM_WITHOUT_PROFILE: HistoryItem = {
	id: "endpoint-test-task",
	number: 1,
	ts: 1730000000000,
	task: "restored task",
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
}

// A history item that names a mode: the restoration looks up that mode's saved profile and
// activates it, which re-pins the restoring view, so the task gets the mode's profile rather
// than the profile the view arrived with.
const HISTORY_ITEM_FOR_MODE: HistoryItem = { ...HISTORY_ITEM_WITHOUT_PROFILE, mode: "code" }

/** Storage backing both views' proxies: one shared store, because the shared provider settings are
 * extension-wide state and only the per-view buffers differ. */
function makeBacking() {
	const globalState: Record<string, unknown> = { mode: "code", currentApiConfigName: "default-profile" }
	const secrets: Record<string, string | undefined> = {}
	return { globalState, secrets }
}

type Backing = ReturnType<typeof makeBacking>

function makeContext(backing: Backing): vscode.ExtensionContext {
	// Assertion: the double only needs the shape of the host context that ClineProvider and
	// ContextProxy touch, which no exported type describes without the whole extension host.
	return {
		extensionPath: "/test/path",
		extensionUri: { fsPath: "/test/path" } as vscode.Uri,
		globalState: {
			get: vi.fn().mockImplementation((key: string) => backing.globalState[key]),
			update: vi.fn().mockImplementation((key: string, value: unknown) => {
				backing.globalState[key] = value
				return Promise.resolve()
			}),
			keys: vi.fn().mockImplementation(() => Object.keys(backing.globalState)),
		},
		secrets: {
			get: vi.fn().mockImplementation((key: string) => backing.secrets[key]),
			store: vi.fn().mockImplementation((key: string, value: string | undefined) => {
				backing.secrets[key] = value
				return Promise.resolve()
			}),
			delete: vi.fn().mockImplementation((key: string) => {
				delete backing.secrets[key]
				return Promise.resolve()
			}),
		},
		workspaceState: {
			get: vi.fn().mockReturnValue(undefined),
			update: vi.fn().mockResolvedValue(undefined),
			keys: vi.fn().mockReturnValue([]),
		},
		subscriptions: [],
		extension: { packageJSON: { version: "1.0.0" } },
		globalStorageUri: { fsPath: "/test/storage/path" },
	} as unknown as vscode.ExtensionContext
}

function makeOutputChannel(): vscode.OutputChannel {
	// Assertion: only the three methods the provider writes to are needed.
	return { appendLine: vi.fn(), clear: vi.fn(), dispose: vi.fn() } as unknown as vscode.OutputChannel
}

describe("ClineProvider - pinned profile endpoint isolation", () => {
	let backing: Backing
	let context: vscode.ExtensionContext
	let views: ClineProvider[]

	beforeEach(() => {
		vi.clearAllMocks()
		taskIdCounter = 0
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}
		backing = makeBacking()
		context = makeContext(backing)
		views = []
	})

	afterEach(async () => {
		const created = views
		views = []
		await Promise.all(created.map((view) => view.dispose()))
	})

	async function makeView(renderContext: "sidebar" | "editor"): Promise<ClineProvider> {
		const proxy = new ContextProxy(context)
		// Production loads the proxy's caches during extension activation; a proxy that never
		// initialized would read an empty store and could not see the shared settings at all.
		await proxy.initialize()
		const view = new ClineProvider(context, makeOutputChannel(), renderContext, proxy, new WebviewFocusTracker())
		await new Promise((resolve) => setTimeout(resolve, 10))
		view.getMcpHub = vi.fn().mockReturnValue({
			listTools: vi.fn().mockResolvedValue([]),
			callTool: vi.fn().mockResolvedValue({ content: [] }),
			listResources: vi.fn().mockResolvedValue([]),
			readResource: vi.fn().mockResolvedValue({ contents: [] }),
			getAllServers: vi.fn().mockReturnValue([]),
		})
		vi.spyOn(view, "postStateToWebview").mockResolvedValue(undefined)
		vi.spyOn(view.customModesManager, "getCustomModes").mockResolvedValue([])
		vi.spyOn(view.providerSettingsManager, "listConfig").mockResolvedValue(profileEntries)
		views.push(view)
		return view
	}

	/** The view that commits the activation: it writes the shared store through the real
	 * activation path, so the pinned view only has to read what it left behind. */
	async function activatingView(): Promise<ClineProvider> {
		const view = await makeView("sidebar")
		vi.spyOn(view.providerSettingsManager, "getProfile").mockResolvedValue(viewBProfileSettings)
		vi.spyOn(view.providerSettingsManager, "activateProfile").mockResolvedValue(viewBProfileSettings)
		await view.activateProviderProfile({ name: VIEW_B_PROFILE })
		return view
	}

	/** A view that pins its own profile: the persisted entry plus the profile lookup that
	 * loadViewState resolves it through, which is the pair a launched view restores. */
	async function pinnedView(): Promise<ClineProvider> {
		const view = await makeView("editor")
		vi.spyOn(view.providerSettingsManager, "getProfile").mockImplementation(async (params) =>
			"name" in params && params.name === VIEW_A_PROFILE ? viewAProfileSettings : viewBProfileSettings,
		)
		await view["setViewStateId"]("stable-editor-view")
		await view.contextProxy.setValue("viewStates", {
			"stable-editor-view": { currentApiConfigName: VIEW_A_PROFILE, updatedAt: 1 },
		})
		await view["loadViewState"]()
		return view
	}

	/** Runs the task-creation path so that nothing after the Task constructor matters, while a
	 * failure that lands before the double was called still reaches the assertions. */
	async function runPastTaskConstruction(action: () => Promise<unknown>): Promise<void> {
		try {
			await action()
		} catch (error) {
			if (vi.mocked(Task).mock.calls.length === 0) {
				throw error
			}
		}
	}

	/** The configuration a task was actually constructed with, read off the Task double. */
	function configurationOfLastTask() {
		const calls = vi.mocked(Task).mock.calls
		const options = calls[calls.length - 1]?.[0]
		if (!options) {
			throw new Error("no task was constructed, so nothing was handed to Task")
		}
		return options.apiConfiguration
	}

	it("starts a task on the pinned profile's own endpoint when another view activated one", async () => {
		await activatingView()
		const view = await pinnedView()

		await runPastTaskConstruction(() => view.createTask("hello", undefined, undefined, { startTask: false }))

		const apiConfiguration = configurationOfLastTask()
		expect(apiConfiguration?.apiProvider).toBe(providerIdentifiers.openrouter)
		expect(apiConfiguration?.openRouterApiKey).toBe("view-a-key")
		expect(apiConfiguration?.openRouterModelId).toBe("view-a-model")
		expect(apiConfiguration?.openRouterBaseUrl).toBeUndefined()

		const state = await view.getState()
		expect(state.apiConfiguration?.openRouterBaseUrl).toBeUndefined()
		expect(state.currentApiConfigName).toBe(VIEW_A_PROFILE)

		// The shared store really does carry the other view's endpoint: the assertion above is about
		// this view not borrowing it, not about it never having been written.
		expect((await (await makeView("sidebar")).getState()).apiConfiguration?.openRouterBaseUrl).toBe(VIEW_B_ENDPOINT)
	})

	it("restores a task that names no profile on the restoring view's own endpoint", async () => {
		await activatingView()
		const view = await pinnedView()

		await runPastTaskConstruction(() =>
			view.createTaskWithHistoryItem({ ...HISTORY_ITEM_WITHOUT_PROFILE }, { startTask: false }),
		)

		const apiConfiguration = configurationOfLastTask()
		expect(apiConfiguration?.openRouterApiKey).toBe("view-a-key")
		expect(apiConfiguration?.openRouterBaseUrl).toBeUndefined()
	})

	// A restored item that names a mode makes the restoration activate that mode's saved profile,
	// which re-pins the restoring view. The task then gets that profile whole - never the pinned
	// view's key welded onto the newly activated profile's endpoint.
	it("restores a mode task on one profile's key and endpoint together", async () => {
		await activatingView()
		const view = await pinnedView()

		await runPastTaskConstruction(() =>
			view.createTaskWithHistoryItem({ ...HISTORY_ITEM_FOR_MODE }, { startTask: false }),
		)

		const apiConfiguration = configurationOfLastTask()
		expect(apiConfiguration?.openRouterApiKey).toBe("view-b-key")
		expect(apiConfiguration?.openRouterBaseUrl).toBe(VIEW_B_ENDPOINT)
		expect((await view.getState()).currentApiConfigName).toBe(VIEW_B_PROFILE)
	})

	it("keeps the pinned profile's own fields when a partial provider edit is applied to it", async () => {
		await activatingView()
		const view = await pinnedView()

		await view.setValue("openRouterModelId", "edited-model")

		const overlay = view["viewLocalState"].apiConfiguration
		expect(overlay?.openRouterApiKey).toBe("view-a-key")
		expect(overlay?.openRouterModelId).toBe("edited-model")
		expect(overlay?.openRouterBaseUrl).toBeUndefined()

		await runPastTaskConstruction(() => view.createTask("hello", undefined, undefined, { startTask: false }))
		const apiConfiguration = configurationOfLastTask()
		expect(apiConfiguration?.openRouterModelId).toBe("edited-model")
		expect(apiConfiguration?.openRouterBaseUrl).toBeUndefined()
		// The mechanism, named: the partial edit seeded from the pair this view holds rather than
		// re-deriving the configuration from the shared store on the next read.
		expect(view["viewApiConfigurationProfileName"]).toBe(VIEW_A_PROFILE)
	})

	// A provider change replaces the overlay wholesale, so this view stops holding a complete
	// profile and reads go back to the shared store: the guard against treating a partial
	// provider switch as if it were still the pinned profile's own configuration.
	it("still layers a provider switch over the shared store instead of serving it alone", async () => {
		await activatingView()
		const view = await pinnedView()

		await view.setValues({ apiProvider: providerIdentifiers.anthropic, modelMaxTokens: 4321 })

		const state = await view.getState()
		expect(state.apiConfiguration?.apiProvider).toBe(providerIdentifiers.anthropic)
		expect(state.apiConfiguration?.modelMaxTokens).toBe(4321)
		expect(state.apiConfiguration?.openRouterBaseUrl).toBe(VIEW_B_ENDPOINT)
		expect(view["viewApiConfigurationProfileName"]).toBeUndefined()
	})

	it("leaves a view that pins nothing reading the activated profile from the shared store", async () => {
		await activatingView()
		const view = await makeView("editor")

		const state = await view.getState()
		expect(state.currentApiConfigName).toBe(VIEW_B_PROFILE)
		expect(state.apiConfiguration?.openRouterBaseUrl).toBe(VIEW_B_ENDPOINT)
		expect(state.apiConfiguration?.openRouterApiKey).toBe("view-b-key")
	})
})
