// npx vitest core/webview/__tests__/webviewMessageHandler.spec.ts

import type { Mock } from "vitest"

// Mock dependencies - must come before imports
vi.mock("../../../api/providers/fetchers/modelCache")
vi.mock("../../../services/zoo-code-auth", () => ({
	disconnectZooCode: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("../../../api/providers/fetchers/lmstudio", () => ({
	getLMStudioModels: vi.fn(),
}))

vi.mock("../../../integrations/theme/getTheme", () => ({
	getTheme: vi.fn().mockResolvedValue({}),
}))

vi.mock("../../../integrations/openai-codex/oauth", () => ({
	openAiCodexOAuthManager: {
		getAccessToken: vi.fn(),
		getAccountId: vi.fn(),
	},
}))

vi.mock("../../../integrations/openai-codex/rate-limits", () => ({
	fetchOpenAiCodexRateLimitInfo: vi.fn(),
}))

vi.mock("../../../services/command/commands", () => ({
	getCommands: vi.fn(),
}))

vi.mock("../../../services/destructive-command-guard", () => ({
	ensureDcgInstalled: vi.fn(),
}))

vi.mock("@anthropic-ai/vertex-sdk", () => ({
	AnthropicVertex: vi.fn(),
}))

vi.mock("google-auth-library", () => ({
	GoogleAuth: vi.fn(),
}))

vi.mock("ollama", () => ({
	Ollama: vi.fn(),
}))

// Mock the diagnosticsHandler module
vi.mock("../diagnosticsHandler", () => ({
	generateErrorDiagnostics: vi.fn().mockResolvedValue({ success: true, filePath: "/tmp/diagnostics.json" }),
}))

vi.mock("../rulesMessageHandler", () => ({
	handleRequestRules: vi.fn(),
	handleCreateRule: vi.fn(),
	handleDeleteRule: vi.fn(),
	handleOpenRuleFile: vi.fn(),
	handleOpenRulesDirectory: vi.fn(),
}))

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		hasInstance: vi.fn().mockReturnValue(false),
		instance: {
			updateTelemetryState: vi.fn(),
			captureTelemetrySettingsChanged: vi.fn(),
		},
	},
}))

import { ContextProxy } from "../../config/ContextProxy"
import { makeExtensionContext } from "../../../test-utils/vscode"

import type { ModelRecord } from "@roo-code/types"

import { webviewMessageHandler } from "../webviewMessageHandler"
import { enqueueSettingsSave } from "../settingsSaveQueue"
import type { ClineProvider } from "../ClineProvider"
import { flushModels, getModels } from "../../../api/providers/fetchers/modelCache"
import { getLMStudioModels } from "../../../api/providers/fetchers/lmstudio"
import { getCommands } from "../../../services/command/commands"
import { ensureDcgInstalled } from "../../../services/destructive-command-guard"
import {
	handleCreateRule,
	handleDeleteRule,
	handleOpenRuleFile,
	handleOpenRulesDirectory,
	handleRequestRules,
} from "../rulesMessageHandler"
const { openAiCodexOAuthManager } = await import("../../../integrations/openai-codex/oauth")
const { fetchOpenAiCodexRateLimitInfo } = await import("../../../integrations/openai-codex/rate-limits")

const mockGetModels = getModels as Mock<typeof getModels>
const mockFlushModels = flushModels as Mock<typeof flushModels>
const mockGetLMStudioModels = getLMStudioModels as Mock<typeof getLMStudioModels>
const mockGetCommands = vi.mocked(getCommands)
const mockGetAccessToken = vi.mocked(openAiCodexOAuthManager.getAccessToken)
const mockGetAccountId = vi.mocked(openAiCodexOAuthManager.getAccountId)
const mockFetchOpenAiCodexRateLimitInfo = vi.mocked(fetchOpenAiCodexRateLimitInfo)

// Mock ClineProvider
const mockSettingsSaveController = new AbortController()
const mockClineProvider = {
	get settingsSaveSignal() {
		return mockSettingsSaveController.signal
	},
	getState: vi.fn(),
	postMessageToWebview: vi.fn(),
	customModesManager: {
		getCustomModes: vi.fn(),
		deleteCustomMode: vi.fn(),
	},
	context: {
		extensionPath: "/mock/extension/path",
		globalStorageUri: { fsPath: "/mock/global/storage" },
	},
	contextProxy: {
		context: {
			extensionPath: "/mock/extension/path",
			globalStorageUri: { fsPath: "/mock/global/storage" },
		},
		setValue: vi.fn(),
		getValue: vi.fn(),
	},
	log: vi.fn(),
	upsertProviderProfile: vi.fn(),
	postStateToWebview: vi.fn(),
	resolveWebviewThemeFixtureProbe: vi.fn(),
	getCurrentTask: vi.fn(),
	getTaskWithId: vi.fn(),
	createTaskWithHistoryItem: vi.fn(),
	getSkillsManager: vi.fn(),
	cwd: "/mock/workspace",
} as unknown as ClineProvider

describe("webviewMessageHandler - theme fixture probes", () => {
	const originalProbeSetting = process.env.ROO_CODE_THEME_FIXTURE_PROBE
	const themeFixture = {
		themeId: "Default Dark Modern",
		bodyClass: "vscode-dark",
		variables: { "--vscode-foreground": "#cccccc" },
	}

	beforeEach(() => {
		vi.clearAllMocks()
		process.env.ROO_CODE_THEME_FIXTURE_PROBE = "1"
	})

	afterEach(() => {
		if (originalProbeSetting === undefined) {
			delete process.env.ROO_CODE_THEME_FIXTURE_PROBE
		} else {
			process.env.ROO_CODE_THEME_FIXTURE_PROBE = originalProbeSetting
		}
	})

	it("resolves a complete response when probing is enabled", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "themeFixtureProbeResponse",
			requestId: "request-1",
			themeFixture,
		})

		expect(mockClineProvider.resolveWebviewThemeFixtureProbe).toHaveBeenCalledWith("request-1", themeFixture)
	})

	it("ignores incomplete or disabled responses", async () => {
		await webviewMessageHandler(mockClineProvider, { type: "themeFixtureProbeResponse" })
		delete process.env.ROO_CODE_THEME_FIXTURE_PROBE
		await webviewMessageHandler(mockClineProvider, {
			type: "themeFixtureProbeResponse",
			requestId: "request-1",
			themeFixture,
		})

		expect(mockClineProvider.resolveWebviewThemeFixtureProbe).not.toHaveBeenCalled()
	})
})

import { changeLanguage, t } from "../../../i18n"

vi.mock("vscode", () => {
	const showInformationMessage = vi.fn()
	const showErrorMessage = vi.fn()
	const openTextDocument = vi.fn().mockResolvedValue({})
	const showTextDocument = vi.fn().mockResolvedValue(undefined)

	return {
		ConfigurationTarget: { Global: 1 },
		window: {
			showInformationMessage,
			showErrorMessage,
			showTextDocument,
		},
		workspace: {
			workspaceFolders: [{ uri: { fsPath: "/mock/workspace" } }],
			openTextDocument,
			getConfiguration: vi.fn(() => ({ get: vi.fn() })),
		},
		commands: {
			executeCommand: vi.fn().mockResolvedValue(undefined),
		},
		env: {
			isTelemetryEnabled: true,
		},
	}
})

vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string, args?: Record<string, any>) => {
		// For the delete confirmation with rules, we need to return the interpolated string
		if (key === "common:confirmation.delete_custom_mode_with_rules" && args) {
			return `Are you sure you want to delete this ${args.scope} mode?\n\nThis will also delete the associated rules folder at:\n${args.rulesFolderPath}`
		}
		// Return the translated value for "Yes"
		if (key === "common:answers.yes") {
			return "Yes"
		}
		// Return the translated value for "Cancel"
		if (key === "common:answers.cancel") {
			return "Cancel"
		}
		return key
	}),
	changeLanguage: vi.fn(),
}))

vi.mock("fs/promises", () => {
	const mockRm = vi.fn().mockResolvedValue(undefined)
	const mockMkdir = vi.fn().mockResolvedValue(undefined)
	const mockReadFile = vi.fn().mockResolvedValue("[]")
	const mockWriteFile = vi.fn().mockResolvedValue(undefined)

	return {
		default: {
			rm: mockRm,
			mkdir: mockMkdir,
			readFile: mockReadFile,
			writeFile: mockWriteFile,
		},
		rm: mockRm,
		mkdir: mockMkdir,
		readFile: mockReadFile,
		writeFile: mockWriteFile,
	}
})

import * as vscode from "vscode"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as fsUtils from "../../../utils/fs"
import { getWorkspacePath } from "../../../utils/path"
import { ensureSettingsDirectoryExists } from "../../../utils/globalContext"
import { generateErrorDiagnostics } from "../diagnosticsHandler"
import type { ModeConfig } from "@roo-code/types"

vi.mock("../../../utils/fs")
vi.mock("../../../utils/path")
vi.mock("../../../utils/globalContext")

vi.mock("../../mentions/resolveImageMentions", () => ({
	resolveImageMentions: vi.fn(async ({ text, images }: { text: string; images?: string[] }) => ({
		text,
		images: [...(images ?? []), "data:image/png;base64,from-mention"],
	})),
}))

import { resolveImageMentions } from "../../mentions/resolveImageMentions"
import { Terminal } from "../../../integrations/terminal/Terminal"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import { providerIdentifiers, retiredProviderIdentifiers } from "@roo-code/types/provider-identifiers"

describe("webviewMessageHandler - requestLmStudioModels", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockGetLMStudioModels.mockReset()
		mockClineProvider.getState = vi.fn().mockResolvedValue({
			apiConfiguration: {
				lmStudioModelId: "model-1",
				lmStudioBaseUrl: "http://localhost:1234",
			},
		})
	})

	it("successfully fetches models from LMStudio", async () => {
		const mockModels: ModelRecord = {
			"model-1": {
				maxTokens: 4096,
				contextWindow: 8192,
				supportsPromptCache: false,
				description: "Test model 1",
			},
			"model-2": {
				maxTokens: 8192,
				contextWindow: 16384,
				supportsPromptCache: false,
				description: "Test model 2",
			},
		}

		mockGetModels.mockResolvedValue(mockModels)

		await webviewMessageHandler(mockClineProvider, {
			type: "requestLmStudioModels",
		})

		expect(mockGetModels).toHaveBeenCalledWith({
			provider: providerIdentifiers.lmstudio,
			baseUrl: "http://localhost:1234",
		})

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "lmStudioModels",
			lmStudioModels: mockModels,
		})
	})

	it("prefers the request payload base URL over persisted settings", async () => {
		mockGetLMStudioModels.mockResolvedValue({})

		await webviewMessageHandler(mockClineProvider, {
			type: "requestLmStudioModels",
			values: { baseUrl: "http://127.0.0.1:4321" },
		})

		expect(mockGetLMStudioModels).toHaveBeenCalledWith("http://127.0.0.1:4321")
		expect(mockGetModels).not.toHaveBeenCalled()
	})

	it("treats an empty-string base URL as an explicit preview request", async () => {
		mockGetLMStudioModels.mockResolvedValue({})

		await webviewMessageHandler(mockClineProvider, {
			type: "requestLmStudioModels",
			values: { baseUrl: "" },
		})

		expect(mockGetLMStudioModels).toHaveBeenCalledWith("")
		expect(mockGetModels).not.toHaveBeenCalled()
	})
})

describe("webviewMessageHandler - image mentions", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockClineProvider.getState = vi.fn().mockResolvedValue({
			maxImageFileSize: 5,
			maxTotalImageSize: 20,
		})
	})

	it("should resolve image mentions for askResponse payloads", async () => {
		const mockHandleWebviewAskResponse = vi.fn()
		vi.mocked(mockClineProvider.getCurrentTask).mockReturnValue({
			cwd: "/mock/workspace",
			rooIgnoreController: undefined,
			handleWebviewAskResponse: mockHandleWebviewAskResponse,
		} as any)

		await webviewMessageHandler(mockClineProvider, {
			type: "askResponse",
			askResponse: "messageResponse",
			text: "See @/img.png",
			images: [],
		})

		expect(vi.mocked(resolveImageMentions)).toHaveBeenCalled()
		expect(mockHandleWebviewAskResponse).toHaveBeenCalledWith("messageResponse", "See @/img.png", [
			"data:image/png;base64,from-mention",
		])
	})
})

