import { resolveAutocompleteConfig, type ResolvedAutocompleteConfig } from "@roo-code/types"

import { AutocompleteService, type AutocompleteServiceOptions } from "../AutocompleteService"
import { AUTOCOMPLETE_OPEN_SETTINGS_COMMAND } from "../ui/AutocompleteStatusBar"

const workspaceConfig = { disabled: false, debugLogging: false }

const statusBarItem = {
	show: vi.fn(),
	dispose: vi.fn(),
	text: "",
	tooltip: "",
	command: "",
	backgroundColor: undefined,
}
type ConfigChangeListener = (event: { affectsConfiguration: (section: string) => boolean }) => void

const registerInlineCompletionItemProvider = vi.fn((..._args: unknown[]) => ({ dispose: vi.fn() }))
const registerCommand = vi.fn((_id: string, _handler: () => void) => ({ dispose: vi.fn() }))
const executeCommand = vi.fn((..._args: unknown[]) => undefined)
const onDidChangeConfiguration = vi.fn((_listener: ConfigChangeListener) => ({ dispose: vi.fn() }))

vi.mock("vscode", async () => {
	const actual = await vi.importActual<typeof import("vscode")>("vscode")
	return {
		...actual,
		StatusBarAlignment: { Left: 1, Right: 2 },
		ThemeColor: class {
			constructor(readonly id: string) {}
		},
		window: {
			createStatusBarItem: () => statusBarItem,
			createOutputChannel: () => ({ appendLine: vi.fn(), dispose: vi.fn() }),
			visibleTextEditors: [],
		},
		languages: {
			registerInlineCompletionItemProvider: (...a: unknown[]) => registerInlineCompletionItemProvider(...a),
		},
		commands: {
			registerCommand: (id: string, handler: () => void) => registerCommand(id, handler),
			executeCommand: (...a: unknown[]) => executeCommand(...a),
		},
		workspace: {
			workspaceFolders: [{ uri: { fsPath: "/ws" } }],
			onDidChangeConfiguration: (listener: ConfigChangeListener) => onDidChangeConfiguration(listener),
			getConfiguration: () => ({
				get: (key: string, fallback: boolean) =>
					key === "autocomplete.disabled"
						? workspaceConfig.disabled
						: key === "autocomplete.debugLogging"
							? workspaceConfig.debugLogging
							: fallback,
			}),
			asRelativePath: (uri: { fsPath: string }) => uri.fsPath,
		},
	}
})

// The ignore controller touches the filesystem; the service only awaits its init.
vi.mock("../../../core/ignore/RooIgnoreController", () => ({
	RooIgnoreController: class {
		async initialize() {}
		validateAccess() {
			return true
		}
		dispose() {}
	},
}))

const makeOptions = (overrides: Partial<{ enabled: boolean }> = {}) => {
	const setEnabled = vi.fn(async () => {})
	const openSettings = vi.fn()
	let config: ResolvedAutocompleteConfig = resolveAutocompleteConfig({ enabled: overrides.enabled ?? true })

	// Kept as its own binding so assertions can read `subscriptions` without
	// reaching through the `ExtensionContext` cast.
	const subscriptions: { dispose: () => void }[] = []

	return {
		setEnabled,
		openSettings,
		subscriptions,
		setConfig: (next: Partial<ResolvedAutocompleteConfig>) => {
			config = { ...config, ...next }
		},
		options: {
			context: { subscriptions } as unknown as AutocompleteServiceOptions["context"],
			getGlobalConfig: () => config,
			getApiKey: () => undefined,
			openSettings,
			setEnabled,
		},
	}
}

beforeEach(() => {
	workspaceConfig.disabled = false
	workspaceConfig.debugLogging = false
	vi.clearAllMocks()
})

