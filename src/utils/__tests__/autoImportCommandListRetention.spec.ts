// npx vitest utils/__tests__/autoImportCommandListRetention.spec.ts

// Auto-import writes the command lists only into extension state. A save reads
// the user settings file and treats an entry that no configuration layer holds
// as removed there. These tests drive the real auto-import entry point and the
// real save path against one stateful settings file, so the deletion the two
// halves can cause together stays visible.

vi.mock("vscode", () => ({
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/mock/workspace" } }],
		getConfiguration: vi.fn(),
	},
	window: {
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
	},
}))

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		hasInstance: vi.fn().mockReturnValue(false),
		instance: {
			captureSchemaValidationError: vi.fn(),
			updateTelemetryState: vi.fn(),
		},
	},
}))

vi.mock("../../api", () => ({
	buildApiHandler: vi.fn().mockReturnValue({ getModel: vi.fn() }),
}))

vi.mock("../../api/providers/fetchers/modelCache")
vi.mock("../../api/providers/fetchers/lmstudio", () => ({ getLMStudioModels: vi.fn() }))
vi.mock("../../services/command/commands", () => ({ getCommands: vi.fn() }))
vi.mock("../../services/destructive-command-guard", () => ({ ensureDcgInstalled: vi.fn() }))
vi.mock("../../integrations/theme/getTheme", () => ({ getTheme: vi.fn().mockResolvedValue({}) }))
vi.mock("../../integrations/openai-codex/oauth", () => ({
	openAiCodexOAuthManager: { getAccessToken: vi.fn(), getAccountId: vi.fn() },
}))
vi.mock("../../integrations/openai-codex/rate-limits", () => ({
	fetchOpenAiCodexRateLimitInfo: vi.fn(),
}))
vi.mock("../../core/webview/rulesMessageHandler", () => ({
	handleRequestRules: vi.fn(),
	handleCreateRule: vi.fn(),
	handleDeleteRule: vi.fn(),
	handleOpenRuleFile: vi.fn(),
	handleOpenRulesDirectory: vi.fn(),
}))
vi.mock("../../core/webview/diagnosticsHandler", () => ({
	generateErrorDiagnostics: vi.fn().mockResolvedValue({ success: true }),
}))

// The provider modules load native SDKs at import time. The save path never
// builds a handler, so a bare double is enough.
vi.mock("@anthropic-ai/vertex-sdk", () => ({ AnthropicVertex: vi.fn() }))
vi.mock("google-auth-library", () => ({ GoogleAuth: vi.fn() }))
vi.mock("ollama", () => ({ Ollama: vi.fn() }))

vi.mock("../../i18n", () => ({
	t: vi.fn((key: string) => key),
	changeLanguage: vi.fn(),
}))

vi.mock("fs/promises", () => ({
	__esModule: true,
	default: { readFile: vi.fn() },
	readFile: vi.fn(),
}))

vi.mock("os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("os")>()
	return { ...actual, default: { ...actual, homedir: vi.fn(() => "/mock/home") }, homedir: vi.fn(() => "/mock/home") }
})

vi.mock("../fs", () => ({ fileExistsAtPath: vi.fn() }))

vi.mock("../../core/config/ProviderSettingsManager", async (importOriginal) => {
	const originalModule = await importOriginal<typeof import("../../core/config/ProviderSettingsManager")>()
	return {
		__esModule: true,
		// The import needs the real schemas and a manager whose storage writes stay local.
		...(originalModule || {}),
		ProviderSettingsManager: vi.fn().mockImplementation(function () {
			return {
				export: vi.fn().mockResolvedValue({
					apiConfigs: {},
					modeApiConfigs: {},
					currentApiConfigName: "default",
				}),
				import: vi.fn().mockResolvedValue({ success: true }),
				listConfig: vi.fn().mockResolvedValue([]),
			}
		}),
	}
})

vi.mock("../../core/config/ContextProxy")
vi.mock("../../core/config/CustomModesManager")

import * as vscode from "vscode"
import type { Mock } from "vitest"
import fsPromises from "fs/promises"

import type { ClineProvider } from "../../core/webview/ClineProvider"
import type { ContextProxy } from "../../core/config/ContextProxy"
import type { CustomModesManager } from "../../core/config/CustomModesManager"
import type { ProviderSettingsManager } from "../../core/config/ProviderSettingsManager"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

import { Package } from "../../shared/package"
import { makeWorkspaceConfiguration } from "../../test-utils/vscode"
import { autoImportSettings } from "../autoImportSettings"
import { fileExistsAtPath } from "../fs"
import { webviewMessageHandler } from "../../core/webview/webviewMessageHandler"

type CommandLists = { allowedCommands?: string[]; deniedCommands?: string[] }