describe("webviewMessageHandler - requestOllamaModels", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockFlushModels.mockReset()
		mockFlushModels.mockResolvedValue(undefined)
		mockGetModels.mockReset()
		mockClineProvider.getState = vi.fn().mockResolvedValue({
			apiConfiguration: {
				ollamaModelId: "model-1",
				ollamaBaseUrl: "http://localhost:1234",
			},
		})
	})

	it("successfully fetches models from Ollama", async () => {
		const mockModels: ModelRecord = {
			"model-1": {
				maxTokens: 4096,
				contextWindow: 8192,
				supportsPromptCache: false,
				description: "Test model 1",
			},
			"model-2": {
				maxTokens: 8192,
				contextWindow: 16384,
				supportsPromptCache: false,
				description: "Test model 2",
			},
		}

		mockGetModels.mockResolvedValue(mockModels)

		await webviewMessageHandler(mockClineProvider, {
			type: "requestOllamaModels",
		})

		expect(mockGetModels).toHaveBeenCalledWith({
			provider: providerIdentifiers.ollama,
			baseUrl: "http://localhost:1234",
		})

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "ollamaModels",
			ollamaModels: mockModels,
		})
	})

	it("posts empty models response when no models are found", async () => {
		mockGetModels.mockResolvedValue({})

		await webviewMessageHandler(mockClineProvider, {
			type: "requestOllamaModels",
		})

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "ollamaModels",
			ollamaModels: {},
		})
	})

	it("posts empty models response with error message and logs to output on fetch failure", async () => {
		mockGetModels.mockRejectedValue(new Error("Connection refused"))

		await webviewMessageHandler(mockClineProvider, {
			type: "requestOllamaModels",
		})

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "ollamaModels",
			ollamaModels: {},
			error: "Connection refused",
		})

		expect(mockClineProvider.log).toHaveBeenCalledWith(
			"[requestOllamaModels] Failed to read models for http://localhost:1234: Connection refused",
		)
	})

	it("distinguishes a model cache refresh failure from a model read failure", async () => {
		mockFlushModels.mockRejectedValue(new Error("Cache write failed"))

		await webviewMessageHandler(mockClineProvider, {
			type: "requestOllamaModels",
			values: { baseUrl: "https://ollama.example.com" },
		})

		expect(mockGetModels).not.toHaveBeenCalled()
		expect(mockClineProvider.log).toHaveBeenCalledWith(
			"[requestOllamaModels] Failed to refresh model cache for https://ollama.example.com: Cache write failed",
		)
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "ollamaModels",
			ollamaModels: {},
			error: "Cache write failed",
		})
	})

	it("uses baseUrl from message values over saved state", async () => {
		const mockModels: ModelRecord = {
			"remote-model": {
				maxTokens: 4096,
				contextWindow: 8192,
				supportsPromptCache: false,
				description: "Remote model",
			},
		}

		mockGetModels.mockResolvedValue(mockModels)

		await webviewMessageHandler(mockClineProvider, {
			type: "requestOllamaModels",
			values: {
				baseUrl: "https://ollama.example.com",
				apiKey: "secret-key",
			},
		})

		// Should use the URL from message values, not the saved state
		expect(mockFlushModels).toHaveBeenCalledWith(
			{
				provider: providerIdentifiers.ollama,
				baseUrl: "https://ollama.example.com",
				apiKey: "secret-key",
			},
			true,
		)
		expect(mockGetModels).toHaveBeenCalledWith({
			provider: providerIdentifiers.ollama,
			baseUrl: "https://ollama.example.com",
			apiKey: "secret-key",
		})

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "ollamaModels",
			ollamaModels: mockModels,
		})
	})
})

describe("webviewMessageHandler - requestRouterModels", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockClineProvider.getState = vi.fn().mockResolvedValue({
			apiConfiguration: {
				openRouterApiKey: "openrouter-key",
				requestyApiKey: "requesty-key",
				litellmApiKey: "litellm-key",
				litellmBaseUrl: "http://localhost:4000",
			},
		})
	})

	it("successfully fetches models from all providers", async () => {
		const mockModels: ModelRecord = {
			"model-1": {
				maxTokens: 4096,
				contextWindow: 8192,
				supportsPromptCache: false,
				description: "Test model 1",
			},
			"model-2": {
				maxTokens: 8192,
				contextWindow: 16384,
				supportsPromptCache: false,
				description: "Test model 2",
			},
		}

		mockGetModels.mockResolvedValue(mockModels)

		await webviewMessageHandler(mockClineProvider, {
			type: "requestRouterModels",
		})

		// Verify getModels was called for each provider
		expect(mockGetModels).toHaveBeenCalledWith({ provider: providerIdentifiers.openrouter })
		expect(mockGetModels).toHaveBeenCalledWith({ provider: providerIdentifiers.requesty, apiKey: "requesty-key" })
		expect(mockGetModels).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: providerIdentifiers.unbound,
			}),
		)
		expect(mockGetModels).toHaveBeenCalledWith({ provider: providerIdentifiers.vercelAiGateway })
		expect(mockGetModels).toHaveBeenCalledWith({
			provider: providerIdentifiers.litellm,
			apiKey: "litellm-key",
			baseUrl: "http://localhost:4000",
		})
		// Opencode Go's /models endpoint is public, so it is fetched like the other no-auth routers.
		expect(mockGetModels).toHaveBeenCalledWith(
			expect.objectContaining({ provider: providerIdentifiers.opencodeGo }),
		)
		// Kenari's /models endpoint is public, so it is fetched like the other no-auth routers.
		expect(mockGetModels).toHaveBeenCalledWith(expect.objectContaining({ provider: providerIdentifiers.kenari }))
		// NanoGPT's detailed catalog is public and may optionally be scoped by a key.
		expect(mockGetModels).toHaveBeenCalledWith({ provider: providerIdentifiers.nanogpt, apiKey: undefined })

		// Verify response was sent
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "routerModels",
			routerModels: {
				openrouter: mockModels,
				requesty: mockModels,
				unbound: mockModels,
				"vercel-ai-gateway": mockModels,
				"zoo-gateway": mockModels,
				litellm: mockModels,
				ollama: {},
				lmstudio: {},
				poe: {},
				deepseek: {},
				moonshot: {},
				"opencode-go": mockModels,
				kenari: mockModels,
				nanogpt: mockModels,
				"kimi-code": {},
			},
			values: undefined,
		})
	})

	it("fetches Opencode Go models without an API key (public /models endpoint, regression for empty picker)", async () => {
		mockClineProvider.getState = vi.fn().mockResolvedValue({
			apiConfiguration: {
				openRouterApiKey: "openrouter-key",
				// Deliberately no opencodeGoApiKey — the endpoint is public.
			},
		})

		const mockModels: ModelRecord = {
			"glm-5.1": {
				maxTokens: 4096,
				contextWindow: 8192,
				supportsPromptCache: false,
				description: "GLM 5.1",
			},
		}
		mockGetModels.mockResolvedValue(mockModels)

		await webviewMessageHandler(mockClineProvider, { type: "requestRouterModels" })

		// Must be fetched despite no configured key, forwarding apiKey: undefined.
		expect(mockGetModels).toHaveBeenCalledWith({ provider: providerIdentifiers.opencodeGo, apiKey: undefined })

		const routerModelsCall = (mockClineProvider.postMessageToWebview as any).mock.calls.find(
			([msg]: [{ type: string }]) => msg.type === "routerModels",
		)
		expect(routerModelsCall?.[0].routerModels["opencode-go"]).toEqual(mockModels)
	})

	it("flushes and fetches Opencode Go models when an explicit API key is supplied", async () => {
		mockClineProvider.getState = vi.fn().mockResolvedValue({
			apiConfiguration: {},
		})
		mockGetModels.mockResolvedValue({
			"opencode/model": {
				maxTokens: 4096,
				contextWindow: 8192,
				supportsPromptCache: false,
				description: "Opencode model",
			},
		})

		await webviewMessageHandler(mockClineProvider, {
			type: "requestRouterModels",
			values: {
				provider: providerIdentifiers.opencodeGo,
				opencodeGoApiKey: "fresh-key",
			},
		})

		expect(mockFlushModels).toHaveBeenCalledWith(
			{ provider: providerIdentifiers.opencodeGo, apiKey: "fresh-key" },
			true,
		)
		expect(mockGetModels).toHaveBeenCalledWith({ provider: providerIdentifiers.opencodeGo, apiKey: "fresh-key" })
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "routerModels",
			routerModels: {
				"opencode-go": {
					"opencode/model": expect.objectContaining({ description: "Opencode model" }),
				},
			},
			values: { provider: providerIdentifiers.opencodeGo },
		})
	})

	it("flushes and fetches Kenari models when an explicit API key is supplied", async () => {
		mockClineProvider.getState = vi.fn().mockResolvedValue({
			apiConfiguration: {},
		})
		mockGetModels.mockResolvedValue({
			"glm-5-2": {
				maxTokens: 32768,
				contextWindow: 1048576,
				supportsPromptCache: false,
				description: "Kenari model",
			},
		})

		await webviewMessageHandler(mockClineProvider, {
			type: "requestRouterModels",
			values: {
				provider: providerIdentifiers.kenari,
				kenariApiKey: "fresh-kenari-key",
			},
		})

		expect(mockFlushModels).toHaveBeenCalledWith(
			{ provider: providerIdentifiers.kenari, apiKey: "fresh-kenari-key" },
			true,
		)
		expect(mockGetModels).toHaveBeenCalledWith({ provider: providerIdentifiers.kenari, apiKey: "fresh-kenari-key" })
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "routerModels",
			routerModels: {
				kenari: {
					"glm-5-2": expect.objectContaining({ description: "Kenari model" }),
				},
			},
			values: { provider: providerIdentifiers.kenari },
		})
	})

	it("fetches NanoGPT publicly without an API key", async () => {
		mockClineProvider.getState = vi.fn().mockResolvedValue({ apiConfiguration: {} })
		mockGetModels.mockResolvedValue({
			"openai/gpt-5.6-sol": { maxTokens: 128000, contextWindow: 1050000, supportsPromptCache: false },
		})

		await webviewMessageHandler(mockClineProvider, {
			type: "requestRouterModels",
			values: { provider: providerIdentifiers.nanogpt },
		})

		expect(mockGetModels).toHaveBeenCalledWith({ provider: providerIdentifiers.nanogpt, apiKey: undefined })
		expect(mockFlushModels).not.toHaveBeenCalled()
	})

	it("prefers an unsaved NanoGPT key and refreshes the matching key-scoped cache", async () => {
		mockClineProvider.getState = vi.fn().mockResolvedValue({
			apiConfiguration: { nanoGptApiKey: "saved-key" },
		})
		mockGetModels.mockResolvedValue({
			"openai/gpt-5.6-sol": { maxTokens: 128000, contextWindow: 1050000, supportsPromptCache: false },
		})

		await webviewMessageHandler(mockClineProvider, {
			type: "requestRouterModels",
			values: { provider: providerIdentifiers.nanogpt, nanoGptApiKey: "unsaved-key" },
		})

		expect(mockFlushModels).toHaveBeenCalledWith(
			{ provider: providerIdentifiers.nanogpt, apiKey: "unsaved-key" },
			true,
		)
		expect(mockGetModels).toHaveBeenCalledWith({ provider: providerIdentifiers.nanogpt, apiKey: "unsaved-key" })
	})

	it("uses the saved NanoGPT key for manual refresh", async () => {
		mockClineProvider.getState = vi.fn().mockResolvedValue({
			apiConfiguration: { nanoGptApiKey: "saved-key" },
		})
		mockGetModels.mockResolvedValue({})

		await webviewMessageHandler(mockClineProvider, {
			type: "requestRouterModels",
			values: { provider: providerIdentifiers.nanogpt, refresh: true },
		})

		expect(mockFlushModels).toHaveBeenCalledWith(
			{ provider: providerIdentifiers.nanogpt, apiKey: "saved-key" },
			true,
		)
		expect(mockGetModels).toHaveBeenCalledWith({ provider: providerIdentifiers.nanogpt, apiKey: "saved-key" })
	})

	it("handles LiteLLM models with values from message when config is missing", async () => {
		mockClineProvider.getState = vi.fn().mockResolvedValue({
			apiConfiguration: {
				openRouterApiKey: "openrouter-key",
				requestyApiKey: "requesty-key",
				// Missing litellm config
			},
		})

		const mockModels: ModelRecord = {
			"model-1": {
				maxTokens: 4096,
				contextWindow: 8192,
				supportsPromptCache: false,
				description: "Test model 1",
			},
		}

		mockGetModels.mockResolvedValue(mockModels)

		await webviewMessageHandler(mockClineProvider, {
			type: "requestRouterModels",
			values: {
				litellmApiKey: "message-litellm-key",
				litellmBaseUrl: "http://message-url:4000",
			},
		})

		// Verify LiteLLM was called with values from message
		expect(mockGetModels).toHaveBeenCalledWith({
			provider: providerIdentifiers.litellm,
			apiKey: "message-litellm-key",
			baseUrl: "http://message-url:4000",
		})
	})

	it("skips LiteLLM when both config and message values are missing", async () => {
		mockClineProvider.getState = vi.fn().mockResolvedValue({
			apiConfiguration: {
				openRouterApiKey: "openrouter-key",
				requestyApiKey: "requesty-key",
				// Missing litellm config
			},
		})

		const mockModels: ModelRecord = {
			"model-1": {
				maxTokens: 4096,
				contextWindow: 8192,
				supportsPromptCache: false,
				description: "Test model 1",
			},
		}

		mockGetModels.mockResolvedValue(mockModels)

		await webviewMessageHandler(mockClineProvider, {
			type: "requestRouterModels",
			// No values provided
		})

		// Verify LiteLLM was NOT called
		expect(mockGetModels).not.toHaveBeenCalledWith(
			expect.objectContaining({
				provider: providerIdentifiers.litellm,
			}),
		)

		// Verify response includes empty object for LiteLLM
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "routerModels",
			routerModels: {
				openrouter: mockModels,
				requesty: mockModels,
				unbound: mockModels,
				"vercel-ai-gateway": mockModels,
				"zoo-gateway": mockModels,
				litellm: {},
				ollama: {},
				lmstudio: {},
				poe: {},
				deepseek: {},
				moonshot: {},
				"opencode-go": mockModels,
				kenari: mockModels,
				nanogpt: mockModels,
				"kimi-code": {},
			},
			values: undefined,
		})
	})

	it("handles individual provider failures gracefully", async () => {
		const mockModels: ModelRecord = {
			"model-1": {
				maxTokens: 4096,
				contextWindow: 8192,
				supportsPromptCache: false,
				description: "Test model 1",
			},
		}

		// Mock some providers to succeed and others to fail
		mockGetModels
			.mockResolvedValueOnce(mockModels) // openrouter
			.mockRejectedValueOnce(new Error("Requesty API error")) // requesty
			.mockResolvedValueOnce(mockModels) // unbound
			.mockResolvedValueOnce(mockModels) // vercel-ai-gateway
			.mockResolvedValueOnce(mockModels) // zoo-gateway
			.mockRejectedValueOnce(new Error("LiteLLM connection failed")) // litellm
			.mockResolvedValueOnce(mockModels) // opencode-go
			.mockResolvedValueOnce(mockModels) // kenari
			.mockResolvedValueOnce(mockModels) // nanogpt

		await webviewMessageHandler(mockClineProvider, {
			type: "requestRouterModels",
		})

		// Verify error messages were sent for failed providers (these come first)
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "singleRouterModelFetchResponse",
			success: false,
			error: "Requesty API error",
			values: { provider: providerIdentifiers.requesty },
		})

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "singleRouterModelFetchResponse",
			success: false,
			error: "LiteLLM connection failed",
			values: { provider: providerIdentifiers.litellm },
		})

		// Verify final routerModels response includes successful providers and empty objects for failed ones
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "routerModels",
			routerModels: {
				openrouter: mockModels,
				requesty: {},
				unbound: mockModels,
				"vercel-ai-gateway": mockModels,
				"zoo-gateway": mockModels,
				litellm: {},
				ollama: {},
				lmstudio: {},
				poe: {},
				deepseek: {},
				moonshot: {},
				"opencode-go": mockModels,
				kenari: mockModels,
				nanogpt: mockModels,
				"kimi-code": {},
			},
			values: undefined,
		})
	})

	it("handles Error objects and string errors correctly", async () => {
		// Mock providers to fail with different error types
		mockGetModels
			.mockRejectedValueOnce(new Error("Structured error message")) // openrouter
			.mockRejectedValueOnce(new Error("Requesty API error")) // requesty
			.mockRejectedValueOnce(new Error("Unbound error")) // unbound
			.mockRejectedValueOnce(new Error("Vercel AI Gateway error")) // vercel-ai-gateway
			.mockRejectedValueOnce(new Error("Zoo Gateway error")) // zoo-gateway
			.mockRejectedValueOnce(new Error("LiteLLM connection failed")) // litellm

		await webviewMessageHandler(mockClineProvider, {
			type: "requestRouterModels",
		})

		// Verify error handling for different error types
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "singleRouterModelFetchResponse",
			success: false,
			error: "Structured error message",
			values: { provider: providerIdentifiers.openrouter },
		})

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "singleRouterModelFetchResponse",
			success: false,
			error: "Requesty API error",
			values: { provider: providerIdentifiers.requesty },
		})

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "singleRouterModelFetchResponse",
			success: false,
			error: "Unbound error",
			values: { provider: providerIdentifiers.unbound },
		})

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "singleRouterModelFetchResponse",
			success: false,
			error: "Vercel AI Gateway error",
			values: { provider: providerIdentifiers.vercelAiGateway },
		})

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "singleRouterModelFetchResponse",
			success: false,
			error: "LiteLLM connection failed",
			values: { provider: providerIdentifiers.litellm },
		})
	})

	it("returns an explicit removal error for requestRooModels", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "requestRooModels",
		})

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "singleRouterModelFetchResponse",
			success: false,
			error: "Roo Code Router has been removed. Please select and configure a different provider.",
			values: { provider: retiredProviderIdentifiers.roo },
		})
	})

	it("prefers message values over config values for LiteLLM", async () => {
		const mockModels: ModelRecord = {}
		mockGetModels.mockResolvedValue(mockModels)

		await webviewMessageHandler(mockClineProvider, {
			type: "requestRouterModels",
			values: {
				litellmApiKey: "message-key",
				litellmBaseUrl: "http://message-url",
			},
		})

		// Verify message values take precedence over saved config (current unsaved field state wins)
		expect(mockGetModels).toHaveBeenCalledWith({
			provider: providerIdentifiers.litellm,
			apiKey: "message-key", // From message.values
			baseUrl: "http://message-url", // From message.values
		})
	})
})

