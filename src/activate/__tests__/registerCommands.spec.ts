import type { Mock } from "vitest"
import * as vscode from "vscode"
import { ClineProvider } from "../../core/webview/ClineProvider"

import { getVisibleProviderOrLog, registerCommands, setPanel } from "../registerCommands"

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

vi.mock("vscode", () => ({
	CodeActionKind: {
		QuickFix: { value: "quickfix" },
		RefactorRewrite: { value: "refactor.rewrite" },
	},
	window: {
		createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	},
	workspace: {
		workspaceFolders: [
			{
				uri: {
					fsPath: "/mock/workspace",
				},
			},
		],
	},
	commands: {
		registerCommand: vi.fn(),
		executeCommand: vi.fn(),
	},
}))

vi.mock("../../core/webview/ClineProvider")

vi.mock("../../shared/package", () => ({
	Package: {
		name: "zoo-code",
	},
}))

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureTitleButtonClicked: vi.fn(),
		},
	},
}))

vi.mock("../../utils/focusPanel", () => ({
	focusPanel: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../handleTask", () => ({
	handleNewTask: vi.fn(),
}))

vi.mock("../../core/config/importExport", () => ({
	importSettingsWithFeedback: vi.fn(),
}))

vi.mock("../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: vi.fn(),
	},
}))

vi.mock("../../services/mdm/MdmService", () => ({
	MdmService: {
		getInstance: vi.fn(),
	},
}))

vi.mock("../../core/config/ContextProxy", () => ({
	ContextProxy: {
		getInstance: vi.fn(),
	},
}))

vi.mock("../../i18n", () => ({
	t: (key: string) => key,
}))

describe("getVisibleProviderOrLog", () => {
	let mockOutputChannel: vscode.OutputChannel

	beforeEach(() => {
		mockOutputChannel = {
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			hide: vi.fn(),
			name: "mock",
			replace: vi.fn(),
			show: vi.fn(),
			dispose: vi.fn(),
		}
		vi.clearAllMocks()
	})

	it("returns the visible provider if found", () => {
		const mockProvider = {} as ClineProvider
		;(ClineProvider.getVisibleInstance as Mock).mockReturnValue(mockProvider)

		const result = getVisibleProviderOrLog(mockOutputChannel)

		expect(result).toBe(mockProvider)
		expect(mockOutputChannel.appendLine).not.toHaveBeenCalled()
	})

	it("logs and returns undefined if no provider found", () => {
		;(ClineProvider.getVisibleInstance as Mock).mockReturnValue(undefined)

		const result = getVisibleProviderOrLog(mockOutputChannel)

		expect(result).toBeUndefined()
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith("Cannot find any visible Roo Code instances.")
	})
})

describe("registerCommands handlers", () => {
	let mockOutputChannel: vscode.OutputChannel
	let mockContext: vscode.ExtensionContext
	let mockVisibleProvider: { postMessageToWebview: Mock }
	let mockProvider: { postMessageToWebview: Mock }
	let handlers: Record<string, (...args: unknown[]) => unknown>

	beforeEach(() => {
		vi.clearAllMocks()
		handlers = {}

		mockOutputChannel = {
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			hide: vi.fn(),
			name: "mock",
			replace: vi.fn(),
			show: vi.fn(),
			dispose: vi.fn(),
		}

		mockContext = {
			subscriptions: [],
		} as unknown as vscode.ExtensionContext

		mockVisibleProvider = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		}

		mockProvider = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		}
		;(ClineProvider.getVisibleInstance as Mock).mockReturnValue(mockVisibleProvider)
		;(vscode.commands.registerCommand as Mock).mockImplementation(
			(id: string, cb: (...args: unknown[]) => unknown) => {
				handlers[id] = cb
				return { dispose: vi.fn() }
			},
		)

		registerCommands({
			context: mockContext,
			outputChannel: mockOutputChannel,
			provider: mockProvider as unknown as ClineProvider,
		})
	})

	afterEach(() => {
		// Reset module-level panel state to prevent leakage between tests.
		setPanel(undefined, "sidebar")
		setPanel(undefined, "tab")
	})

	it("settingsButtonClicked posts both settingsButtonClicked and didBecomeVisible actions", () => {
		handlers["zoo-code.settingsButtonClicked"]()

		expect(mockVisibleProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "settingsButtonClicked",
		})
		expect(mockVisibleProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "didBecomeVisible",
		})
		expect(mockVisibleProvider.postMessageToWebview).toHaveBeenCalledTimes(2)
	})

	it("settingsButtonClicked is a no-op when no visible provider", () => {
		;(ClineProvider.getVisibleInstance as Mock).mockReturnValue(undefined)

		handlers["zoo-code.settingsButtonClicked"]()

		expect(mockVisibleProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("historyButtonClicked posts historyButtonClicked action", () => {
		handlers["zoo-code.historyButtonClicked"]()

		expect(mockVisibleProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "historyButtonClicked",
		})
	})

	it("marketplaceButtonClicked posts marketplaceButtonClicked action", () => {
		handlers["zoo-code.marketplaceButtonClicked"]()

		expect(mockVisibleProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "marketplaceButtonClicked",
		})
	})

	it("acceptInput posts acceptInput message", () => {
		handlers["zoo-code.acceptInput"]()

		expect(mockVisibleProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "acceptInput",
		})
	})

	it("toggleAutoApprove awaits postMessage with toggleAutoApprove action", async () => {
		await handlers["zoo-code.toggleAutoApprove"]()

		expect(mockVisibleProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "toggleAutoApprove",
		})
	})

	it("focusInput awaits postMessage on the registered provider when a sidebar panel is active", async () => {
		const fakeSidebar = {} as vscode.WebviewView
		setPanel(fakeSidebar, "sidebar")

		await handlers["zoo-code.focusInput"]()

		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "focusInput",
		})
	})

	it("focusInput does not post when no sidebar panel is active", async () => {
		await handlers["zoo-code.focusInput"]()

		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
	})
})