describe("auto-imported command lists survive a later save", () => {
	// One settings file stands for the user-level layer. The mirror writes into
	// it, and the save's snapshot reads it back.
	let settingsFile: CommandLists
	// The extension-state copy, which the import and the save both write.
	let stateCopy: Record<string, string[] | undefined>
	let state: Record<string, unknown>
	let mockContextProxy: ContextProxy
	let mockProviderSettingsManager: ProviderSettingsManager
	let mockCustomModesManager: CustomModesManager
	let update: Mock

	beforeEach(() => {
		vi.clearAllMocks()

		// A user-level list predates the import, so the save has a layer to
		// compare against. Without it the absent-layer exception would keep the
		// entries for a different reason.
		settingsFile = { allowedCommands: ["git"], deniedCommands: ["aws"] }
		stateCopy = {}
		state = {}

		// The double provides the proxy members the import calls: the bulk and
		// single state writes, the provider settings write, and the read that
		// backs the save's snapshot.
		mockContextProxy = {
			setValues: vi.fn(async (values: Record<string, unknown>) => {
				Object.assign(state, values)
				Object.assign(stateCopy, values)
			}),
			setValue: vi.fn(async (key: string, value: unknown) => {
				state[key] = value
				stateCopy[key] = value as string[] | undefined
			}),
			setProviderSettings: vi.fn().mockResolvedValue(undefined),
			getValue: vi.fn((key: string) => state[key]),
		} as unknown as ContextProxy

		// The double provides the manager members the import calls: the profile
		// export and import, and the config listing.
		mockProviderSettingsManager = {
			export: vi.fn().mockResolvedValue({
				apiConfigs: {},
				modeApiConfigs: {},
				currentApiConfigName: "default",
			}),
			import: vi.fn().mockResolvedValue({ success: true }),
			listConfig: vi.fn().mockResolvedValue([]),
		} as unknown as ProviderSettingsManager

		// The double provides updateCustomMode, the one member the import calls.
		mockCustomModesManager = {
			updateCustomMode: vi.fn().mockResolvedValue(undefined),
		} as unknown as CustomModesManager

		// The shared double keeps the configuration type correct. The scripted
		// members make the file stateful, as the real API is: a write changes
		// what the next read reports.
		const config = makeWorkspaceConfiguration({
			workspaceCommandListsEnabled: true,
			autoImportSettingsPath: "/mock/auto-import.json",
		})
		update = vi.fn(async (key: string, value: unknown) => {
			settingsFile[key as keyof CommandLists] = value as string[]
		})
		const inspect = vi.fn((key: string) => ({
			key,
			globalValue: settingsFile[key as keyof CommandLists],
		}))
		config.update = update
		// The double answers for every key with the stored list. The real member's
		// generic return type cannot be expressed by a mock, so the cast stays here
		// and names the member this double provides.
		config.inspect = inspect as unknown as typeof config.inspect
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(config)

		vi.mocked(fileExistsAtPath).mockResolvedValue(true)
		;(fsPromises.readFile as Mock).mockResolvedValue(
			JSON.stringify({
				providerProfiles: {
					currentApiConfigName: "imported-profile",
					apiConfigs: {
						"imported-profile": {
							apiProvider: providerIdentifiers.anthropic,
							anthropicApiKey: "test-key",
						},
					},
				},
				globalSettings: {
					allowedCommands: ["git", "imported"],
					deniedCommands: ["rm -rf"],
				},
			}),
		)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	// Double provides the members these two paths call: the import's state
	// writes, and the save's reads and writes.
	const provider = () =>
		({
			contextProxy: mockContextProxy,
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
			getCurrentTask: vi.fn().mockReturnValue(undefined),
			getSkillsManager: vi.fn().mockReturnValue(undefined),
			getMcpHub: vi.fn().mockReturnValue(undefined),
			cwd: "/mock/workspace",
			context: { globalStorageUri: { fsPath: "/mock/storage" } },
		}) as unknown as ClineProvider

	const runAutoImport = async () => {
		// Double provides only appendLine, the sole OutputChannel member the SUT calls.
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		await autoImportSettings(outputChannel, {
			providerSettingsManager: mockProviderSettingsManager,
			contextProxy: mockContextProxy,
			customModesManager: mockCustomModesManager,
		})
	}

	// The dialog submits the list it displayed, with the baseline it was posted.
	const saveDisplayedLists = async () =>
		webviewMessageHandler(provider(), {
			type: "updateSettings",
			updatedSettings: {
				allowedCommands: stateCopy.allowedCommands,
				deniedCommands: stateCopy.deniedCommands,
			},
			commandListBaseline: {
				allowedCommands: stateCopy.allowedCommands,
				deniedCommands: stateCopy.deniedCommands,
				workspaceCommandListsEnabled: true,
			},
		})

	it("writes the imported command lists into the settings file", async () => {
		await runAutoImport()

		expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith(Package.name)
		expect(update).toHaveBeenCalledWith("allowedCommands", ["git", "imported"], vscode.ConfigurationTarget.Global)
		expect(update).toHaveBeenCalledWith("deniedCommands", ["rm -rf"], vscode.ConfigurationTarget.Global)
		// The import's own state write still holds the lists.
		expect(stateCopy.allowedCommands).toEqual(["git", "imported"])
		expect(stateCopy.deniedCommands).toEqual(["rm -rf"])
	})

	it("keeps the imported entries through a later unrelated save", async () => {
		await runAutoImport()

		await saveDisplayedLists()

		// Both lists survive in the settings file, not just the state copy.
		expect(settingsFile.allowedCommands).toEqual(["git", "imported"])
		expect(settingsFile.deniedCommands).toEqual(["rm -rf"])
		// The save reports retention, so it discloses no file-side change.
		expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
	})

	it("does not mirror the lists when the import fails", async () => {
		;(fsPromises.readFile as Mock).mockResolvedValue("invalid json")

		await runAutoImport()

		// The pre-existing layer stays exactly as it was.
		expect(settingsFile).toEqual({ allowedCommands: ["git"], deniedCommands: ["aws"] })
		expect(update).not.toHaveBeenCalled()
	})
})