describe("webviewMessageHandler - requestOpenAiCodexRateLimits", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockGetAccessToken.mockResolvedValue(null)
		mockGetAccountId.mockResolvedValue(null)
	})

	it("posts error when not authenticated", async () => {
		await webviewMessageHandler(mockClineProvider, { type: "requestOpenAiCodexRateLimits" } as any)

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "openAiCodexRateLimits",
			error: "Not authenticated with OpenAI Codex",
		})
	})

	it("posts values when authenticated", async () => {
		mockGetAccessToken.mockResolvedValue("token")
		mockGetAccountId.mockResolvedValue("acct_123")
		mockFetchOpenAiCodexRateLimitInfo.mockResolvedValue({
			primary: { usedPercent: 10, resetsAt: 1700000000000 },
			fetchedAt: 1700000000000,
		})

		await webviewMessageHandler(mockClineProvider, { type: "requestOpenAiCodexRateLimits" } as any)

		expect(mockFetchOpenAiCodexRateLimitInfo).toHaveBeenCalledWith("token", { accountId: "acct_123" })
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "openAiCodexRateLimits",
			values: {
				primary: { usedPercent: 10, resetsAt: 1700000000000 },
				fetchedAt: 1700000000000,
			},
		})
	})
})

describe("webviewMessageHandler - deleteCustomMode", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(getWorkspacePath).mockReturnValue("/mock/workspace")
		vi.mocked(vscode.window.showErrorMessage).mockResolvedValue(undefined)
		vi.mocked(ensureSettingsDirectoryExists).mockResolvedValue("/mock/global/storage/.roo")
	})

	it("should delete a project mode and its rules folder", async () => {
		const slug = "test-project-mode"
		const rulesFolderPath = path.join("/mock/workspace", ".roo", `rules-${slug}`)

		vi.mocked(mockClineProvider.customModesManager.getCustomModes).mockResolvedValue([
			{
				name: "Test Project Mode",
				slug,
				roleDefinition: "Test Role",
				groups: [],
				source: "project",
			} as ModeConfig,
		])
		vi.mocked(fsUtils.fileExistsAtPath).mockResolvedValue(true)
		vi.mocked(mockClineProvider.customModesManager.deleteCustomMode).mockResolvedValue(undefined)

		await webviewMessageHandler(mockClineProvider, { type: "deleteCustomMode", slug })

		// The confirmation dialog is now handled in the webview, so we don't expect showInformationMessage to be called
		expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()
		expect(mockClineProvider.customModesManager.deleteCustomMode).toHaveBeenCalledWith(slug)
		expect(fs.rm).toHaveBeenCalledWith(rulesFolderPath, { recursive: true, force: true })
	})

	it("should delete a global mode and its rules folder", async () => {
		const slug = "test-global-mode"
		const homeDir = os.homedir()
		const rulesFolderPath = path.join(homeDir, ".roo", `rules-${slug}`)

		vi.mocked(mockClineProvider.customModesManager.getCustomModes).mockResolvedValue([
			{
				name: "Test Global Mode",
				slug,
				roleDefinition: "Test Role",
				groups: [],
				source: "global",
			} as ModeConfig,
		])
		vi.mocked(fsUtils.fileExistsAtPath).mockResolvedValue(true)
		vi.mocked(mockClineProvider.customModesManager.deleteCustomMode).mockResolvedValue(undefined)

		await webviewMessageHandler(mockClineProvider, { type: "deleteCustomMode", slug })

		// The confirmation dialog is now handled in the webview, so we don't expect showInformationMessage to be called
		expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()
		expect(mockClineProvider.customModesManager.deleteCustomMode).toHaveBeenCalledWith(slug)
		expect(fs.rm).toHaveBeenCalledWith(rulesFolderPath, { recursive: true, force: true })
	})

	it("should only delete the mode when rules folder does not exist", async () => {
		const slug = "test-mode-no-rules"
		vi.mocked(mockClineProvider.customModesManager.getCustomModes).mockResolvedValue([
			{
				name: "Test Mode No Rules",
				slug,
				roleDefinition: "Test Role",
				groups: [],
				source: "project",
			} as ModeConfig,
		])
		vi.mocked(fsUtils.fileExistsAtPath).mockResolvedValue(false)
		vi.mocked(mockClineProvider.customModesManager.deleteCustomMode).mockResolvedValue(undefined)

		await webviewMessageHandler(mockClineProvider, { type: "deleteCustomMode", slug })

		// The confirmation dialog is now handled in the webview, so we don't expect showInformationMessage to be called
		expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()
		expect(mockClineProvider.customModesManager.deleteCustomMode).toHaveBeenCalledWith(slug)
		expect(fs.rm).not.toHaveBeenCalled()
	})

	it("should handle errors when deleting rules folder", async () => {
		const slug = "test-mode-error"
		const rulesFolderPath = path.join("/mock/workspace", ".roo", `rules-${slug}`)
		const error = new Error("Permission denied")

		vi.mocked(mockClineProvider.customModesManager.getCustomModes).mockResolvedValue([
			{
				name: "Test Mode Error",
				slug,
				roleDefinition: "Test Role",
				groups: [],
				source: "project",
			} as ModeConfig,
		])
		vi.mocked(fsUtils.fileExistsAtPath).mockResolvedValue(true)
		vi.mocked(mockClineProvider.customModesManager.deleteCustomMode).mockResolvedValue(undefined)
		vi.mocked(fs.rm).mockRejectedValue(error)

		await webviewMessageHandler(mockClineProvider, { type: "deleteCustomMode", slug })

		expect(mockClineProvider.customModesManager.deleteCustomMode).toHaveBeenCalledWith(slug)
		expect(fs.rm).toHaveBeenCalledWith(rulesFolderPath, { recursive: true, force: true })
		// Verify error message is shown to the user
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			t("common:errors.delete_rules_folder_failed", {
				rulesFolderPath,
				error: error.message,
			}),
		)
		// No error response is sent anymore - we just continue with deletion
		expect(mockClineProvider.postMessageToWebview).not.toHaveBeenCalled()
	})
})

describe("webviewMessageHandler - message dialog preferences", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		// Mock a current Cline instance
		vi.mocked(mockClineProvider.getCurrentTask).mockReturnValue({
			taskId: "test-task-id",
			apiConversationHistory: [],
			clineMessages: [],
		} as any)
		// Reset getValue mock
		vi.mocked(mockClineProvider.contextProxy.getValue).mockReturnValue(false)
	})

	describe("deleteMessage", () => {
		it("should always show dialog for delete confirmation", async () => {
			vi.mocked(mockClineProvider.getCurrentTask).mockReturnValue({
				clineMessages: [],
				apiConversationHistory: [],
			} as any) // Mock current cline with proper structure

			await webviewMessageHandler(mockClineProvider, {
				type: "deleteMessage",
				value: 123456789, // Changed from messageTs to value
			})

			expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
				type: "showDeleteMessageDialog",
				messageTs: 123456789,
				hasCheckpoint: false,
			})
		})
	})

	describe("submitEditedMessage", () => {
		it("should always show dialog for edit confirmation", async () => {
			vi.mocked(mockClineProvider.getCurrentTask).mockReturnValue({
				clineMessages: [],
				apiConversationHistory: [],
			} as any) // Mock current cline with proper structure

			await webviewMessageHandler(mockClineProvider, {
				type: "submitEditedMessage",
				value: 123456789,
				editedMessageContent: "edited content",
			})

			expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
				type: "showEditMessageDialog",
				messageTs: 123456789,
				text: "edited content",
				hasCheckpoint: false,
				images: undefined,
			})
		})
	})
})