describe("AutocompleteService.create", () => {
	it("registers the provider, the settings command and a config listener", async () => {
		const { options, subscriptions } = makeOptions()

		const service = await AutocompleteService.create(options)

		expect(registerInlineCompletionItemProvider).toHaveBeenCalledTimes(1)
		expect(registerCommand).toHaveBeenCalledWith(AUTOCOMPLETE_OPEN_SETTINGS_COMMAND, expect.any(Function))
		expect(onDidChangeConfiguration).toHaveBeenCalledTimes(1)
		expect(subscriptions).toHaveLength(3)

		service.dispose()
	})

	it("shows the status bar once registered", async () => {
		const { options } = makeOptions()

		const service = await AutocompleteService.create(options)

		expect(statusBarItem.show).toHaveBeenCalledTimes(1)

		service.dispose()
	})

	it("routes the registered command to the openSettings handler", async () => {
		const { options, openSettings } = makeOptions()

		const service = await AutocompleteService.create(options)
		const handler = registerCommand.mock.calls[0][1]
		handler()

		expect(openSettings).toHaveBeenCalledTimes(1)

		service.dispose()
	})

	it("re-renders the status bar when autocomplete configuration changes", async () => {
		const { options } = makeOptions()
		const service = await AutocompleteService.create(options)

		const listener = onDidChangeConfiguration.mock.calls[0][0]

		statusBarItem.text = "stale"
		listener({ affectsConfiguration: (section: string) => section === "zoo-code.autocomplete" })

		expect(statusBarItem.text).not.toBe("stale")

		service.dispose()
	})

	it("ignores configuration changes for unrelated sections", async () => {
		const { options } = makeOptions()
		const service = await AutocompleteService.create(options)

		const listener = onDidChangeConfiguration.mock.calls[0][0]

		statusBarItem.text = "unchanged"
		listener({ affectsConfiguration: () => false })

		expect(statusBarItem.text).toBe("unchanged")

		service.dispose()
	})
})

describe("AutocompleteService.getState", () => {
	it("reports enabled when the global flag is on", async () => {
		const service = await AutocompleteService.create(makeOptions({ enabled: true }).options)

		expect(service.getState()).toEqual({ enabled: true })

		service.dispose()
	})

	it("reports a plain disabled state when the global flag is off", async () => {
		const service = await AutocompleteService.create(makeOptions({ enabled: false }).options)

		expect(service.getState()).toEqual({ enabled: false, reason: "disabled" })

		service.dispose()
	})

	it("distinguishes the workspace kill switch from a plain disable", async () => {
		// The two look identical to the user otherwise, and the kill switch is the
		// one a user cannot fix from the settings panel.
		workspaceConfig.disabled = true
		const service = await AutocompleteService.create(makeOptions({ enabled: true }).options)

		expect(service.getState()).toEqual({ enabled: false, reason: "workspace-kill-switch" })

		service.dispose()
	})
})

describe("AutocompleteService.getConfig", () => {
	it("returns the resolved global config", async () => {
		const service = await AutocompleteService.create(makeOptions({ enabled: true }).options)

		expect(service.getConfig().enabled).toBe(true)

		service.dispose()
	})

	it("forces enabled off while the workspace kill switch is set", async () => {
		workspaceConfig.disabled = true
		const service = await AutocompleteService.create(makeOptions({ enabled: true }).options)

		expect(service.getConfig().enabled).toBe(false)

		service.dispose()
	})
})

describe("AutocompleteService.toggleEnabled", () => {
	it("persists the inverse of the current flag", async () => {
		const { options, setEnabled } = makeOptions({ enabled: true })
		const service = await AutocompleteService.create(options)

		await service.toggleEnabled()

		expect(setEnabled).toHaveBeenCalledWith(false)

		service.dispose()
	})

	it("turns the feature back on from a disabled state", async () => {
		const { options, setEnabled } = makeOptions({ enabled: false })
		const service = await AutocompleteService.create(options)

		await service.toggleEnabled()

		expect(setEnabled).toHaveBeenCalledWith(true)

		service.dispose()
	})
})

describe("AutocompleteService.triggerInlineCompletion", () => {
	it("asks VS Code for an inline suggestion", async () => {
		const service = await AutocompleteService.create(makeOptions().options)

		service.triggerInlineCompletion()

		expect(executeCommand).toHaveBeenCalledWith("editor.action.inlineSuggest.trigger")

		service.dispose()
	})
})

describe("AutocompleteService.dispose", () => {
	it("disposes the status bar", async () => {
		const service = await AutocompleteService.create(makeOptions().options)

		service.dispose()

		expect(statusBarItem.dispose).toHaveBeenCalledTimes(1)
	})

	it("tolerates clearCache being called at any time", async () => {
		const service = await AutocompleteService.create(makeOptions().options)

		expect(() => service.clearCache()).not.toThrow()

		service.dispose()
	})
})