describe("webviewMessageHandler - mcpEnabled", () => {
	let mockMcpHub: any

	beforeEach(() => {
		vi.clearAllMocks()

		// Create a mock McpHub instance
		mockMcpHub = {
			handleMcpEnabledChange: vi.fn().mockResolvedValue(undefined),
		}

		// Ensure provider exposes getMcpHub and returns our mock
		;(mockClineProvider as any).getMcpHub = vi.fn().mockReturnValue(mockMcpHub)
	})

	it("delegates enable=true to McpHub and posts updated state", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { mcpEnabled: true },
		})

		expect((mockClineProvider as any).getMcpHub).toHaveBeenCalledTimes(1)
		expect(mockMcpHub.handleMcpEnabledChange).toHaveBeenCalledTimes(1)
		expect(mockMcpHub.handleMcpEnabledChange).toHaveBeenCalledWith(true)
		expect(mockClineProvider.postStateToWebview).toHaveBeenCalledTimes(1)
	})

	it("delegates enable=false to McpHub and posts updated state", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { mcpEnabled: false },
		})

		expect((mockClineProvider as any).getMcpHub).toHaveBeenCalledTimes(1)
		expect(mockMcpHub.handleMcpEnabledChange).toHaveBeenCalledTimes(1)
		expect(mockMcpHub.handleMcpEnabledChange).toHaveBeenCalledWith(false)
		expect(mockClineProvider.postStateToWebview).toHaveBeenCalledTimes(1)
	})

	it("handles missing McpHub instance gracefully and still posts state", async () => {
		;(mockClineProvider as any).getMcpHub = vi.fn().mockReturnValue(undefined)

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { mcpEnabled: true },
		})

		expect((mockClineProvider as any).getMcpHub).toHaveBeenCalledTimes(1)
		expect(mockClineProvider.postStateToWebview).toHaveBeenCalledTimes(1)
	})
})

describe("webviewMessageHandler - destructiveCommandGuardEnabled", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(ensureDcgInstalled).mockResolvedValue("/mock/global/storage/dcg")
	})

	it("installs and persists destructive command guard when enabled", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { destructiveCommandGuardEnabled: true },
		})

		expect(ensureDcgInstalled).toHaveBeenCalledWith("/mock/global/storage")
		expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith("destructiveCommandGuardEnabled", true)
		expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
	})

	it("disables the setting and reports an installation failure", async () => {
		vi.mocked(ensureDcgInstalled).mockRejectedValue(new Error("checksum mismatch"))

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { destructiveCommandGuardEnabled: true },
		})

		expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith("destructiveCommandGuardEnabled", false)
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			"common:errors.destructiveCommandGuard.enableFailed",
		)
	})

	it("disables the setting when DCG is unavailable for the current platform", async () => {
		vi.mocked(ensureDcgInstalled).mockResolvedValue(undefined)

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { destructiveCommandGuardEnabled: true },
		})

		expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith("destructiveCommandGuardEnabled", false)
		expect(t).toHaveBeenCalledWith("common:errors.destructiveCommandGuard.unavailable")
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.destructiveCommandGuard.unavailable")
		expect(t).not.toHaveBeenCalledWith("common:errors.destructiveCommandGuard.enableFailed", expect.anything())
	})

	it("reports non-Error installation failures", async () => {
		vi.mocked(ensureDcgInstalled).mockRejectedValue("download unavailable")

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { destructiveCommandGuardEnabled: true },
		})

		expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith("destructiveCommandGuardEnabled", false)
		expect(t).toHaveBeenCalledWith("common:errors.destructiveCommandGuard.enableFailed", {
			error: "download unavailable",
		})
	})

	it("persists disabled state without trying to install", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { destructiveCommandGuardEnabled: false },
		})

		expect(ensureDcgInstalled).not.toHaveBeenCalled()
		expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith("destructiveCommandGuardEnabled", false)
	})
})

// A plain boolean needs no normalization branch in the updateSettings loop,
// so this pins the generic persistence path: every polarity, including an
// explicit unset (undefined), must reach ContextProxy verbatim rather than
// being defaulted away.
it("persists alwaysDenyUnapprovedCommands through the generic updateSettings loop", async () => {
	vi.clearAllMocks()

	await webviewMessageHandler(mockClineProvider, {
		type: "updateSettings",
		updatedSettings: { alwaysDenyUnapprovedCommands: true },
	})

	expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith("alwaysDenyUnapprovedCommands", true)
	expect(mockClineProvider.postStateToWebview).toHaveBeenCalledTimes(1)

	vi.clearAllMocks()
	await webviewMessageHandler(mockClineProvider, {
		type: "updateSettings",
		updatedSettings: { alwaysDenyUnapprovedCommands: false },
	})

	expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith("alwaysDenyUnapprovedCommands", false)
	expect(mockClineProvider.postStateToWebview).toHaveBeenCalledTimes(1)

	vi.clearAllMocks()
	await webviewMessageHandler(mockClineProvider, {
		type: "updateSettings",
		updatedSettings: { alwaysDenyUnapprovedCommands: undefined },
	})

	expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith("alwaysDenyUnapprovedCommands", undefined)
	expect(mockClineProvider.postStateToWebview).toHaveBeenCalledTimes(1)
})

// Both allowlists are normalized by the same branch, so both are held to the
// same contract.
describe.each(["allowedReadFiles", "allowedWriteFiles"] as const)("webviewMessageHandler - %s", (key) => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("persists the configured patterns", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { [key]: ["notes.md", "docs/scratch/**"] },
		})

		expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith(key, ["notes.md", "docs/scratch/**"])
	})

	it("drops entries that cannot name a file", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			// The double assertion stands in for an untyped payload: the message
			// arrives as JSON from the webview, so a non-string can reach the
			// handler even though the type says otherwise. That is what the
			// handler's `typeof` filter is there to catch, so the test has to be
			// able to express it.
			updatedSettings: { [key]: ["notes.md", "", "   ", 42 as unknown as string] },
		})

		expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith(key, ["notes.md"])
	})

	// Whitespace is significant in gitignore syntax, so it must survive saving.
	it("keeps whitespace within a pattern", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { [key]: [" notes.md", "my notes.md", "notes.md\\ "] },
		})

		expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith(key, [
			" notes.md",
			"my notes.md",
			"notes.md\\ ",
		])
	})

	it("persists an empty list when the setting is cleared", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { [key]: [] },
		})

		expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith(key, [])
	})

	// Unlike allowed/denied commands, these settings have no
	// workspace-configuration counterpart, so nothing should be written to VS
	// Code settings.
	it("does not write to the VS Code workspace configuration", async () => {
		const update = vi.fn()
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ update } as never)

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { [key]: ["notes.md"] },
		})

		expect(update).not.toHaveBeenCalled()
	})
})

describe("webviewMessageHandler - allowlists together", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("persists both allowlists from one save", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { allowedReadFiles: ["read.md"], allowedWriteFiles: ["write.md"] },
		})

		expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith("allowedReadFiles", ["read.md"])
		expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith("allowedWriteFiles", ["write.md"])
	})
})

describe("webviewMessageHandler - terminalProfile", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		Terminal.setTerminalProfile(undefined)
	})

	afterEach(() => {
		Terminal.setTerminalProfile(undefined)
		vi.restoreAllMocks()
	})

	it("normalizes and persists a saved terminalProfile, then closes stale idle terminals", async () => {
		const closeIdleTerminalsSpy = vi.spyOn(TerminalRegistry, "closeIdleTerminals").mockImplementation(() => {})

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { terminalProfile: " Git Bash " },
		})

		expect(Terminal.getTerminalProfile()).toBe("Git Bash")
		expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith("terminalProfile", "Git Bash")
		expect(closeIdleTerminalsSpy).toHaveBeenCalledTimes(1)
	})

	it("does not close idle terminals when hydration sends the unchanged profile", async () => {
		Terminal.setTerminalProfile("Git Bash")
		const closeIdleTerminalsSpy = vi.spyOn(TerminalRegistry, "closeIdleTerminals").mockImplementation(() => {})

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { terminalProfile: " Git Bash " },
		})

		expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith("terminalProfile", "Git Bash")
		expect(closeIdleTerminalsSpy).not.toHaveBeenCalled()
	})

	it("clears the persisted profile when SettingsView sends the empty-string sentinel", async () => {
		Terminal.setTerminalProfile("Git Bash")
		const closeIdleTerminalsSpy = vi.spyOn(TerminalRegistry, "closeIdleTerminals").mockImplementation(() => {})

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { terminalProfile: "" },
		})

		expect(Terminal.getTerminalProfile()).toBeUndefined()
		expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith("terminalProfile", undefined)
		expect(closeIdleTerminalsSpy).toHaveBeenCalledTimes(1)
	})

	it("does not close idle terminals when the empty-string sentinel leaves the profile unset", async () => {
		const closeIdleTerminalsSpy = vi.spyOn(TerminalRegistry, "closeIdleTerminals").mockImplementation(() => {})

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { terminalProfile: "" },
		})

		expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith("terminalProfile", undefined)
		expect(closeIdleTerminalsSpy).not.toHaveBeenCalled()
	})

	it("treats non-string terminalProfile values as unset", async () => {
		Terminal.setTerminalProfile("Git Bash")
		const closeIdleTerminalsSpy = vi.spyOn(TerminalRegistry, "closeIdleTerminals").mockImplementation(() => {})

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { terminalProfile: 42 as any },
		})

		expect(Terminal.getTerminalProfile()).toBeUndefined()
		expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith("terminalProfile", undefined)
		expect(closeIdleTerminalsSpy).toHaveBeenCalledTimes(1)
	})
})

describe("webviewMessageHandler - requestTerminalProfiles", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("posts available profile names", async () => {
		vi.spyOn(Terminal, "getAvailableProfileNames").mockReturnValue(["Git Bash", "bash"])

		await webviewMessageHandler(mockClineProvider, { type: "requestTerminalProfiles" })

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "terminalProfiles",
			profiles: ["Git Bash", "bash"],
		})
	})

	it("posts an empty array when profile discovery throws", async () => {
		vi.spyOn(Terminal, "getAvailableProfileNames").mockImplementation(() => {
			throw new Error("config error")
		})

		await webviewMessageHandler(mockClineProvider, { type: "requestTerminalProfiles" })

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "terminalProfiles",
			profiles: [],
		})
	})
})

describe("webviewMessageHandler - openTerminalProfilePicker", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("executes the VS Code selectDefaultShell command", async () => {
		await webviewMessageHandler(mockClineProvider, { type: "openTerminalProfilePicker" })
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.terminal.selectDefaultShell")
	})
})

describe("webviewMessageHandler - requestCommands", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("includes skill slug commands and dedupes duplicate skill names while preserving first skill entry", async () => {
		mockGetCommands.mockResolvedValue([])

		const getTaskMode = vi.fn().mockResolvedValue("code")
		vi.mocked(mockClineProvider.getCurrentTask).mockReturnValue({
			cwd: "/mock/workspace",
			getTaskMode,
		} as unknown as ReturnType<ClineProvider["getCurrentTask"]>)

		const getSkillsForMode = vi.fn().mockReturnValue([
			{
				name: "skill-slug-entry",
				description: "Primary skill slug",
				path: "/mock/.roo/skills/skill-slug-entry/SKILL.md",
				source: "project",
				modeSlugs: ["code"],
			},
			{
				name: "skill-slug-entry",
				description: "Duplicate skill slug",
				path: "/mock/.roo/skills/duplicate-skill/SKILL.md",
				source: "global",
				modeSlugs: ["code"],
			},
			{
				name: "another-skill-slug",
				description: "Another skill-generated command",
				path: "/mock/.roo/skills/another-skill-slug/SKILL.md",
				source: "global",
				modeSlugs: ["code"],
			},
		])

		vi.mocked(mockClineProvider.getSkillsManager).mockReturnValue({
			getSkillsForMode,
		} as unknown as ReturnType<ClineProvider["getSkillsManager"]>)

		await webviewMessageHandler(mockClineProvider, { type: "requestCommands" })

		const commandMessageCall = vi
			.mocked(mockClineProvider.postMessageToWebview)
			.mock.calls.find(([postedMessage]) => postedMessage.type === "commands")
		expect(commandMessageCall).toBeDefined()

		const commandMessage = commandMessageCall?.[0]
		expect(commandMessage?.commands).toEqual(
			expect.arrayContaining([
				{
					name: "skill-slug-entry",
					source: "project",
					filePath: "/mock/.roo/skills/skill-slug-entry/SKILL.md",
					description: "Primary skill slug",
				},
				{
					name: "another-skill-slug",
					source: "global",
					filePath: "/mock/.roo/skills/another-skill-slug/SKILL.md",
					description: "Another skill-generated command",
				},
			]),
		)

		expect(commandMessage?.commands?.filter((command) => command.name === "skill-slug-entry")).toHaveLength(1)
	})

	it("adds skill-backed command entries without overriding existing command names", async () => {
		mockGetCommands.mockResolvedValue([
			{
				name: "deploy",
				content: "existing command",
				source: "project",
				filePath: "/mock/workspace/.roo/commands/deploy.md",
				description: "Deploy command",
				argumentHint: "staging | production",
			},
		])

		const getTaskMode = vi.fn().mockResolvedValue("code")
		vi.mocked(mockClineProvider.getCurrentTask).mockReturnValue({
			cwd: "/mock/workspace",
			getTaskMode,
		} as unknown as ReturnType<ClineProvider["getCurrentTask"]>)

		const getSkillsForMode = vi.fn().mockReturnValue([
			{
				name: "deploy",
				description: "Deploy skill",
				path: "/mock/.roo/skills/deploy/SKILL.md",
				source: "global",
				modeSlugs: ["code"],
			},
			{
				name: "skill-only",
				description: "Skill-generated command",
				path: "/mock/.roo/skills/skill-only/SKILL.md",
				source: "project",
				modeSlugs: ["code"],
			},
		])

		vi.mocked(mockClineProvider.getSkillsManager).mockReturnValue({
			getSkillsForMode,
		} as unknown as ReturnType<ClineProvider["getSkillsManager"]>)

		await webviewMessageHandler(mockClineProvider, { type: "requestCommands" })

		expect(getSkillsForMode).toHaveBeenCalledWith("code")

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "commands",
			commands: expect.arrayContaining([
				{
					name: "deploy",
					source: "project",
					filePath: "/mock/workspace/.roo/commands/deploy.md",
					description: "Deploy command",
					argumentHint: "staging | production",
				},
				{
					name: "skill-only",
					source: "project",
					filePath: "/mock/.roo/skills/skill-only/SKILL.md",
					description: "Skill-generated command",
				},
			]),
		})

		const commandMessageCall = vi
			.mocked(mockClineProvider.postMessageToWebview)
			.mock.calls.find(([postedMessage]) => postedMessage.type === "commands")
		expect(commandMessageCall).toBeDefined()

		const commandMessage = commandMessageCall?.[0]
		expect(commandMessage?.commands?.filter((command) => command.name === "deploy")).toHaveLength(1)
	})

	it("preserves existing behavior when skills manager is unavailable", async () => {
		mockGetCommands.mockResolvedValue([
			{
				name: "build",
				content: "build command",
				source: "built-in",
				filePath: "<built-in:build>",
				description: "Build command",
				argumentHint: "target",
			},
		])

		vi.mocked(mockClineProvider.getCurrentTask).mockReturnValue({
			cwd: "/mock/workspace",
		} as unknown as ReturnType<ClineProvider["getCurrentTask"]>)

		vi.mocked(mockClineProvider.getSkillsManager).mockReturnValue(undefined)

		await webviewMessageHandler(mockClineProvider, { type: "requestCommands" })

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "commands",
			commands: [
				{
					name: "build",
					source: "built-in",
					filePath: "<built-in:build>",
					description: "Build command",
					argumentHint: "target",
				},
			],
		})
	})
})

describe("webviewMessageHandler - rules", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(mockClineProvider.getCurrentTask).mockReturnValue(undefined)
		;(mockClineProvider as any).cwd = "/mock/workspace"
	})

	it("routes rules management messages with the current workspace", async () => {
		const messages = [
			{ type: "requestRules" },
			{ type: "createRule", values: { scope: "project", kind: "generic", fileName: "new.md" } },
			{ type: "deleteRule", values: { scope: "project", kind: "generic", relativePath: "old.md" } },
			{ type: "openRuleFile", values: { scope: "global", kind: "generic", relativePath: "global.md" } },
			{ type: "openRulesDirectory", values: { scope: "project", kind: "mode", modeSlug: "code" } },
		] as const

		for (const message of messages) {
			await webviewMessageHandler(mockClineProvider, message as any)
		}

		expect(handleRequestRules).toHaveBeenCalledWith(mockClineProvider, "/mock/workspace")
		expect(handleCreateRule).toHaveBeenCalledWith(mockClineProvider, "/mock/workspace", messages[1])
		expect(handleDeleteRule).toHaveBeenCalledWith(mockClineProvider, "/mock/workspace", messages[2])
		expect(handleOpenRuleFile).toHaveBeenCalledWith(mockClineProvider, "/mock/workspace", messages[3])
		expect(handleOpenRulesDirectory).toHaveBeenCalledWith(mockClineProvider, "/mock/workspace", messages[4])
	})

	it("uses the active task cwd when routing rule messages", async () => {
		vi.mocked(mockClineProvider.getCurrentTask).mockReturnValue({
			cwd: "/mock/task-workspace",
		} as unknown as ReturnType<ClineProvider["getCurrentTask"]>)

		const message = { type: "requestRules" } as const
		await webviewMessageHandler(mockClineProvider, message as any)

		expect(handleRequestRules).toHaveBeenCalledWith(mockClineProvider, "/mock/task-workspace")
	})
})

describe("webviewMessageHandler - downloadErrorDiagnostics", () => {
	beforeEach(() => {
		vi.clearAllMocks()

		// Ensure contextProxy has a globalStorageUri for the handler
		;(mockClineProvider as any).contextProxy.globalStorageUri = { fsPath: "/mock/global/storage" }

		// Provide a current task with a stable ID
		vi.mocked(mockClineProvider.getCurrentTask).mockReturnValue({
			taskId: "test-task-id",
		} as any)
	})

	it("calls generateErrorDiagnostics with correct parameters", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "downloadErrorDiagnostics",
			values: {
				timestamp: "2025-01-01T00:00:00.000Z",
				version: "1.2.3",
				provider: "test-provider",
				model: "test-model",
				details: "Sample error details",
			},
		} as any)

		// Verify generateErrorDiagnostics was called with the correct parameters
		expect(generateErrorDiagnostics).toHaveBeenCalledTimes(1)
		expect(generateErrorDiagnostics).toHaveBeenCalledWith({
			taskId: "test-task-id",
			globalStoragePath: "/mock/global/storage",
			values: {
				timestamp: "2025-01-01T00:00:00.000Z",
				version: "1.2.3",
				provider: "test-provider",
				model: "test-model",
				details: "Sample error details",
			},
			log: expect.any(Function),
		})
	})

	it("shows error when no active task", async () => {
		vi.mocked(mockClineProvider.getCurrentTask).mockReturnValue(null as any)

		await webviewMessageHandler(mockClineProvider, {
			type: "downloadErrorDiagnostics",
			values: {},
		} as any)

		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("No active task to generate diagnostics for")
		expect(generateErrorDiagnostics).not.toHaveBeenCalled()
	})
})

describe("zooCodeSignOut", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("disconnects Zoo Code and clears tokens from all Zoo Gateway profiles", async () => {
		const { disconnectZooCode } = await import("../../../services/zoo-code-auth")
		const upsertProviderProfile = vi.fn().mockResolvedValue(undefined)
		const saveConfig = vi.fn().mockResolvedValue(undefined)

		;(mockClineProvider as any).contextProxy = {
			...mockClineProvider.contextProxy,
			getProviderSettings: vi.fn().mockReturnValue({ apiProvider: providerIdentifiers.zooGateway }),
			getValues: vi.fn().mockReturnValue({ currentApiConfigName: "Zoo Gateway" }),
		}
		;(mockClineProvider as any).providerSettingsManager = {
			listConfig: vi.fn().mockResolvedValue([
				{ name: "Zoo Gateway", apiProvider: providerIdentifiers.zooGateway },
				{ name: "Backup Zoo", apiProvider: providerIdentifiers.zooGateway },
			]),
			getProfile: vi
				.fn()
				.mockResolvedValueOnce({
					apiProvider: providerIdentifiers.zooGateway,
					zooSessionToken: "token-active",
					zooGatewayModelId: "anthropic/claude-sonnet-4",
				})
				.mockResolvedValueOnce({
					apiProvider: providerIdentifiers.zooGateway,
					zooSessionToken: "token-backup",
				}),
			saveConfig,
		}
		;(mockClineProvider as any).upsertProviderProfile = upsertProviderProfile

		await webviewMessageHandler(mockClineProvider, { type: "zooCodeSignOut" })

		expect(disconnectZooCode).toHaveBeenCalled()
		expect(upsertProviderProfile).toHaveBeenCalledWith(
			"Zoo Gateway",
			expect.not.objectContaining({ zooSessionToken: expect.anything() }),
			true,
		)
		expect(saveConfig).toHaveBeenCalledWith(
			"Backup Zoo",
			expect.not.objectContaining({ zooSessionToken: expect.anything() }),
		)
		expect(mockClineProvider.postStateToWebview).toHaveBeenCalled()
	})

	it("still clears the in-memory handler when the active profile token is already empty on disk", async () => {
		const upsertProviderProfile = vi.fn().mockResolvedValue(undefined)

		;(mockClineProvider as any).contextProxy = {
			...mockClineProvider.contextProxy,
			getProviderSettings: vi.fn().mockReturnValue({ apiProvider: providerIdentifiers.zooGateway }),
			getValues: vi.fn().mockReturnValue({ currentApiConfigName: "Zoo Gateway" }),
		}
		;(mockClineProvider as any).providerSettingsManager = {
			listConfig: vi
				.fn()
				.mockResolvedValue([{ name: "Zoo Gateway", apiProvider: providerIdentifiers.zooGateway }]),
			getProfile: vi.fn().mockResolvedValue({
				apiProvider: providerIdentifiers.zooGateway,
				zooGatewayModelId: "anthropic/claude-sonnet-4",
			}),
			saveConfig: vi.fn(),
		}
		;(mockClineProvider as any).upsertProviderProfile = upsertProviderProfile

		await webviewMessageHandler(mockClineProvider, { type: "zooCodeSignOut" })

		expect(upsertProviderProfile).toHaveBeenCalledWith(
			"Zoo Gateway",
			expect.not.objectContaining({ zooSessionToken: expect.anything() }),
			true,
		)
	})
})

describe("webviewMessageHandler - kimiCodeSignIn", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.resetModules()
	})

	it("starts OAuth authorization and opens browser", async () => {
		const mockStartAuthorization = vi.fn().mockResolvedValue({
			userCode: "TEST-CODE",
			verificationUri: "https://auth.kimi.com/device",
			expiresAt: Date.now() + 600000,
		})
		const mockWaitForAuthorization = vi.fn().mockResolvedValue({
			type: "kimi-code",
			accessToken: "token",
			refreshToken: "refresh",
			expiresAt: Date.now() + 3600000,
		})

		vi.doMock("../../../integrations/kimi-code/oauth", () => ({
			kimiCodeOAuthManager: {
				startAuthorization: mockStartAuthorization,
				waitForAuthorization: mockWaitForAuthorization,
			},
		}))

		const mockOpenExternal = vi.fn().mockResolvedValue(true)
		;(vscode as any).env = { openExternal: mockOpenExternal }
		;(vscode as any).Uri = { parse: vi.fn((url: string) => url) }

		await webviewMessageHandler(mockClineProvider, { type: "kimiCodeSignIn" })

		expect(mockStartAuthorization).toHaveBeenCalled()
		expect(mockOpenExternal).toHaveBeenCalled()
		expect(mockClineProvider.postStateToWebview).toHaveBeenCalled()
	})

	it("shows success message after successful authorization", async () => {
		const mockStartAuthorization = vi.fn().mockResolvedValue({
			userCode: "TEST-CODE",
			verificationUri: "https://auth.kimi.com/device",
			expiresAt: Date.now() + 600000,
		})
		const mockWaitForAuthorization = vi.fn().mockResolvedValue({
			type: "kimi-code",
			accessToken: "token",
			refreshToken: "refresh",
			expiresAt: Date.now() + 3600000,
		})

		vi.doMock("../../../integrations/kimi-code/oauth", () => ({
			kimiCodeOAuthManager: {
				startAuthorization: mockStartAuthorization,
				waitForAuthorization: mockWaitForAuthorization,
			},
		}))

		const mockOpenExternal = vi.fn().mockResolvedValue(true)
		;(vscode as any).env = { openExternal: mockOpenExternal }
		;(vscode as any).Uri = { parse: vi.fn((url: string) => url) }

		await webviewMessageHandler(mockClineProvider, { type: "kimiCodeSignIn" })
		await new Promise((resolve) => setTimeout(resolve, 10))

		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Successfully signed in to Kimi Code")
	})

	it("handles authorization failure", async () => {
		const mockStartAuthorization = vi.fn().mockResolvedValue({
			userCode: "TEST-CODE",
			verificationUri: "https://auth.kimi.com/device",
			expiresAt: Date.now() + 600000,
		})
		const mockWaitForAuthorization = vi.fn().mockRejectedValue(new Error("Authorization cancelled"))

		vi.doMock("../../../integrations/kimi-code/oauth", () => ({
			kimiCodeOAuthManager: {
				startAuthorization: mockStartAuthorization,
				waitForAuthorization: mockWaitForAuthorization,
			},
		}))

		const mockOpenExternal = vi.fn().mockResolvedValue(true)
		;(vscode as any).env = { openExternal: mockOpenExternal }
		;(vscode as any).Uri = { parse: vi.fn((url: string) => url) }

		await webviewMessageHandler(mockClineProvider, { type: "kimiCodeSignIn" })
		await new Promise((resolve) => setTimeout(resolve, 10))

		expect(mockClineProvider.postStateToWebview).toHaveBeenCalled()
	})

	it("handles startAuthorization error", async () => {
		const mockStartAuthorization = vi.fn().mockRejectedValue(new Error("Network error"))

		vi.doMock("../../../integrations/kimi-code/oauth", () => ({
			kimiCodeOAuthManager: {
				startAuthorization: mockStartAuthorization,
			},
		}))

		await webviewMessageHandler(mockClineProvider, { type: "kimiCodeSignIn" })

		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Kimi Code sign in failed"))
		expect(mockClineProvider.postStateToWebview).toHaveBeenCalled()
	})
})

describe("webviewMessageHandler - kimiCodeSignOut", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.resetModules()
	})

	it("clears credentials and shows success message", async () => {
		const mockClearCredentials = vi.fn().mockResolvedValue(undefined)

		vi.doMock("../../../integrations/kimi-code/oauth", () => ({
			kimiCodeOAuthManager: {
				clearCredentials: mockClearCredentials,
			},
		}))

		await webviewMessageHandler(mockClineProvider, { type: "kimiCodeSignOut" })

		expect(mockClearCredentials).toHaveBeenCalled()
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Signed out from Kimi Code")
		expect(mockClineProvider.postStateToWebview).toHaveBeenCalled()
	})

	it("handles sign out error", async () => {
		const mockClearCredentials = vi.fn().mockRejectedValue(new Error("Clear failed"))

		vi.doMock("../../../integrations/kimi-code/oauth", () => ({
			kimiCodeOAuthManager: {
				clearCredentials: mockClearCredentials,
			},
		}))

		await webviewMessageHandler(mockClineProvider, { type: "kimiCodeSignOut" })

		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Kimi Code sign out failed.")
	})
})

describe("webviewMessageHandler - telemetrySetting", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(vscode.env).isTelemetryEnabled = true
	})

	// Regression test: TelemetryService.updateTelemetryState must be gated on
	// vscode.env.isTelemetryEnabled in addition to the stored setting, matching
	// extension.ts's onDidChangeTelemetryEnabled listener. Without this AND, a user
	// clicking Accept in the webview could re-enable telemetry even while VS Code's
	// global telemetry toggle is off.
	it("does not enable telemetry when the user accepts but VS Code's global telemetry toggle is off", async () => {
		const { TelemetryService } = await import("@roo-code/telemetry")
		vi.mocked(TelemetryService.hasInstance).mockReturnValue(true)
		vi.mocked(vscode.env).isTelemetryEnabled = false
		vi.mocked(mockClineProvider.contextProxy.getValue).mockReturnValue(undefined)

		await webviewMessageHandler(mockClineProvider, { type: "telemetrySetting", text: "enabled" })

		expect(TelemetryService.instance.updateTelemetryState).toHaveBeenCalledWith(false)
	})

	it("enables telemetry when the user accepts and VS Code's global telemetry toggle is on", async () => {
		const { TelemetryService } = await import("@roo-code/telemetry")
		vi.mocked(TelemetryService.hasInstance).mockReturnValue(true)
		vi.mocked(vscode.env).isTelemetryEnabled = true
		vi.mocked(mockClineProvider.contextProxy.getValue).mockReturnValue(undefined)

		await webviewMessageHandler(mockClineProvider, { type: "telemetrySetting", text: "enabled" })

		expect(TelemetryService.instance.updateTelemetryState).toHaveBeenCalledWith(true)
	})

	it("keeps telemetry disabled when the user declines, regardless of VS Code's global toggle", async () => {
		const { TelemetryService } = await import("@roo-code/telemetry")
		vi.mocked(TelemetryService.hasInstance).mockReturnValue(true)
		vi.mocked(vscode.env).isTelemetryEnabled = true
		vi.mocked(mockClineProvider.contextProxy.getValue).mockReturnValue(undefined)

		await webviewMessageHandler(mockClineProvider, { type: "telemetrySetting", text: "disabled" })

		expect(TelemetryService.instance.updateTelemetryState).toHaveBeenCalledWith(false)
	})

	// Finding #12 regression: without serialization, two concurrent "telemetrySetting" messages
	// each capture their own isOptedIn in a closure and apply it to TelemetryService whenever
	// their own persistence write resolves -- with no ordering guarantee between the two
	// invocations. A slow first write racing a fast second write could let the *first*
	// message's (now-stale) intent win the live telemetry state, even though the *second*
	// message reflects the user's actual final choice.
	it("applies the most recently sent telemetrySetting last, even if an earlier message's write is slower", async () => {
		const { TelemetryService } = await import("@roo-code/telemetry")
		vi.mocked(TelemetryService.hasInstance).mockReturnValue(true)
		vi.mocked(vscode.env).isTelemetryEnabled = true

		// Track the "stored" setting so the second call's getGlobalState read reflects
		// whatever the first call has (or hasn't yet) written -- mirrors ContextProxy's real
		// synchronous stateCache update inside setValue.
		let storedSetting: string | undefined
		vi.mocked(mockClineProvider.contextProxy.getValue).mockImplementation(() => storedSetting)

		let resolveSlowWrite!: () => void
		const slowWrite = new Promise<void>((resolve) => {
			resolveSlowWrite = resolve
		})

		vi.mocked(mockClineProvider.contextProxy.setValue).mockImplementation(async (_key, value) => {
			if (value === "disabled") {
				// First message's write is slow -- resolves only after we explicitly release it
				// below, once the second (fast) message has already been sent.
				await slowWrite
			}
			storedSetting = value as string
		})

		// First message: turn telemetry off (slow write).
		const first = webviewMessageHandler(mockClineProvider, { type: "telemetrySetting", text: "disabled" })

		// Second message: turn telemetry back on (fast write), sent immediately after.
		const second = webviewMessageHandler(mockClineProvider, { type: "telemetrySetting", text: "enabled" })

		// Now let the first message's write proceed.
		resolveSlowWrite()

		await Promise.all([first, second])

		// The user's final, most-recently-sent choice was "enabled" -- the live telemetry
		// state must reflect that, not "disabled" from the stale, slower first message.
		const calls = vi.mocked(TelemetryService.instance.updateTelemetryState).mock.calls
		expect(calls.at(-1)).toEqual([true])
	})

	// CodeRabbit follow-up on the finding #12 fix: webviewDidLaunch's telemetry init read state
	// via an async provider.getStateToPostToWebview().then(...) continuation, outside
	// telemetrySettingQueue -- so it could resolve after a concurrent "telemetrySetting" message
	// and clobber that message's queued (correct) update with a stale value. webviewDidLaunch now
	// reads getGlobalState synchronously and is routed through the same queue.
	it("does not let webviewDidLaunch's telemetry init race and clobber a concurrent telemetrySetting message", async () => {
		const { TelemetryService } = await import("@roo-code/telemetry")
		vi.mocked(TelemetryService.hasInstance).mockReturnValue(true)
		vi.mocked(vscode.env).isTelemetryEnabled = true

		// webviewDidLaunch starts out "unset" (disclosed opt-out default -- opted in). Scoped to
		// the "telemetrySetting" key specifically -- webviewDidLaunch also calls
		// updateGlobalState("customModes", ...) through the same contextProxy mock, which must
		// not clobber storedSetting.
		let storedSetting: string | undefined = "unset"
		vi.mocked(mockClineProvider.contextProxy.getValue).mockImplementation((key: string) =>
			key === "telemetrySetting" ? storedSetting : undefined,
		)
		vi.mocked(mockClineProvider.contextProxy.setValue).mockImplementation(async (key: string, value) => {
			if (key === "telemetrySetting") {
				storedSetting = value as string
			}
		})

		vi.mocked(mockClineProvider.customModesManager.getCustomModes).mockResolvedValue([])
		const providerForLaunch = mockClineProvider as unknown as {
			getMcpHub: ReturnType<typeof vi.fn>
			providerSettingsManager: { listConfig: ReturnType<typeof vi.fn> }
			getStateToPostToWebview: ReturnType<typeof vi.fn>
		}
		providerForLaunch.getMcpHub = vi.fn().mockReturnValue(undefined)
		providerForLaunch.providerSettingsManager = {
			listConfig: vi.fn().mockResolvedValue(undefined),
		}

		// Deferred-promise handshake instead of setTimeout delays, so ordering is enforced
		// explicitly rather than by racing real clock delays. Signals when webviewDidLaunch has
		// taken its (pre-fix) state snapshot -- only fires under the *old* code path
		// (provider.getStateToPostToWebview().then(...)); the fix never calls it at all.
		let snapshotTaken!: () => void
		const snapshotTakenPromise = new Promise<void>((resolve) => {
			snapshotTaken = resolve
		})
		let releaseSnapshot!: () => void
		const snapshotReleased = new Promise<void>((resolve) => {
			releaseSnapshot = resolve
		})

		// Snapshots storedSetting at call time (mirroring the real ClineProvider building its
		// state object synchronously before any internal awaits), signals it was taken, then
		// waits until the test explicitly releases it -- by which point the concurrent
		// telemetrySetting write below has already landed, making the snapshot genuinely stale
		// once its .then() callback finally runs.
		providerForLaunch.getStateToPostToWebview = vi.fn().mockImplementation(async () => {
			const snapshot = storedSetting
			snapshotTaken()
			await snapshotReleased
			return { telemetrySetting: snapshot }
		})

		// webviewDidLaunch fires first (e.g. webview reload) -- its telemetry init is now queued
		// behind telemetrySettingQueue rather than resolving independently.
		const launch = webviewMessageHandler(mockClineProvider, { type: "webviewDidLaunch" })

		// Wait for webviewDidLaunch to either take its (pre-fix) snapshot, or flush a fixed
		// number of microtask turns as a same-tick fallback for the fixed code path (which never
		// triggers that signal) -- enough for its synchronous prefix (await getCustomModes(),
		// await updateGlobalState()) to run, without relying on a wall-clock timer.
		await Promise.race([
			snapshotTakenPromise,
			(async () => {
				for (let i = 0; i < 10; i++) {
					await Promise.resolve()
				}
			})(),
		])

		// A concurrent "telemetrySetting" message turns telemetry off, and is awaited to
		// completion -- including its own updateTelemetryState(false) call -- *before* the
		// deferred (pre-fix-only) snapshot below is released. Against the pre-fix code, this
		// proves the snapshot it captured earlier ("unset") is genuinely stale by the time its
		// .then() callback finally runs: the user's real, later choice already landed.
		const disable = webviewMessageHandler(mockClineProvider, { type: "telemetrySetting", text: "disabled" })
		await disable

		// Now release the deferred snapshot so a getStateToPostToWebview() call, if the old code
		// path is exercised, resolves (with its already-captured, now-stale value) only after
		// the disable write above has fully landed.
		const snapshotResolved = vi.mocked(providerForLaunch.getStateToPostToWebview).mock.results[0]?.value as
			| Promise<unknown>
			| undefined
		releaseSnapshot()

		await Promise.all([launch, snapshotResolved])

		// webviewDidLaunch's telemetry init is fire-and-forget from the handler's own point of
		// view (the "webviewDidLaunch" case doesn't await it), so even awaiting
		// getStateToPostToWebview() directly isn't enough to observe its .then() callback --
		// flush one more microtask turn for that callback to run.
		await Promise.resolve()

		// The user's explicit "disabled" choice must be the final state -- webviewDidLaunch's
		// queued re-application of the (by-then-stale) "unset"/opted-in state must not run after
		// and override it.
		const calls = vi.mocked(TelemetryService.instance.updateTelemetryState).mock.calls
		expect(calls.at(-1)).toEqual([false])
	})

	// Review finding: webviewDidLaunch's queued telemetry update wasn't awaited by the
	// "webviewDidLaunch" case, so a thrown error inside it was only ever caught by a later,
	// unrelated queue link's leading .catch(() => undefined) -- silently swallowed rather than
	// logged. Now awaited with its own .catch that logs via provider.log.
	it("logs an error via provider.log if the queued telemetry init throws on launch", async () => {
		const { TelemetryService } = await import("@roo-code/telemetry")
		vi.mocked(TelemetryService.hasInstance).mockReturnValue(true)

		vi.mocked(mockClineProvider.contextProxy.getValue).mockImplementation((key: string) => {
			if (key === "telemetrySetting") {
				throw new Error("contextProxy read failed")
			}
			return undefined
		})
		vi.mocked(mockClineProvider.customModesManager.getCustomModes).mockResolvedValue([])
		const providerForLaunch = mockClineProvider as unknown as {
			getMcpHub: ReturnType<typeof vi.fn>
			providerSettingsManager: { listConfig: ReturnType<typeof vi.fn> }
			getStateToPostToWebview: ReturnType<typeof vi.fn>
		}
		providerForLaunch.getMcpHub = vi.fn().mockReturnValue(undefined)
		providerForLaunch.providerSettingsManager = { listConfig: vi.fn().mockResolvedValue(undefined) }
		providerForLaunch.getStateToPostToWebview = vi.fn().mockResolvedValue({ telemetrySetting: "unset" })

		await webviewMessageHandler(mockClineProvider, { type: "webviewDidLaunch" })

		expect(mockClineProvider.log).toHaveBeenCalledWith(
			expect.stringContaining("Error initializing telemetry state on launch"),
		)
	})

	// CodeRabbit finding: webviewDidLaunch's queued telemetry update called
	// TelemetryService.instance directly, unlike the "telemetrySetting" case a few lines
	// below which checks hasInstance() first. If webviewDidLaunch fires before the service
	// is created (e.g. during activation), TelemetryService.instance throws -- and since
	// this whole chain isn't awaited by the "webviewDidLaunch" case, that throw becomes an
	// unhandled promise rejection instead of a no-op.
	it("does not throw or update telemetry state when webviewDidLaunch fires before TelemetryService exists", async () => {
		const { TelemetryService } = await import("@roo-code/telemetry")
		vi.mocked(TelemetryService.hasInstance).mockReturnValue(false)

		vi.mocked(mockClineProvider.contextProxy.getValue).mockReturnValue("unset")
		vi.mocked(mockClineProvider.customModesManager.getCustomModes).mockResolvedValue([])
		const providerForLaunch = mockClineProvider as unknown as {
			getMcpHub: ReturnType<typeof vi.fn>
			providerSettingsManager: { listConfig: ReturnType<typeof vi.fn> }
			getStateToPostToWebview: ReturnType<typeof vi.fn>
		}
		providerForLaunch.getMcpHub = vi.fn().mockReturnValue(undefined)
		providerForLaunch.providerSettingsManager = { listConfig: vi.fn().mockResolvedValue(undefined) }
		providerForLaunch.getStateToPostToWebview = vi.fn().mockResolvedValue({ telemetrySetting: "unset" })

		await expect(webviewMessageHandler(mockClineProvider, { type: "webviewDidLaunch" })).resolves.not.toThrow()

		// The queued telemetry update is fire-and-forget from the handler's own point of
		// view -- flush a microtask turn so its .then() callback runs before asserting.
		await Promise.resolve()

		expect(TelemetryService.instance.updateTelemetryState).not.toHaveBeenCalled()
	})
})

describe("bulk settings save results", () => {
	beforeEach(() => vi.clearAllMocks())

	it("escapes untrusted setting names and error names in persistence failure logs", async () => {
		const key = "unknown\r\nForged entry\t\u001b[31m"
		// Runtime webview messages can contain keys absent from the TypeScript type.
		const updatedSettings = { chatInputEffect: "breathing" as const, [key]: true }
		const error = new Error("secret value")
		error.name = "Error\nForged error"
		vi.mocked(mockClineProvider.contextProxy.setValue).mockRejectedValueOnce(error)

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			requestId: "untrusted-settings",
			updatedSettings,
		})

		expect(mockClineProvider.log).toHaveBeenCalledExactlyOnceWith(
			`Failed to save settings: ${JSON.stringify(["chatInputEffect", key])}; error: ${JSON.stringify(error.name)}`,
		)
		expect(vi.mocked(mockClineProvider.log).mock.calls[0][0]).not.toContain("\n")
		expect(vi.mocked(mockClineProvider.log).mock.calls[0][0]).not.toContain("secret value")
	})

	it("persists a changed retry after a save stalled past the webview timeout", async () => {
		vi.useFakeTimers()
		const context = makeExtensionContext()
		const persisted = new Map<string, unknown>()
		let releaseWrite!: () => void
		let writeStarted!: () => void
		const delayedWrite = new Promise<void>((resolve) => {
			releaseWrite = resolve
		})
		const started = new Promise<void>((resolve) => {
			writeStarted = resolve
		})
		const update = vi.mocked(context.globalState.update).mockImplementation(async (key, value) => {
			if (key === "chatInputEffect" && value === "breathing") {
				writeStarted()
				await delayedWrite
			}
			persisted.set(key, value)
		})
		const contextProxy = new ContextProxy(context)
		const provider = { ...mockClineProvider, contextProxy } as ClineProvider
		const first = webviewMessageHandler(provider, {
			type: "updateSettings",
			requestId: "timed-out-save",
			updatedSettings: { chatInputEffect: "breathing", tableStriped: true },
		})
		let retry: Promise<void> | undefined
		try {
			await started
			// SettingsView releases its UI lock after 30 seconds without cancelling the host write.
			await vi.advanceTimersByTimeAsync(30_001)
			retry = webviewMessageHandler(provider, {
				type: "updateSettings",
				requestId: "retry",
				updatedSettings: { chatInputEffect: "marquee", tableStriped: false },
			})
			await vi.advanceTimersByTimeAsync(0)
			expect(update).toHaveBeenCalledExactlyOnceWith("chatInputEffect", "breathing")
			expect(provider.postMessageToWebview).not.toHaveBeenCalled()
		} finally {
			releaseWrite()
			await Promise.all([first, retry])
			vi.useRealTimers()
		}
		expect(contextProxy.getValue("chatInputEffect")).toBe("marquee")
		expect(contextProxy.getValue("tableStriped")).toBe(false)
		expect(persisted.get("chatInputEffect")).toBe("marquee")
		expect(persisted.get("tableStriped")).toBe(false)
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "settingsSaveResult",
			requestId: "retry",
			success: true,
			unsavedSettings: [],
		})
	})

	it("acknowledges unset experiments and customSupportPrompts without persisting them", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			requestId: "skipped-settings",
			updatedSettings: { experiments: undefined, customSupportPrompts: undefined },
		})

		expect(mockClineProvider.contextProxy.setValue).not.toHaveBeenCalled()
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "settingsSaveResult",
			requestId: "skipped-settings",
			success: true,
			unsavedSettings: [],
		})
	})

	it("excludes skipped experiments and customSupportPrompts when a later write fails", async () => {
		const setValue = vi.mocked(mockClineProvider.contextProxy.setValue)
		setValue.mockRejectedValueOnce(new Error("storage unavailable"))

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			requestId: "skipped-settings-with-failure",
			updatedSettings: { experiments: undefined, customSupportPrompts: undefined, tableStriped: true },
		})

		expect(setValue).toHaveBeenCalledExactlyOnceWith("tableStriped", true)
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "settingsSaveResult",
			requestId: "skipped-settings-with-failure",
			success: false,
			unsavedSettings: ["tableStriped"],
		})
	})

	it("shows the unsaved keys when a write fails without a request ID", async () => {
		const setValue = vi.mocked(mockClineProvider.contextProxy.setValue)
		setValue.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("storage unavailable"))
		const errorMessage = "Could not save settings: chatInputEffect, tableStriped"
		vi.mocked(t).mockReturnValueOnce(errorMessage)

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { soundEnabled: true, chatInputEffect: "breathing", tableStriped: true },
		})

		expect(setValue).toHaveBeenCalledTimes(2)
		expect(mockClineProvider.log).toHaveBeenCalledExactlyOnceWith(
			'Failed to save settings: ["chatInputEffect","tableStriped"]; error: "Error"',
		)
		expect(t).toHaveBeenCalledWith("common:errors.settingsSaveFailed", {
			keys: "chatInputEffect, tableStriped",
		})
		expect(vscode.window.showErrorMessage).toHaveBeenCalledExactlyOnceWith(errorMessage)
		expect(mockClineProvider.postMessageToWebview).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "settingsSaveResult" }),
		)
	})

	it("reports the failed and unattempted keys, then permits a successful retry", async () => {
		const setValue = vi.mocked(mockClineProvider.contextProxy.setValue)
		setValue.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("storage unavailable"))
		const updatedSettings = { soundEnabled: true, chatInputEffect: "breathing" as const, tableStriped: true }
		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			requestId: "failed-save",
			updatedSettings,
		})
		expect(setValue).toHaveBeenCalledTimes(2)
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "settingsSaveResult",
			requestId: "failed-save",
			success: false,
			unsavedSettings: ["chatInputEffect", "tableStriped"],
		})
		setValue.mockResolvedValue(undefined)
		await webviewMessageHandler(mockClineProvider, { type: "updateSettings", requestId: "retry", updatedSettings })
		expect(setValue).toHaveBeenLastCalledWith("tableStriped", true)
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "settingsSaveResult",
			requestId: "retry",
			success: true,
			unsavedSettings: [],
		})
	})

	it("reports all keys when the first write fails", async () => {
		vi.mocked(mockClineProvider.contextProxy.setValue).mockRejectedValueOnce(new Error("disk full"))
		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			requestId: "first-failure",
			updatedSettings: { chatInputEffect: "breathing", tableStriped: true },
		})
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "settingsSaveResult",
			requestId: "first-failure",
			success: false,
			unsavedSettings: ["chatInputEffect", "tableStriped"],
		})
	})
})

describe("individual settings save acknowledgments", () => {
	beforeEach(() => vi.clearAllMocks())

	it.each(["upsertApiConfiguration", "telemetrySetting", "debugSetting"] as const)(
		"acknowledges %s only after persistence completes, and reports failures",
		async (type) => {
			const write = vi.fn<() => Promise<string | undefined>>()
			if (type === "upsertApiConfiguration") {
				vi.mocked(mockClineProvider.upsertProviderProfile).mockImplementation(write)
			} else if (type === "telemetrySetting") {
				vi.mocked(mockClineProvider.contextProxy.setValue).mockImplementation(async () => {
					await write()
				})
			} else {
				vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ update: write } as never)
			}
			let resolveWrite!: (value: string) => void
			write.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveWrite = resolve
				}),
			)
			const message = { type, requestId: "save", text: "enabled", bool: true, apiConfiguration: {} }
			const saving = webviewMessageHandler(mockClineProvider, message)
			await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
			expect(mockClineProvider.postMessageToWebview).not.toHaveBeenCalled()
			resolveWrite("profile-id")
			await saving
			expect(mockClineProvider.postMessageToWebview).toHaveBeenLastCalledWith({
				type: "settingsSaveResult",
				requestId: "save",
				success: true,
				unsavedSettings: [],
			})
			write.mockRejectedValueOnce(new TypeError("secret error text"))
			await webviewMessageHandler(mockClineProvider, message)
			const key =
				type === "upsertApiConfiguration" ? "apiConfiguration" : type === "debugSetting" ? "debug" : type
			expect(mockClineProvider.postMessageToWebview).toHaveBeenLastCalledWith({
				type: "settingsSaveResult",
				requestId: "save",
				success: false,
				unsavedSettings: [key],
			})
			expect(mockClineProvider.log).toHaveBeenLastCalledWith(
				`Failed to save settings: ${JSON.stringify([key])}; error: "TypeError"`,
			)
			write.mockResolvedValue("profile-id")
			await webviewMessageHandler(mockClineProvider, message)
			expect(mockClineProvider.postMessageToWebview).toHaveBeenLastCalledWith({
				type: "settingsSaveResult",
				requestId: "save",
				success: true,
				unsavedSettings: [],
			})
		},
	)

	it("reports profile persistence failures returned as undefined", async () => {
		vi.mocked(mockClineProvider.upsertProviderProfile).mockResolvedValueOnce(undefined)
		await webviewMessageHandler(mockClineProvider, {
			type: "upsertApiConfiguration",
			requestId: "save",
			text: "default",
			apiConfiguration: {},
		})
		expect(mockClineProvider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "settingsSaveResult",
			requestId: "save",
			success: false,
			unsavedSettings: ["apiConfiguration"],
		})
	})

	it("rejects an upsertApiConfiguration save that arrives without a profile payload", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "upsertApiConfiguration",
			requestId: "save",
		})
		// The handler must fail fast instead of silently succeeding when the webview forgot the payload.
		expect(mockClineProvider.upsertProviderProfile).not.toHaveBeenCalled()
		expect(mockClineProvider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "settingsSaveResult",
			requestId: "save",
			success: false,
			unsavedSettings: ["apiConfiguration"],
		})
	})

	it("ignores an upsertApiConfiguration message without a payload when no requestId is supplied", async () => {
		// Legacy callers omit the profile payload and the requestId; the handler must stay a no-op.
		await webviewMessageHandler(mockClineProvider, { type: "upsertApiConfiguration" })
		expect(mockClineProvider.upsertProviderProfile).not.toHaveBeenCalled()
		expect(mockClineProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("defaults the debug setting to false when the value is omitted", async () => {
		const update = vi.fn().mockResolvedValue(undefined)
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ update } as never)
		await webviewMessageHandler(mockClineProvider, { type: "debugSetting" })
		expect(update).toHaveBeenCalledWith("debug", false, 1)
		expect(mockClineProvider.postStateToWebview).toHaveBeenCalled()
	})
})

describe("webviewMessageHandler - updateSettings branch handling", () => {
	let updateConfig: ReturnType<typeof vi.fn>
	let setValue: ReturnType<typeof vi.fn>

	beforeEach(() => {
		vi.clearAllMocks()
		updateConfig = vi.fn().mockResolvedValue(undefined)
		setValue = vi.mocked(mockClineProvider.contextProxy.setValue)
		setValue.mockResolvedValue(undefined as never)
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: vi.fn(), update: updateConfig } as never)
		;(mockClineProvider as unknown as { getMcpHub: ReturnType<typeof vi.fn> }).getMcpHub = vi
			.fn()
			.mockReturnValue(undefined)
		Terminal.setTerminalProfile(undefined)
	})

	afterEach(() => {
		Terminal.setTerminalProfile(undefined)
	})

	it("applies command and file allow/deny lists, dropping blank entries", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			requestId: "lists",
			updatedSettings: {
				allowedCommands: ["a", "", "  ", "b"],
				deniedCommands: ["x", ""],
				allowedReadFiles: ["src/**", "  "],
				allowedWriteFiles: [],
			},
		})

		expect(updateConfig).toHaveBeenCalledWith("allowedCommands", ["a", "b"], 1)
		expect(updateConfig).toHaveBeenCalledWith("deniedCommands", ["x"], 1)
		expect(setValue).toHaveBeenCalledWith("allowedReadFiles", ["src/**"])
		expect(setValue).toHaveBeenCalledWith("allowedWriteFiles", [])
		expect(mockClineProvider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "settingsSaveResult",
			requestId: "lists",
			success: true,
			unsavedSettings: [],
		})
	})

	it("applies the language, TTS and generic default branches", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			requestId: "misc",
			updatedSettings: {
				language: "fr",
				ttsEnabled: false,
				ttsSpeed: 2.5,
				soundEnabled: true,
			},
		})

		expect(vi.mocked(changeLanguage)).toHaveBeenCalledWith("fr")
		expect(setValue).toHaveBeenCalledWith("language", "fr")
		expect(setValue).toHaveBeenCalledWith("ttsEnabled", false)
		expect(setValue).toHaveBeenCalledWith("ttsSpeed", 2.5)
		expect(setValue).toHaveBeenCalledWith("soundEnabled", true)
	})

	it("applies every terminal setting branch, including the profile reset that closes idle terminals", async () => {
		const closeIdleTerminalsSpy = vi.spyOn(TerminalRegistry, "closeIdleTerminals").mockImplementation(() => {})
		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			requestId: "terminal",
			updatedSettings: {
				terminalShellIntegrationTimeout: 30,
				terminalShellIntegrationDisabled: true,
				terminalCommandDelay: 75,
				terminalPowershellCounter: true,
				terminalZshClearEolMark: true,
				terminalZshOhMy: true,
				terminalZshP10k: true,
				terminalZdotdir: true,
				terminalProfile: "Git Bash",
				execaShellPath: "/bin/bash",
			},
		})

		expect(Terminal.getShellIntegrationTimeout()).toBe(30)
		expect(Terminal.getCommandDelay()).toBe(75)
		expect(Terminal.getTerminalProfile()).toBe("Git Bash")
		expect(closeIdleTerminalsSpy).toHaveBeenCalled()
		expect(setValue).toHaveBeenCalledWith("terminalProfile", "Git Bash")
		expect(setValue).toHaveBeenCalledWith("execaShellPath", "/bin/bash")
	})

	it("notifies the MCP hub when mcpEnabled changes", async () => {
		const handleMcpEnabledChange = vi.fn().mockResolvedValue(undefined)
		;(mockClineProvider as unknown as { getMcpHub: ReturnType<typeof vi.fn> }).getMcpHub = vi
			.fn()
			.mockReturnValue({ handleMcpEnabledChange })

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			requestId: "mcp",
			updatedSettings: { mcpEnabled: false },
		})

		expect(handleMcpEnabledChange).toHaveBeenCalledWith(false)
		expect(setValue).toHaveBeenCalledWith("mcpEnabled", false)
	})

	it("acknowledges unset experiments and customSupportPrompts without persisting them", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			requestId: "unset",
			updatedSettings: { experiments: undefined, customSupportPrompts: undefined },
		})

		expect(setValue).not.toHaveBeenCalledWith("experiments", expect.anything())
		expect(mockClineProvider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "settingsSaveResult",
			requestId: "unset",
			success: true,
			unsavedSettings: [],
		})
	})

	it("reports a failed bulk save with requestId and permits a later retry", async () => {
		setValue.mockRejectedValueOnce(new Error("storage unavailable")).mockResolvedValue(undefined as never)

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			requestId: "bulk-fail",
			updatedSettings: { soundEnabled: true, chatInputEffect: "breathing" },
		})

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "settingsSaveResult",
			requestId: "bulk-fail",
			success: false,
			unsavedSettings: ["soundEnabled", "chatInputEffect"],
		})
		expect(vi.mocked(vscode.window.showErrorMessage)).not.toHaveBeenCalled()
	})

	it("surfaces a legacy bulk save failure without a requestId via showErrorMessage", async () => {
		setValue.mockRejectedValueOnce(new Error("disk full"))

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { soundEnabled: true, chatInputEffect: "breathing" },
		})

		expect(vi.mocked(vscode.window.showErrorMessage)).toHaveBeenCalledWith("common:errors.settingsSaveFailed")
		expect(mockClineProvider.postMessageToWebview).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "settingsSaveResult" }),
		)
	})

	it("defaults a null language to en and applies the tts fallbacks", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			requestId: "defaults",
			updatedSettings: { language: undefined, ttsEnabled: undefined, ttsSpeed: undefined },
		})

		expect(vi.mocked(changeLanguage)).toHaveBeenCalledWith("en")
		expect(setValue).toHaveBeenCalledWith("language", "en")
		expect(setValue).toHaveBeenCalledWith("ttsEnabled", true)
		expect(setValue).toHaveBeenCalledWith("ttsSpeed", 1.0)
	})

	it("drops a non-array command list and a non-array file pattern list", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			requestId: "non-array",
			updatedSettings: {
				allowedCommands: "rm -rf /" as unknown as string[],
				deniedCommands: "rm -rf /" as unknown as string[],
				allowedReadFiles: "src/**" as unknown as string[],
				allowedWriteFiles: "src/**" as unknown as string[],
			},
		})

		expect(updateConfig).toHaveBeenCalledWith("allowedCommands", [], 1)
		expect(updateConfig).toHaveBeenCalledWith("deniedCommands", [], 1)
		expect(setValue).toHaveBeenCalledWith("allowedReadFiles", [])
		expect(setValue).toHaveBeenCalledWith("allowedWriteFiles", [])
	})

	it("tolerates a missing command or file list by treating it as empty", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			requestId: "missing-lists",
			updatedSettings: {
				allowedCommands: undefined,
				deniedCommands: undefined,
				allowedReadFiles: undefined,
				allowedWriteFiles: undefined,
			},
		})

		expect(updateConfig).toHaveBeenCalledWith("allowedCommands", [], 1)
		expect(updateConfig).toHaveBeenCalledWith("deniedCommands", [], 1)
		expect(setValue).toHaveBeenCalledWith("allowedReadFiles", [])
		expect(setValue).toHaveBeenCalledWith("allowedWriteFiles", [])
	})

	it("leaves terminal settings untouched when their values are undefined", async () => {
		const closeIdleTerminalsSpy = vi.spyOn(TerminalRegistry, "closeIdleTerminals").mockImplementation(() => {})
		Terminal.setTerminalProfile(undefined)

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			requestId: "terminal-undefined",
			updatedSettings: {
				terminalShellIntegrationTimeout: undefined,
				terminalShellIntegrationDisabled: undefined,
				terminalCommandDelay: undefined,
				terminalPowershellCounter: undefined,
				terminalZshClearEolMark: undefined,
				terminalZshOhMy: undefined,
				terminalZshP10k: undefined,
				terminalZdotdir: undefined,
			},
		})

		// Every terminal branch guards on `value !== undefined`, so the profile-change
		// side effect must not fire and the values are stored as-is.
		expect(closeIdleTerminalsSpy).not.toHaveBeenCalled()
		expect(setValue).toHaveBeenCalledWith("terminalShellIntegrationTimeout", undefined)
	})

	it("treats a non-string terminalProfile as unset and does not close terminal state", async () => {
		const closeIdleTerminalsSpy = vi.spyOn(TerminalRegistry, "closeIdleTerminals").mockImplementation(() => {})
		Terminal.setTerminalProfile(undefined)

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			requestId: "terminal-nonstring",
			updatedSettings: { terminalProfile: 123 as unknown as string },
		})

		expect(Terminal.getTerminalProfile()).toBeUndefined()
		expect(closeIdleTerminalsSpy).not.toHaveBeenCalled()
	})

	it("does not touch the MCP hub when none is available", async () => {
		;(mockClineProvider as unknown as { getMcpHub: ReturnType<typeof vi.fn> }).getMcpHub = vi
			.fn()
			.mockReturnValue(undefined)

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			requestId: "mcp-missing",
			updatedSettings: { mcpEnabled: true },
		})

		expect(setValue).toHaveBeenCalledWith("mcpEnabled", true)
	})

	it("defaults mcpEnabled to true when the value is unset", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			requestId: "mcp-default",
			updatedSettings: { mcpEnabled: undefined },
		})

		expect(setValue).toHaveBeenCalledWith("mcpEnabled", true)
	})

	it("merges a truthy experiments payload over the stored values or the defaults", async () => {
		vi.mocked(mockClineProvider.contextProxy.getValue).mockImplementation((key: string) =>
			key === "experiments" ? { customTools: true } : undefined,
		)
		setValue.mockClear()

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			requestId: "experiments-on",
			updatedSettings: { experiments: { runSlashCommand: true } },
		})
		expect(setValue).toHaveBeenCalledWith(
			"experiments",
			expect.objectContaining({ customTools: true, runSlashCommand: true }),
		)

		// With no stored value the default experiment set is used as the base.
		vi.mocked(mockClineProvider.contextProxy.getValue).mockReturnValue(undefined)
		setValue.mockClear()
		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			requestId: "experiments-default",
			updatedSettings: { experiments: { parallelToolExecution: true } },
		})
		expect(setValue).toHaveBeenCalledWith("experiments", expect.objectContaining({ parallelToolExecution: true }))
	})

	it("persists a truthy customSupportPrompts payload as-is", async () => {
		setValue.mockClear()

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			requestId: "prompts-on",
			updatedSettings: { customSupportPrompts: { review: "Review this" } },
		})

		expect(setValue).toHaveBeenCalledWith("customSupportPrompts", { review: "Review this" })
	})

	it("logs Unknown when a bulk save fails with a non-Error value", async () => {
		setValue.mockRejectedValueOnce("boom")

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			requestId: "bulk-nonerror",
			updatedSettings: { soundEnabled: true, chatInputEffect: "breathing" },
		})

		expect(mockClineProvider.log).toHaveBeenCalledWith(expect.stringContaining('"Unknown"'))
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "settingsSaveResult",
			requestId: "bulk-nonerror",
			success: false,
			unsavedSettings: ["soundEnabled", "chatInputEffect"],
		})
	})

	it("logs Unknown when an individual save throws a non-Error value", async () => {
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: vi.fn(),
			update: vi.fn().mockRejectedValue("no-permission"),
		} as never)

		await webviewMessageHandler(mockClineProvider, {
			type: "debugSetting",
			requestId: "debug-nonerror",
			bool: true,
		})

		expect(mockClineProvider.log).toHaveBeenCalledWith(expect.stringContaining('"Unknown"'))
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "settingsSaveResult",
			requestId: "debug-nonerror",
			success: false,
			unsavedSettings: ["debug"],
		})
	})
})

describe("webviewMessageHandler - serialized settings saves", () => {
	it.each(["updateSettings", "upsertApiConfiguration", "telemetrySetting", "debugSetting"] as const)(
		"cancels queued %s without waiting for blocked storage",
		async (type) => {
			const controller = new AbortController()
			const provider = mockClineProvider
			const signalGetter = vi.spyOn(provider, "settingsSaveSignal", "get").mockReturnValue(controller.signal)
			try {
				let release!: () => void
				const write = vi.mocked(provider.contextProxy.setValue).mockImplementationOnce(
					() =>
						new Promise<void>((resolve) => {
							release = resolve
						}),
				)
				const active = webviewMessageHandler(provider, {
					type: "updateSettings",
					updatedSettings: { soundVolume: 0.2 },
				})
				const pending = webviewMessageHandler(provider, {
					type,
					requestId: "cancelled",
					updatedSettings: { soundVolume: 0.9 },
				})
				const cancellations = Promise.all([
					expect(active).rejects.toMatchObject({ name: "AbortError" }),
					expect(pending).rejects.toMatchObject({ name: "AbortError" }),
				])
				controller.abort()
				await cancellations
				release()
				await enqueueSettingsSave(provider.contextProxy, new AbortController().signal, async () => {})
				expect(write).not.toHaveBeenCalledWith("soundVolume", 0.9)
				expect(provider.postMessageToWebview).not.toHaveBeenCalledWith(
					expect.objectContaining({ requestId: "cancelled" }),
				)
			} finally {
				signalGetter.mockRestore()
			}
		},
	)

	it("keeps processing later saves after an earlier save throws", async () => {
		;(mockClineProvider as unknown as { getMcpHub: () => undefined }).getMcpHub = () => undefined
		// debugSetting without a requestId rethrows its write failure, which is what
		// exercises the queue's failure swallow.
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: vi.fn(),
			update: vi.fn().mockRejectedValue(new Error("storage unavailable")),
		} as never)

		await expect(webviewMessageHandler(mockClineProvider, { type: "debugSetting", bool: true })).rejects.toThrow(
			"storage unavailable",
		)

		// The queue stored the guarded version, so a following save still runs to completion.
		vi.mocked(mockClineProvider.contextProxy.setValue).mockResolvedValue(undefined as never)
		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			requestId: "after-failure",
			updatedSettings: { soundVolume: 0.3 },
		})

		expect(mockClineProvider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "settingsSaveResult",
			requestId: "after-failure",
			success: true,
			unsavedSettings: [],
		})
	})
})
