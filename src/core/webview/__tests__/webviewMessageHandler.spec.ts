// npx vitest core/webview/__tests__/webviewMessageHandler.spec.ts

import type { Mock } from "vitest"

// Mock dependencies - must come before imports
vi.mock("../../../api/providers/fetchers/modelCache")
// The refactor routes model-list fetches through an ApiHandler built by buildApiHandler.
// Mock it so the handler is a lightweight double instead of a real provider (which would
// require credentials and other un-mocked collaborators).
vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn().mockReturnValue({
		getModel: vi.fn().mockReturnValue({ id: "claude-3-sonnet" }),
	}),
}))
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

import type { ModelRecord } from "@roo-code/types"
import * as vsCodeLmProvider from "../../../api/providers/vscode-lm"
import * as copilotProvider from "../../../api/providers/github-copilot"

import { webviewMessageHandler } from "../webviewMessageHandler"
import { settingWriteBookkeepingSize } from "../../config/appearanceSettingWrites"
import { registerCopilotModelBroadcast } from "../../../services/language-models/copilotModelBroadcast"
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
const mockClineProvider = {
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
	postStateToWebview: vi.fn(),
	resolveWebviewThemeFixtureProbe: vi.fn(),
	getCurrentTask: vi.fn(),
	getTaskWithId: vi.fn(),
	createTaskWithHistoryItem: vi.fn(),
	renameTaskWithId: vi.fn(),
	getSkillsManager: vi.fn(),
	cwd: "/mock/workspace",
} as unknown as ClineProvider

describe("webviewMessageHandler - Copilot authentication", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockClineProvider.getState = vi.fn().mockResolvedValue({ apiConfiguration: {} })
	})
	afterEach(() => vi.restoreAllMocks())

	it("reports the account before models finish loading without exposing a token", async () => {
		vi.spyOn(copilotProvider, "connectGitHubCopilot").mockImplementation(
			async (onAuthenticated?: (account: string) => Promise<void>) => {
				await onAuthenticated?.("Test User")
				return { account: "Test User", models: [] }
			},
		)
		await webviewMessageHandler(mockClineProvider, { type: "githubCopilotSignIn" })
		expect(mockClineProvider.postMessageToWebview).toHaveBeenNthCalledWith(1, {
			type: "githubCopilotModels",
			githubCopilotAccount: "Test User",
		})
		expect(mockClineProvider.postMessageToWebview).toHaveBeenNthCalledWith(2, {
			type: "githubCopilotSignInResult",
			githubCopilotAccount: "Test User",
			vsCodeLmModels: [],
		})
		expect(JSON.stringify(vi.mocked(mockClineProvider.postMessageToWebview).mock.calls)).not.toContain(
			"accessToken",
		)
		expect(mockClineProvider.contextProxy.setValue).not.toHaveBeenCalled()
	})

	it("returns sign-in errors to the requesting control", async () => {
		vi.spyOn(copilotProvider, "connectGitHubCopilot").mockRejectedValue(new Error("Sign-in cancelled"))
		await webviewMessageHandler(mockClineProvider, { type: "githubCopilotSignIn" })
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "githubCopilotSignInResult",
			error: "Sign-in cancelled",
		})
	})

	it("uses a fresh session for the reconnect command", async () => {
		const connect = vi
			.spyOn(copilotProvider, "connectGitHubCopilot")
			.mockResolvedValue({ account: "New User", models: [] })
		await webviewMessageHandler(mockClineProvider, { type: "githubCopilotReconnect" })
		expect(connect).toHaveBeenCalledWith(expect.any(Function), true)
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "githubCopilotSignInResult",
			githubCopilotAccount: "New User",
			vsCodeLmModels: [],
		})
	})

	it("drops a stale sign-in that completes after a newer reconnect", async () => {
		let finishSignIn!: (value: { account: string; models: [] }) => void
		let finishReconnect!: (value: { account: string; models: [] }) => void
		vi.spyOn(copilotProvider, "connectGitHubCopilot")
			.mockImplementationOnce(() => new Promise((resolve) => (finishSignIn = resolve)))
			.mockImplementationOnce(() => new Promise((resolve) => (finishReconnect = resolve)))

		const signIn = webviewMessageHandler(mockClineProvider, { type: "githubCopilotSignIn" })
		const reconnect = webviewMessageHandler(mockClineProvider, { type: "githubCopilotReconnect" })

		// The newer request finishes first, then the older one arrives late.
		finishReconnect({ account: "New User", models: [] })
		await reconnect
		finishSignIn({ account: "Old User", models: [] })
		await signIn

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledTimes(1)
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "githubCopilotSignInResult",
			githubCopilotAccount: "New User",
			vsCodeLmModels: [],
		})
	})

	it("drops a stale sign-in failure that arrives after a newer success", async () => {
		let failSignIn!: (reason: Error) => void
		let finishReconnect!: (value: { account: string; models: [] }) => void
		vi.spyOn(copilotProvider, "connectGitHubCopilot")
			.mockImplementationOnce(() => new Promise((_resolve, reject) => (failSignIn = reject)))
			.mockImplementationOnce(() => new Promise((resolve) => (finishReconnect = resolve)))

		const signIn = webviewMessageHandler(mockClineProvider, { type: "githubCopilotSignIn" })
		const reconnect = webviewMessageHandler(mockClineProvider, { type: "githubCopilotReconnect" })

		finishReconnect({ account: "New User", models: [] })
		await reconnect
		failSignIn(new Error("Sign-in cancelled"))
		await signIn

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledTimes(1)
		expect(mockClineProvider.postMessageToWebview).not.toHaveBeenCalledWith(
			expect.objectContaining({ error: expect.anything() }),
		)
	})

	it("answers every view that signs in, since only a view's own newer request makes its older one stale", async () => {
		const otherView = {
			...mockClineProvider,
			postMessageToWebview: vi.fn(),
		} as unknown as ClineProvider
		let finishFirst!: (value: { account: string; models: [] }) => void
		let finishSecond!: (value: { account: string; models: [] }) => void
		vi.spyOn(copilotProvider, "connectGitHubCopilot")
			.mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)))
			.mockImplementationOnce(() => new Promise((resolve) => (finishSecond = resolve)))

		const first = webviewMessageHandler(mockClineProvider, { type: "githubCopilotSignIn" })
		const second = webviewMessageHandler(otherView, { type: "githubCopilotSignIn" })
		finishSecond({ account: "Second User", models: [] })
		finishFirst({ account: "First User", models: [] })
		await Promise.all([first, second])

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "githubCopilotSignInResult", githubCopilotAccount: "First User" }),
		)
		expect(otherView.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "githubCopilotSignInResult", githubCopilotAccount: "Second User" }),
		)
	})

	it("opens VS Code's account management and never signs out itself", async () => {
		const open = vi.spyOn(copilotProvider, "openGitHubAccountManagement").mockResolvedValue(undefined)
		await webviewMessageHandler(mockClineProvider, { type: "githubCopilotManageAccount" })
		expect(open).toHaveBeenCalledOnce()
		expect(mockClineProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("logs, rather than surfacing, a failure to open account management", async () => {
		vi.spyOn(copilotProvider, "openGitHubAccountManagement").mockRejectedValue(new Error("command missing"))
		await webviewMessageHandler(mockClineProvider, { type: "githubCopilotManageAccount" })
		expect(mockClineProvider.log).toHaveBeenCalledWith(expect.stringContaining("command missing"))
	})

	it("reports a non-Error sign-in failure as text", async () => {
		vi.spyOn(copilotProvider, "connectGitHubCopilot").mockRejectedValue("denied")
		await webviewMessageHandler(mockClineProvider, { type: "githubCopilotSignIn" })
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "githubCopilotSignInResult",
			error: "denied",
		})
	})

	it("logs a non-Error failure to open account management", async () => {
		vi.spyOn(copilotProvider, "openGitHubAccountManagement").mockRejectedValue("no such command")
		await webviewMessageHandler(mockClineProvider, { type: "githubCopilotManageAccount" })
		expect(mockClineProvider.log).toHaveBeenCalledWith(expect.stringContaining("no such command"))
	})

	describe("legacy VS Code LM model requests", () => {
		it("lists the host's models as before and never looks up a GitHub account", async () => {
			const account = vi.spyOn(copilotProvider, "getGitHubCopilotAccount")
			const copilotModels = vi.spyOn(copilotProvider, "getGitHubCopilotModels")
			const models = vi.spyOn(vsCodeLmProvider, "getVsCodeLmModels").mockResolvedValue([])

			await webviewMessageHandler(mockClineProvider, { type: "requestVsCodeLmModels" })

			expect(models).toHaveBeenCalledWith()
			expect(account).not.toHaveBeenCalled()
			expect(copilotModels).not.toHaveBeenCalled()
			expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "vsCodeLmModels",
				vsCodeLmModels: [],
			})
		})
	})

	it("restores a signed-in account during passive model refresh", async () => {
		vi.spyOn(copilotProvider, "getGitHubCopilotAccount").mockResolvedValue("Test User")
		vi.spyOn(copilotProvider, "getGitHubCopilotModels").mockResolvedValue([])
		await webviewMessageHandler(mockClineProvider, {
			type: "requestVsCodeLmModels",
			apiConfiguration: { apiProvider: providerIdentifiers.githubCopilot },
		})
		expect(copilotProvider.getGitHubCopilotModels).toHaveBeenCalled()
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "githubCopilotModels",
			githubCopilotAccount: "Test User",
			vsCodeLmModels: [],
		})
	})

	it("drops the early account update of a sign-in that a newer one has superseded", async () => {
		let supersededCallback!: (account: string) => Promise<void>
		let finishSupersededSignIn!: (value: { account: string; models: [] }) => void
		vi.spyOn(copilotProvider, "connectGitHubCopilot")
			.mockImplementationOnce((onAuthenticated) => {
				supersededCallback = onAuthenticated!
				return new Promise((resolve) => (finishSupersededSignIn = resolve))
			})
			.mockResolvedValueOnce({ account: "New User", models: [] })

		const superseded = webviewMessageHandler(mockClineProvider, { type: "githubCopilotSignIn" })
		await webviewMessageHandler(mockClineProvider, { type: "githubCopilotReconnect" })
		await supersededCallback("Old User")
		finishSupersededSignIn({ account: "Old User", models: [] })
		await superseded

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "githubCopilotSignInResult",
			githubCopilotAccount: "New User",
			vsCodeLmModels: [],
		})
	})

	it("publishes the early account update of a sign-in that is still the newest", async () => {
		let callback!: (account: string) => Promise<void>
		let finish!: (value: { account: string; models: [] }) => void
		vi.spyOn(copilotProvider, "connectGitHubCopilot").mockImplementation((onAuthenticated) => {
			callback = onAuthenticated!
			return new Promise((resolve) => (finish = resolve))
		})

		const signIn = webviewMessageHandler(mockClineProvider, { type: "githubCopilotSignIn" })
		await callback("Test User")

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "githubCopilotModels",
			githubCopilotAccount: "Test User",
		})
		finish({ account: "Test User", models: [] })
		await signIn
	})

	it("reports no account as null, so the webview clears a stale sign-in rather than keeping it", async () => {
		vi.spyOn(copilotProvider, "getGitHubCopilotAccount").mockResolvedValue(undefined)
		vi.spyOn(copilotProvider, "getGitHubCopilotModels").mockResolvedValue([])
		await webviewMessageHandler(mockClineProvider, {
			type: "requestVsCodeLmModels",
			apiConfiguration: { apiProvider: providerIdentifiers.githubCopilot },
		})
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "githubCopilotModels",
			githubCopilotAccount: null,
			vsCodeLmModels: [],
		})
	})

	describe("passive refresh racing a sign-in", () => {
		const passiveRequest = () =>
			webviewMessageHandler(mockClineProvider, {
				type: "requestVsCodeLmModels",
				apiConfiguration: { apiProvider: providerIdentifiers.githubCopilot },
			})
		const signedInResult = {
			type: "githubCopilotSignInResult",
			githubCopilotAccount: "New User",
			vsCodeLmModels: [],
		}

		it("discards a refresh that began before a sign-in which finished first", async () => {
			let finishModels!: (models: []) => void
			vi.spyOn(copilotProvider, "getGitHubCopilotAccount").mockResolvedValue(undefined)
			vi.spyOn(copilotProvider, "getGitHubCopilotModels").mockImplementation(
				() => new Promise((resolve) => (finishModels = resolve)),
			)
			vi.spyOn(copilotProvider, "connectGitHubCopilot").mockResolvedValue({ account: "New User", models: [] })

			const refresh = passiveRequest()
			await webviewMessageHandler(mockClineProvider, { type: "githubCopilotSignIn" })
			finishModels([])
			await refresh

			expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledTimes(1)
			expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith(signedInResult)
		})

		it("discards a refresh whose model lookup fails after a newer sign-in", async () => {
			let failModels!: (reason: Error) => void
			vi.spyOn(copilotProvider, "getGitHubCopilotAccount").mockResolvedValue(undefined)
			vi.spyOn(copilotProvider, "getGitHubCopilotModels").mockImplementation(
				() => new Promise((_resolve, reject) => (failModels = reject)),
			)
			vi.spyOn(copilotProvider, "connectGitHubCopilot").mockResolvedValue({ account: "New User", models: [] })

			const refresh = passiveRequest()
			await webviewMessageHandler(mockClineProvider, { type: "githubCopilotSignIn" })
			failModels(new Error("host busy"))
			await refresh

			expect(mockClineProvider.postMessageToWebview).not.toHaveBeenCalledWith(
				expect.objectContaining({ error: expect.anything() }),
			)
		})

		it("discards a refresh that began during a sign-in and ended after it", async () => {
			let finishSignIn!: (value: { account: string; models: [] }) => void
			let finishModels!: (models: []) => void
			vi.spyOn(copilotProvider, "getGitHubCopilotAccount").mockResolvedValue(undefined)
			vi.spyOn(copilotProvider, "getGitHubCopilotModels").mockImplementation(
				() => new Promise((resolve) => (finishModels = resolve)),
			)
			vi.spyOn(copilotProvider, "connectGitHubCopilot").mockImplementation(
				() => new Promise((resolve) => (finishSignIn = resolve)),
			)

			const signIn = webviewMessageHandler(mockClineProvider, { type: "githubCopilotSignIn" })
			const refresh = passiveRequest()
			finishSignIn({ account: "New User", models: [] })
			await signIn
			finishModels([])
			await refresh

			expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledTimes(1)
			expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith(signedInResult)
		})

		it("does not make a pending sign-in stale by starting a refresh", async () => {
			let finishSignIn!: (value: { account: string; models: [] }) => void
			vi.spyOn(copilotProvider, "getGitHubCopilotAccount").mockResolvedValue(undefined)
			vi.spyOn(copilotProvider, "getGitHubCopilotModels").mockResolvedValue([])
			vi.spyOn(copilotProvider, "connectGitHubCopilot").mockImplementation(
				() => new Promise((resolve) => (finishSignIn = resolve)),
			)

			const signIn = webviewMessageHandler(mockClineProvider, { type: "githubCopilotSignIn" })
			await passiveRequest()
			finishSignIn({ account: "New User", models: [] })
			await signIn

			expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith(signedInResult)
		})

		it("still answers a refresh when no sign-in happened meanwhile", async () => {
			vi.spyOn(copilotProvider, "getGitHubCopilotAccount").mockResolvedValue("Test User")
			vi.spyOn(copilotProvider, "getGitHubCopilotModels").mockResolvedValue([])

			await passiveRequest()

			expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
				type: "githubCopilotModels",
				githubCopilotAccount: "Test User",
				vsCodeLmModels: [],
			})
		})

		it("discards an older refresh that finishes after a newer one, even with no sign-in", async () => {
			const finishers: Array<(models: Array<{ id: string }>) => void> = []
			vi.spyOn(copilotProvider, "getGitHubCopilotAccount").mockResolvedValue("Test User")
			vi.spyOn(copilotProvider, "getGitHubCopilotModels").mockImplementation(
				() => new Promise((resolve) => finishers.push(resolve as (models: Array<{ id: string }>) => void)),
			)

			const older = passiveRequest()
			const newer = passiveRequest()
			await vi.waitFor(() => expect(finishers).toHaveLength(2))

			finishers[1]([{ id: "newer" }])
			await newer
			finishers[0]([{ id: "older" }])
			await older

			const posted = vi.mocked(mockClineProvider.postMessageToWebview).mock.calls.map(([message]) => message)
			expect(posted).toEqual([
				{ type: "githubCopilotModels", githubCopilotAccount: "Test User", vsCodeLmModels: [{ id: "newer" }] },
			])
		})

		it("discards an older refresh's error that arrives after a newer refresh succeeded", async () => {
			const settlers: Array<{
				resolve: (models: Array<{ id: string }>) => void
				reject: (error: Error) => void
			}> = []
			vi.spyOn(copilotProvider, "getGitHubCopilotAccount").mockResolvedValue("Test User")
			vi.spyOn(copilotProvider, "getGitHubCopilotModels").mockImplementation(
				() =>
					new Promise((resolve, reject) =>
						settlers.push({ resolve: resolve as (models: Array<{ id: string }>) => void, reject }),
					),
			)

			const older = passiveRequest()
			const newer = passiveRequest()
			await vi.waitFor(() => expect(settlers).toHaveLength(2))

			settlers[1].resolve([{ id: "newer" }])
			await newer
			settlers[0].reject(new Error("host busy"))
			await older

			const posted = vi.mocked(mockClineProvider.postMessageToWebview).mock.calls.map(([message]) => message)
			expect(posted).toEqual([
				{ type: "githubCopilotModels", githubCopilotAccount: "Test User", vsCodeLmModels: [{ id: "newer" }] },
			])
		})

		it("keeps one view's refresh from discarding another view's refresh", async () => {
			const otherView = { ...mockClineProvider, postMessageToWebview: vi.fn() } as unknown as ClineProvider
			let finishFirst!: (models: Array<{ id: string }>) => void
			let calls = 0
			vi.spyOn(copilotProvider, "getGitHubCopilotAccount").mockResolvedValue("Test User")
			vi.spyOn(copilotProvider, "getGitHubCopilotModels").mockImplementation(() =>
				++calls === 1
					? new Promise((resolve) => (finishFirst = resolve as (models: Array<{ id: string }>) => void))
					: Promise.resolve([{ id: "other-view" }] as never),
			)

			const refresh = passiveRequest()
			await vi.waitFor(() => expect(calls).toBe(1))
			await webviewMessageHandler(otherView, {
				type: "requestVsCodeLmModels",
				apiConfiguration: { apiProvider: providerIdentifiers.githubCopilot },
			})
			finishFirst([{ id: "first-view" }])
			await refresh

			const posted = vi.mocked(mockClineProvider.postMessageToWebview).mock.calls.map(([message]) => message)
			expect(posted).toEqual([
				{
					type: "githubCopilotModels",
					githubCopilotAccount: "Test User",
					vsCodeLmModels: [{ id: "first-view" }],
				},
			])
		})

		it("discards a manual refresh that a host model-change broadcast overtook", async () => {
			let finishManual!: (models: Array<{ id: string }>) => void
			vi.spyOn(copilotProvider, "getGitHubCopilotAccount").mockResolvedValue("Test User")
			vi.spyOn(copilotProvider, "getGitHubCopilotModels").mockImplementation(
				() => new Promise((resolve) => (finishManual = resolve as (models: Array<{ id: string }>) => void)),
			)
			let notifyHost!: () => void
			const broadcast = registerCopilotModelBroadcast({
				getTargets: () => [mockClineProvider],
				log: vi.fn(),
				debounceMs: 0,
				subscribe: (listener: () => void) => {
					notifyHost = listener
					return { dispose: () => {} }
				},
				fetchModels: async () => [{ id: "new-from-host" }] as never,
				fetchAccount: async () => "Test User",
			})
			try {
				// A manual refresh starts first and is still waiting on the host.
				const manual = passiveRequest()
				await vi.waitFor(() => expect(finishManual).toBeDefined())

				// The host then reports new models, and the broadcast delivers them.
				notifyHost()
				await vi.waitFor(() => expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledTimes(1))

				// The manual refresh finishes last, with the older list.
				finishManual([{ id: "old-from-manual" }])
				await manual

				const posted = vi.mocked(mockClineProvider.postMessageToWebview).mock.calls.map(([message]) => message)
				expect(posted).toEqual([
					{
						type: "githubCopilotModels",
						githubCopilotAccount: "Test User",
						vsCodeLmModels: [{ id: "new-from-host" }],
					},
				])
			} finally {
				broadcast.dispose()
			}
		})

		describe("a broadcast that does not deliver", () => {
			const pendingManual = () => {
				let finishManual!: (models: Array<{ id: string }>) => void
				vi.spyOn(copilotProvider, "getGitHubCopilotAccount").mockResolvedValue("Test User")
				vi.spyOn(copilotProvider, "getGitHubCopilotModels").mockImplementation(
					() => new Promise((resolve) => (finishManual = resolve as (models: Array<{ id: string }>) => void)),
				)
				return { finish: (models: Array<{ id: string }>) => finishManual(models) }
			}
			const broadcastWith = (fetchModels: () => Promise<never>) => {
				let notifyHost!: () => void
				const registration = registerCopilotModelBroadcast({
					getTargets: () => [mockClineProvider],
					log: vi.fn(),
					debounceMs: 0,
					subscribe: (listener: () => void) => {
						notifyHost = listener
						return { dispose: () => {} }
					},
					fetchModels,
					fetchAccount: async () => "Test User",
				})
				return { notify: () => notifyHost(), registration }
			}
			const expectManualReplyDelivered = () =>
				expect(
					vi.mocked(mockClineProvider.postMessageToWebview).mock.calls.map(([message]) => message),
				).toEqual([
					{
						type: "githubCopilotModels",
						githubCopilotAccount: "Test User",
						vsCodeLmModels: [{ id: "manual" }],
					},
				])

			it("still delivers a manual refresh when the broadcast's lookup fails", async () => {
				const manualLookup = pendingManual()
				const { notify, registration } = broadcastWith(() => Promise.reject(new Error("host busy")))
				try {
					const manual = passiveRequest()
					await vi.waitFor(() => expect(copilotProvider.getGitHubCopilotModels).toHaveBeenCalled())
					notify()
					await new Promise((resolve) => setTimeout(resolve, 0))

					manualLookup.finish([{ id: "manual" }])
					await manual

					// Otherwise the view's refresh spinner never clears and its buttons stay disabled.
					expectManualReplyDelivered()
				} finally {
					registration.dispose()
				}
			})

			it("still delivers a manual refresh when a newer broadcast supersedes the first and both fail", async () => {
				const manualLookup = pendingManual()
				const { notify, registration } = broadcastWith(() => Promise.reject(new Error("host busy")))
				try {
					const manual = passiveRequest()
					await vi.waitFor(() => expect(copilotProvider.getGitHubCopilotModels).toHaveBeenCalled())
					notify()
					notify()
					await new Promise((resolve) => setTimeout(resolve, 0))

					manualLookup.finish([{ id: "manual" }])
					await manual

					expectManualReplyDelivered()
				} finally {
					registration.dispose()
				}
			})
		})

		it("reports a thrown account lookup as an error, so the webview keeps its account label", async () => {
			vi.spyOn(copilotProvider, "getGitHubCopilotAccount").mockRejectedValue(new Error("auth unavailable"))
			vi.spyOn(copilotProvider, "getGitHubCopilotModels").mockResolvedValue([])

			await passiveRequest()

			// No githubCopilotAccount field: the webview leaves its label alone rather than clearing it.
			expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "githubCopilotModels",
				error: "auth unavailable",
			})
		})

		it("keeps one view's sign-in from discarding another view's refresh", async () => {
			const otherView = { ...mockClineProvider, postMessageToWebview: vi.fn() } as unknown as ClineProvider
			vi.spyOn(copilotProvider, "getGitHubCopilotAccount").mockResolvedValue("Test User")
			vi.spyOn(copilotProvider, "getGitHubCopilotModels").mockResolvedValue([])
			vi.spyOn(copilotProvider, "connectGitHubCopilot").mockResolvedValue({ account: "Other", models: [] })

			const refresh = passiveRequest()
			await webviewMessageHandler(otherView, { type: "githubCopilotSignIn" })
			await refresh

			expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith(
				expect.objectContaining({ type: "githubCopilotModels", githubCopilotAccount: "Test User" }),
			)
		})
	})

	it("reports a model discovery failure that is not an Error as text", async () => {
		vi.spyOn(copilotProvider, "getGitHubCopilotAccount").mockResolvedValue("Test User")
		vi.spyOn(copilotProvider, "getGitHubCopilotModels").mockRejectedValue("quota exceeded")
		await webviewMessageHandler(mockClineProvider, {
			type: "requestVsCodeLmModels",
			apiConfiguration: { apiProvider: providerIdentifiers.githubCopilot },
		})
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "githubCopilotModels",
			error: "quota exceeded",
		})
	})

	it("shows model discovery errors instead of silently returning an empty list", async () => {
		vi.spyOn(copilotProvider, "getGitHubCopilotAccount").mockResolvedValue("Test User")
		vi.spyOn(copilotProvider, "getGitHubCopilotModels").mockRejectedValue(new Error("Model access denied"))
		await webviewMessageHandler(mockClineProvider, {
			type: "requestVsCodeLmModels",
			apiConfiguration: { apiProvider: providerIdentifiers.githubCopilot },
		})
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "githubCopilotModels",
			error: "Model access denied",
		})
	})
})

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

import { t } from "../../../i18n"

vi.mock("vscode", () => {
	const showInformationMessage = vi.fn()
	const showErrorMessage = vi.fn()
	const openTextDocument = vi.fn().mockResolvedValue({})
	const showTextDocument = vi.fn().mockResolvedValue(undefined)

	return {
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

		expect(mockGetModels).toHaveBeenCalledWith(
			{
				provider: providerIdentifiers.lmstudio,
				baseUrl: "http://localhost:1234",
			},
			expect.anything(),
		)

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

		expect(mockGetModels).toHaveBeenCalledWith(
			{
				provider: providerIdentifiers.ollama,
				baseUrl: "http://localhost:1234",
			},
			expect.anything(),
		)

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
			expect.anything(),
			true,
		)
		expect(mockGetModels).toHaveBeenCalledWith(
			{
				provider: providerIdentifiers.ollama,
				baseUrl: "https://ollama.example.com",
				apiKey: "secret-key",
			},
			expect.anything(),
		)

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
		expect(mockGetModels).toHaveBeenCalledWith({ provider: providerIdentifiers.openrouter }, expect.anything())
		expect(mockGetModels).toHaveBeenCalledWith(
			{ provider: providerIdentifiers.requesty, apiKey: "requesty-key" },
			expect.anything(),
		)
		expect(mockGetModels).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: providerIdentifiers.unbound,
			}),
			expect.anything(),
		)
		expect(mockGetModels).toHaveBeenCalledWith({ provider: providerIdentifiers.vercelAiGateway }, expect.anything())
		expect(mockGetModels).toHaveBeenCalledWith(
			{
				provider: providerIdentifiers.litellm,
				apiKey: "litellm-key",
				baseUrl: "http://localhost:4000",
			},
			expect.anything(),
		)
		// Opencode Go's /models endpoint is public, so it is fetched like the other no-auth routers.
		expect(mockGetModels).toHaveBeenCalledWith(
			expect.objectContaining({ provider: providerIdentifiers.opencodeGo }),
			expect.anything(),
		)
		// Kenari's /models endpoint is public, so it is fetched like the other no-auth routers.
		expect(mockGetModels).toHaveBeenCalledWith(
			expect.objectContaining({ provider: providerIdentifiers.kenari }),
			expect.anything(),
		)
		// IO Intelligence's /models catalog is public and may optionally be scoped by a key.
		expect(mockGetModels).toHaveBeenCalledWith(
			{ provider: providerIdentifiers.ioIntelligence, apiKey: undefined },
			expect.anything(),
		)
		// NanoGPT's detailed catalog is public and may optionally be scoped by a key.
		expect(mockGetModels).toHaveBeenCalledWith(
			{ provider: providerIdentifiers.nanogpt, apiKey: undefined },
			expect.anything(),
		)

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
				"io-intelligence": mockModels,
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
		expect(mockGetModels).toHaveBeenCalledWith(
			{ provider: providerIdentifiers.opencodeGo, apiKey: undefined },
			expect.anything(),
		)

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
			expect.anything(),
			true,
		)
		expect(mockGetModels).toHaveBeenCalledWith(
			{ provider: providerIdentifiers.opencodeGo, apiKey: "fresh-key" },
			expect.anything(),
		)
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
			expect.anything(),
			true,
		)
		expect(mockGetModels).toHaveBeenCalledWith(
			{ provider: providerIdentifiers.kenari, apiKey: "fresh-kenari-key" },
			expect.anything(),
		)
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

		expect(mockGetModels).toHaveBeenCalledWith(
			{ provider: providerIdentifiers.nanogpt, apiKey: undefined },
			expect.anything(),
		)
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
			expect.anything(),
			true,
		)
		expect(mockGetModels).toHaveBeenCalledWith(
			{ provider: providerIdentifiers.nanogpt, apiKey: "unsaved-key" },
			expect.anything(),
		)
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
			expect.anything(),
			true,
		)
		expect(mockGetModels).toHaveBeenCalledWith(
			{ provider: providerIdentifiers.nanogpt, apiKey: "saved-key" },
			expect.anything(),
		)
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
		expect(mockGetModels).toHaveBeenCalledWith(
			{
				provider: providerIdentifiers.litellm,
				apiKey: "message-litellm-key",
				baseUrl: "http://message-url:4000",
			},
			expect.anything(),
		)
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
			expect.anything(),
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
				"io-intelligence": mockModels,
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
			.mockResolvedValueOnce(mockModels) // io-intelligence
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
				"io-intelligence": mockModels,
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
		expect(mockGetModels).toHaveBeenCalledWith(
			{
				provider: providerIdentifiers.litellm,
				apiKey: "message-key", // From message.values
				baseUrl: "http://message-url", // From message.values
			},
			expect.anything(),
		)
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

describe("webviewMessageHandler - the appearance settings are saved all-or-nothing", () => {
	const stored: Record<string, unknown> = {}

	type WriteHook = (key: string, value: unknown) => Promise<void> | void

	/**
	 * Makes the write of one key fail. `beforeThrow` can hold the failure back (to let another save run) or
	 * change what is stored, as a store whose cache was already updated when the write failed.
	 */
	const failWriteOf = (key: string, value: unknown, beforeThrow?: WriteHook) => {
		const real = vi.mocked(mockClineProvider.contextProxy.setValue).getMockImplementation()!
		vi.mocked(mockClineProvider.contextProxy.setValue).mockImplementation(async (k: string, v: unknown) => {
			if (k === key && v === value) {
				await beforeThrow?.(k, v)
				throw new Error("storage unavailable")
			}
			return real(k as never, v as never)
		})
	}

	const save = (updatedSettings: Record<string, unknown>, requestId: string | null = "save-1") =>
		webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			requestId: requestId ?? undefined,
			updatedSettings,
		})

	beforeEach(() => {
		vi.clearAllMocks()
		for (const key of Object.keys(stored)) delete stored[key]
		Object.assign(stored, { interfaceFontScale: 100, terminalFontSize: 12, soundEnabled: false })
		vi.mocked(mockClineProvider.contextProxy.getValue).mockImplementation((key: string) => stored[key] as never)
		vi.mocked(mockClineProvider.contextProxy.setValue).mockImplementation(async (key: string, value: unknown) => {
			stored[key] = value
		})
		vi.mocked(mockClineProvider.postStateToWebview).mockResolvedValue(undefined as never)
	})

	it("stores every setting and confirms the save by request id", async () => {
		await save({ interfaceFontScale: 120, terminalFontSize: 14, editorFontSize: 15, spacingScale: 80 })

		expect(stored).toMatchObject({
			interfaceFontScale: 120,
			terminalFontSize: 14,
			editorFontSize: 15,
			spacingScale: 80,
		})
		expect(mockClineProvider.postStateToWebview).toHaveBeenCalled()
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "settingsSaveResult",
			requestId: "save-1",
			success: true,
		})
		expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
	})

	it("puts back the values already stored when a later one fails, and reports the failure", async () => {
		failWriteOf("editorFontSize", 15)

		await save({ interfaceFontScale: 120, terminalFontSize: 14, editorFontSize: 15 })

		expect(stored).toMatchObject({ interfaceFontScale: 100, terminalFontSize: 12 })
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "settingsSaveResult",
			requestId: "save-1",
			success: false,
			error: "storage unavailable",
		})
		expect(mockClineProvider.postMessageToWebview).not.toHaveBeenCalledWith(
			expect.objectContaining({ success: true }),
		)
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.settings_save_failed")
		expect(mockClineProvider.log).toHaveBeenCalledWith(expect.stringContaining("Save failed"))
		// The webview is re-synced with what is really stored: after the values were put back, not before.
		expect(mockClineProvider.postStateToWebview).toHaveBeenCalled()
		const lastWrite = Math.max(...vi.mocked(mockClineProvider.contextProxy.setValue).mock.invocationCallOrder)
		expect(vi.mocked(mockClineProvider.postStateToWebview).mock.invocationCallOrder[0]).toBeGreaterThan(lastWrite)
	})

	it("puts back the value whose own write failed after it had changed the stored value", async () => {
		// As a store whose cache is updated before its write to disk fails.
		failWriteOf("terminalFontSize", 14, (key, value) => {
			stored[key] = value
		})

		await save({ terminalFontSize: 14 })

		expect(stored.terminalFontSize).toBe(12)
	})

	it("restores in reverse order, so the first stored value is restored last", async () => {
		const order: string[] = []
		const real = vi.mocked(mockClineProvider.contextProxy.setValue).getMockImplementation()!
		vi.mocked(mockClineProvider.contextProxy.setValue).mockImplementation(async (key: string, value: unknown) => {
			order.push(key)
			if (key === "spacingScale" && value === 80) throw new Error("boom")
			return real(key as never, value as never)
		})

		await save({ interfaceFontScale: 120, terminalFontSize: 14, spacingScale: 80 })

		expect(stored).toMatchObject({ interfaceFontScale: 100, terminalFontSize: 12 })
		// Three writes forward (the last one fails and never changed the stored value, so there is nothing to put
		// back for it), then the restores in the opposite order.
		expect(order).toEqual([
			"interfaceFontScale",
			"terminalFontSize",
			"spacingScale",
			"terminalFontSize",
			"interfaceFontScale",
		])
	})

	it("clears a value again that had no stored value before the save", async () => {
		failWriteOf("terminalFontSize", 14)

		await save({ editorFontSize: 15, terminalFontSize: 14 })

		expect(stored.editorFontSize).toBeUndefined()
	})

	describe("two saves at once", () => {
		it("a failed save does not undo another save's different value", async () => {
			let releaseFailure!: () => void
			const held = new Promise<void>((resolve) => (releaseFailure = resolve))
			failWriteOf("terminalFontSize", 14, () => held)

			const a = save({ interfaceFontScale: 120, terminalFontSize: 14 }, "save-a")
			await vi.waitFor(() => expect(stored.interfaceFontScale).toBe(120))
			await save({ interfaceFontScale: 150 }, "save-b")

			releaseFailure()
			await a

			expect(stored.interfaceFontScale).toBe(150)
		})

		it("a failed save does not undo another save that wrote the same value", async () => {
			let releaseFailure!: () => void
			const held = new Promise<void>((resolve) => (releaseFailure = resolve))
			failWriteOf("terminalFontSize", 14, () => held)

			// Save A stores interfaceFontScale 120, then waits at its failing write.
			const a = save({ interfaceFontScale: 120, terminalFontSize: 14 }, "save-a")
			await vi.waitFor(() => expect(stored.interfaceFontScale).toBe(120))

			// Save B stores the same value for the same key, and finishes.
			await save({ interfaceFontScale: 120 }, "save-b")
			expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
				type: "settingsSaveResult",
				requestId: "save-b",
				success: true,
			})

			// Save A now fails and rolls back. B's write of the same value must stand.
			releaseFailure()
			await a

			expect(stored.interfaceFontScale).toBe(120)
			expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith(
				expect.objectContaining({ requestId: "save-a", success: false }),
			)
		})

		/** Two saves that both write the same key and then fail, each held at its own failing write. */
		const twoFailingSaves = async (releaseFirst: "a" | "b") => {
			const gates: Record<"a" | "b", () => void> = { a: () => {}, b: () => {} }
			const heldA = new Promise<void>((resolve) => (gates.a = resolve))
			const heldB = new Promise<void>((resolve) => (gates.b = resolve))
			failWriteOf("terminalFontSize", 14, () => heldA)
			failWriteOf("editorFontSize", 15, () => heldB)

			const a = save({ interfaceFontScale: 120, terminalFontSize: 14 }, "save-a")
			await vi.waitFor(() => expect(stored.interfaceFontScale).toBe(120))
			const b = save({ interfaceFontScale: 150, editorFontSize: 15 }, "save-b")
			await vi.waitFor(() => expect(stored.interfaceFontScale).toBe(150))

			const [first, second] = releaseFirst === "a" ? (["a", "b"] as const) : (["b", "a"] as const)
			gates[first]()
			await (first === "a" ? a : b)
			const afterFirst = stored.interfaceFontScale
			gates[second]()
			await (second === "a" ? a : b)
			return { afterFirst, final: stored.interfaceFontScale }
		}

		it("puts back the value from before both saves when both fail, the earlier one failing first", async () => {
			const { afterFirst, final } = await twoFailingSaves("a")

			// The later save is still pending with 150, so the first failure leaves it. Then it restores 100.
			expect(afterFirst).toBe(150)
			expect(final).toBe(100)
		})

		it("puts back the value from before both saves when both fail, the later one failing first", async () => {
			const { afterFirst, final } = await twoFailingSaves("b")

			// The later save restores the earlier one's pending value, and the earlier one then restores 100.
			expect(afterFirst).toBe(120)
			expect(final).toBe(100)
		})

		it("puts back the original value when three overlapping saves all fail, the middle one first", async () => {
			const release: Record<"a" | "b" | "c", () => void> = { a: () => {}, b: () => {}, c: () => {} }
			const gate = (name: "a" | "b" | "c") => new Promise<void>((resolve) => (release[name] = resolve))
			const gates = { a: gate("a"), b: gate("b"), c: gate("c") }
			failWriteOf("terminalFontSize", 14, () => gates.a)
			failWriteOf("editorFontSize", 15, () => gates.b)
			failWriteOf("spacingScale", 80, () => gates.c)

			const a = save({ interfaceFontScale: 120, terminalFontSize: 14 }, "save-a")
			await vi.waitFor(() => expect(stored.interfaceFontScale).toBe(120))
			const b = save({ interfaceFontScale: 150, editorFontSize: 15 }, "save-b")
			await vi.waitFor(() => expect(stored.interfaceFontScale).toBe(150))
			const c = save({ interfaceFontScale: 180, spacingScale: 80 }, "save-c")
			await vi.waitFor(() => expect(stored.interfaceFontScale).toBe(180))

			// The middle save fails first: the newest is still pending, so the value stays.
			release.b()
			await b
			expect(stored.interfaceFontScale).toBe(180)

			// The newest fails: it goes back to the oldest save's pending value, not to the middle one's.
			release.c()
			await c
			expect(stored.interfaceFontScale).toBe(120)

			// The oldest fails: back to the value from before all three.
			release.a()
			await a
			expect(stored.interfaceFontScale).toBe(100)
		})

		it("keeps the earlier save's value when the later one fails and the earlier one succeeds", async () => {
			let releaseFailure!: () => void
			const held = new Promise<void>((resolve) => (releaseFailure = resolve))
			failWriteOf("editorFontSize", 15, () => held)

			const later = (async () => {
				await vi.waitFor(() => expect(stored.interfaceFontScale).toBe(120))
				return save({ interfaceFontScale: 150, editorFontSize: 15 }, "save-b")
			})()
			// The earlier save writes first and finishes while the later one is held.
			await save({ interfaceFontScale: 120 }, "save-a")
			await vi.waitFor(() => expect(stored.interfaceFontScale).toBe(150))

			releaseFailure()
			await later

			expect(stored.interfaceFontScale).toBe(120)
		})

		it("keeps a value changed outside a save, such as an import, when a failed save rolls back", async () => {
			failWriteOf("terminalFontSize", 14, () => {
				stored.interfaceFontScale = 90 // an import writes the same key meanwhile
			})

			await save({ interfaceFontScale: 120, terminalFontSize: 14 })

			expect(stored.interfaceFontScale).toBe(90)
		})

		it("a later failure of the other save still puts its own writes back", async () => {
			let releaseFailure!: () => void
			const held = new Promise<void>((resolve) => (releaseFailure = resolve))
			failWriteOf("editorFontSize", 15, () => held)

			// Save A holds at its failing write, and has not touched spacingScale.
			const a = save({ terminalFontSize: 14, editorFontSize: 15 }, "save-a")
			await vi.waitFor(() => expect(stored.terminalFontSize).toBe(14))
			// Save B writes a different key and finishes.
			await save({ spacingScale: 80 }, "save-b")

			releaseFailure()
			await a

			expect(stored.terminalFontSize).toBe(12) // A's own write is put back
			expect(stored.spacingScale).toBe(80) // B's is untouched
		})
	})

	describe("writes to one setting are ordered, down to durable storage", () => {
		/**
		 * A store whose writes reach durable storage later than they are started: each write holds until it is
		 * released, and the events record when it started and when it reached storage.
		 */
		const slowStore = () => {
			const events: string[] = []
			const gates = new Map<string, () => void>()
			vi.mocked(mockClineProvider.contextProxy.setValue).mockImplementation(
				async (key: string, value: unknown) => {
					events.push(`start ${key}=${String(value)}`)
					await new Promise<void>((resolve) => gates.set(`${key}=${String(value)}`, resolve))
					stored[key] = value
					events.push(`end ${key}=${String(value)}`)
				},
			)
			const release = async (what: string) => {
				await vi.waitFor(() => expect(gates.has(what)).toBe(true))
				gates.get(what)!()
				gates.delete(what)
			}
			return { events, release }
		}

		it("does not start a newer save's write of a key before the older one has reached storage", async () => {
			const { events, release } = slowStore()

			const a = save({ interfaceFontScale: 120 }, "save-a")
			await vi.waitFor(() => expect(events).toContain("start interfaceFontScale=120"))
			const b = save({ interfaceFontScale: 150 }, "save-b")
			// Give the second save every chance to start its write: it must wait for the first.
			await new Promise((resolve) => setTimeout(resolve, 20))
			expect(events).not.toContain("start interfaceFontScale=150")

			await release("interfaceFontScale=120")
			await vi.waitFor(() => expect(events).toContain("start interfaceFontScale=150"))
			await release("interfaceFontScale=150")
			await Promise.all([a, b])

			// The newer value reached storage last, so it is the one that stays, and both saves succeeded.
			expect(events).toEqual([
				"start interfaceFontScale=120",
				"end interfaceFontScale=120",
				"start interfaceFontScale=150",
				"end interfaceFontScale=150",
			])
			expect(stored.interfaceFontScale).toBe(150)
			expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
				type: "settingsSaveResult",
				requestId: "save-b",
				success: true,
			})
		})

		it("a failed save restores what the save before it wrote, even if that was still queued when it registered", async () => {
			const { events, release } = slowStore()

			// Q is writing, P waits behind it, and A registers while P has not started its write.
			const q = save({ interfaceFontScale: 110 }, "save-q")
			await vi.waitFor(() => expect(events).toContain("start interfaceFontScale=110"))
			const p = save({ interfaceFontScale: 130 }, "save-p")
			await new Promise((resolve) => setTimeout(resolve, 10))
			failWriteOf("terminalFontSize", 14)
			const a = save({ interfaceFontScale: 150, terminalFontSize: 14 }, "save-a")
			await new Promise((resolve) => setTimeout(resolve, 10))

			await release("interfaceFontScale=110")
			await release("interfaceFontScale=130")
			await release("interfaceFontScale=150")
			// A fails on terminalFontSize, and its restore of the interface font scale is a write too.
			await release("interfaceFontScale=130")
			await Promise.all([q, p, a])

			// P succeeded, so A's failure puts back P's value, not Q's.
			expect(stored.interfaceFontScale).toBe(130)
		})

		it("does not make writes of different keys wait for each other", async () => {
			const { events, release } = slowStore()

			const a = save({ interfaceFontScale: 120 }, "save-a")
			await vi.waitFor(() => expect(events).toContain("start interfaceFontScale=120"))
			const b = save({ terminalFontSize: 14 }, "save-b")

			await vi.waitFor(() => expect(events).toContain("start terminalFontSize=14"))
			await release("terminalFontSize=14")
			await b
			expect(stored.terminalFontSize).toBe(14)

			await release("interfaceFontScale=120")
			await a
		})

		it("lets the next write through when one has failed", async () => {
			let first = true
			const real = vi.mocked(mockClineProvider.contextProxy.setValue).getMockImplementation()!
			vi.mocked(mockClineProvider.contextProxy.setValue).mockImplementation(
				async (key: string, value: unknown) => {
					if (first && key === "interfaceFontScale") {
						first = false
						throw new Error("storage unavailable")
					}
					return real(key as never, value as never)
				},
			)

			await save({ interfaceFontScale: 120 }, "save-a")
			await save({ interfaceFontScale: 150 }, "save-b")

			expect(stored.interfaceFontScale).toBe(150)
			expect(mockClineProvider.postMessageToWebview).toHaveBeenLastCalledWith(
				expect.objectContaining({ requestId: "save-b", success: true }),
			)
		})

		it("also queues the write that puts a value back, behind the writes before it", async () => {
			const events: string[] = []
			const real = vi.mocked(mockClineProvider.contextProxy.setValue).getMockImplementation()!
			let releaseRestore!: () => void
			const restoreHeld = new Promise<void>((resolve) => (releaseRestore = resolve))
			vi.mocked(mockClineProvider.contextProxy.setValue).mockImplementation(
				async (key: string, value: unknown) => {
					events.push(`start ${key}=${String(value)}`)
					if (key === "terminalFontSize" && value === 14) throw new Error("storage unavailable")
					// Putting interfaceFontScale back is slow to reach storage.
					if (key === "interfaceFontScale" && value === 100) await restoreHeld
					await real(key as never, value as never)
					events.push(`end ${key}=${String(value)}`)
				},
			)

			// Save A writes interfaceFontScale, then fails: its restore of 100 is held.
			const a = save({ interfaceFontScale: 120, terminalFontSize: 14 }, "save-a")
			await vi.waitFor(() => expect(events).toContain("start interfaceFontScale=100"))
			// Save B writes the same key while the restore is still on its way to storage.
			const b = save({ interfaceFontScale: 150 }, "save-b")
			await new Promise((resolve) => setTimeout(resolve, 20))
			expect(events).not.toContain("start interfaceFontScale=150")

			releaseRestore()
			await Promise.all([a, b])

			expect(events.indexOf("end interfaceFontScale=100")).toBeLessThan(
				events.indexOf("start interfaceFontScale=150"),
			)
			expect(stored.interfaceFontScale).toBe(150)
		})
	})

	describe("nothing is kept about writes once the saves are over", () => {
		const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

		it("keeps nothing after a save that succeeded", async () => {
			await save({ interfaceFontScale: 120, terminalFontSize: 14 })
			await settled()

			expect(settingWriteBookkeepingSize()).toEqual({ latestWrites: 0, queuedKeys: 0 })
		})

		it("keeps nothing after a save that failed and was rolled back", async () => {
			failWriteOf("terminalFontSize", 14)

			await save({ interfaceFontScale: 120, terminalFontSize: 14 })
			await settled()

			expect(settingWriteBookkeepingSize()).toEqual({ latestWrites: 0, queuedKeys: 0 })
		})

		it("keeps nothing after overlapping saves, whichever way they end", async () => {
			let releaseFailure!: () => void
			const held = new Promise<void>((resolve) => (releaseFailure = resolve))
			failWriteOf("editorFontSize", 15, () => held)

			// The older save succeeds first; the newer one then fails.
			const newer = (async () => {
				await vi.waitFor(() => expect(stored.interfaceFontScale).toBe(120))
				return save({ interfaceFontScale: 150, editorFontSize: 15 }, "save-b")
			})()
			await save({ interfaceFontScale: 120 }, "save-a")
			await vi.waitFor(() => expect(stored.interfaceFontScale).toBe(150))
			releaseFailure()
			await newer
			await settled()

			expect(stored.interfaceFontScale).toBe(120)
			expect(settingWriteBookkeepingSize()).toEqual({ latestWrites: 0, queuedKeys: 0 })
		})

		it("keeps nothing after three overlapping saves that all fail", async () => {
			const release: Record<"a" | "b" | "c", () => void> = { a: () => {}, b: () => {}, c: () => {} }
			const gate = (name: "a" | "b" | "c") => new Promise<void>((resolve) => (release[name] = resolve))
			const gates = { a: gate("a"), b: gate("b"), c: gate("c") }
			failWriteOf("terminalFontSize", 14, () => gates.a)
			failWriteOf("editorFontSize", 15, () => gates.b)
			failWriteOf("spacingScale", 80, () => gates.c)

			const a = save({ interfaceFontScale: 120, terminalFontSize: 14 }, "save-a")
			await vi.waitFor(() => expect(stored.interfaceFontScale).toBe(120))
			const b = save({ interfaceFontScale: 150, editorFontSize: 15 }, "save-b")
			await vi.waitFor(() => expect(stored.interfaceFontScale).toBe(150))
			const c = save({ interfaceFontScale: 180, spacingScale: 80 }, "save-c")
			await vi.waitFor(() => expect(stored.interfaceFontScale).toBe(180))
			release.b()
			await b
			release.c()
			await c
			release.a()
			await a
			await settled()

			expect(stored.interfaceFontScale).toBe(100)
			expect(settingWriteBookkeepingSize()).toEqual({ latestWrites: 0, queuedKeys: 0 })
		})
	})

	it("keeps going and still reports the failure when a restore itself fails", async () => {
		const real = vi.mocked(mockClineProvider.contextProxy.setValue).getMockImplementation()!
		vi.mocked(mockClineProvider.contextProxy.setValue).mockImplementation(async (key: string, value: unknown) => {
			if (key === "terminalFontSize" && value === 14) throw new Error("terminalFontSize is broken")
			if (key === "interfaceFontScale" && value === 100) throw new Error("cannot restore")
			return real(key as never, value as never)
		})

		await save({ interfaceFontScale: 120, terminalFontSize: 14 })

		expect(mockClineProvider.log).toHaveBeenCalledWith(
			expect.stringContaining("Could not restore interfaceFontScale"),
		)
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ requestId: "save-1", success: false }),
		)
	})

	it("reports a restore failure that is not an Error", async () => {
		const real = vi.mocked(mockClineProvider.contextProxy.setValue).getMockImplementation()!
		vi.mocked(mockClineProvider.contextProxy.setValue).mockImplementation(async (key: string, value: unknown) => {
			if (key === "terminalFontSize" && value === 14) throw new Error("terminalFontSize is broken")
			if (key === "interfaceFontScale" && value === 100) throw "plain restore failure"
			return real(key as never, value as never)
		})

		await save({ interfaceFontScale: 120, terminalFontSize: 14 })

		expect(mockClineProvider.log).toHaveBeenCalledWith(expect.stringContaining("plain restore failure"))
	})

	describe("values from the webview are checked before anything is done", () => {
		const bounds = {
			interfaceFontScale: { min: 50, max: 200 },
			terminalFontSize: { min: 8, max: 32 },
			editorFontSize: { min: 8, max: 32 },
			spacingScale: { min: 50, max: 200 },
		} as const
		const keys = Object.keys(bounds) as Array<keyof typeof bounds>

		it.each(
			keys.flatMap((key) =>
				[
					["below the minimum", bounds[key].min - 1],
					["above the maximum", bounds[key].max + 1],
					["zero", 0],
					["negative", -10],
					["fractional", bounds[key].min + 0.5],
					["not a number", Number.NaN],
					["infinite", Number.POSITIVE_INFINITY],
					["a string", "20"],
					["a boolean", true],
					["an object", { value: 20 }],
					["an array", [20]],
				].map(([name, value]) => [key, name, value] as const),
			),
		)("rejects %s when it is %s", async (key, _name, value) => {
			await save({ [key]: value })

			expect(mockClineProvider.contextProxy.setValue).not.toHaveBeenCalled()
			expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
				type: "settingsSaveResult",
				requestId: "save-1",
				success: false,
				error: `Invalid value for ${key}`,
			})
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.settings_save_failed")
		})

		it("changes nothing at all when one value is invalid, not even the valid ones sent with it", async () => {
			vi.mocked(ensureDcgInstalled).mockClear()

			await save({
				interfaceFontScale: 120,
				terminalFontSize: 500,
				soundEnabled: true,
				destructiveCommandGuardEnabled: true,
			})

			expect(mockClineProvider.contextProxy.setValue).not.toHaveBeenCalled()
			expect(stored).toMatchObject({ interfaceFontScale: 100, soundEnabled: false })
			// No side effect ran either.
			expect(ensureDcgInstalled).not.toHaveBeenCalled()
		})

		it("does not echo the invalid value back", async () => {
			await save({ terminalFontSize: "x".repeat(10_000) })

			const posted = JSON.stringify(vi.mocked(mockClineProvider.postMessageToWebview).mock.calls)
			expect(posted).not.toContain("xxxxxxxxxx")
		})

		it.each(keys.flatMap((key) => [bounds[key].min, bounds[key].max].map((value) => [key, value] as const)))(
			"accepts %s at its bound %s",
			async (key, value) => {
				await save({ [key]: value })

				expect(stored[key]).toBe(value)
				expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith(
					expect.objectContaining({ success: true }),
				)
			},
		)

		it.each(keys)("accepts a reset of %s (null)", async (key) => {
			await save({ [key]: null })

			expect(stored[key]).toBeNull()
			expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith(
				expect.objectContaining({ success: true }),
			)
		})

		it("does not check settings that are not appearance values", async () => {
			await save({ soundEnabled: true, writeDelayMs: -5 })

			expect(stored).toMatchObject({ soundEnabled: true, writeDelayMs: -5 })
		})
	})

	describe("a failure while writing another setting", () => {
		it("puts the appearance values back, tells the webview, and then follows the existing error path", async () => {
			failWriteOf("soundEnabled", true)

			await expect(save({ terminalFontSize: 14, soundEnabled: true })).rejects.toThrow("storage unavailable")

			expect(stored.terminalFontSize).toBe(12)
			expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
				type: "settingsSaveResult",
				requestId: "save-1",
				success: false,
				error: "storage unavailable",
			})
			// No toast: the existing path did not show one for these settings.
			expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
		})

		it("does not reject for a failure of an appearance value, which is reported to the user instead", async () => {
			failWriteOf("terminalFontSize", 14)

			await expect(save({ terminalFontSize: 14 })).resolves.toBeUndefined()
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.settings_save_failed")
		})
	})

	it("reports a non-Error failure by its text", async () => {
		vi.mocked(mockClineProvider.contextProxy.setValue).mockRejectedValue("plain string failure")

		await save({ interfaceFontScale: 120 })

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ success: false, error: "plain string failure" }),
		)
	})

	it("leaves every other setting as it was written: it is not put back when a later write fails", async () => {
		failWriteOf("terminalFontSize", 14)

		await save({ soundEnabled: true, terminalFontSize: 14 })

		// Not an appearance value, so it keeps its existing behaviour. The failure is still reported.
		expect(stored.soundEnabled).toBe(true)
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ requestId: "save-1", success: false }),
		)
	})

	it("still saves and refreshes, without a result message, when the request has no id", async () => {
		await save({ interfaceFontScale: 120 }, null)

		expect(stored.interfaceFontScale).toBe(120)
		expect(mockClineProvider.postStateToWebview).toHaveBeenCalled()
		expect(mockClineProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("does not report a failure to a request without an id either", async () => {
		failWriteOf("interfaceFontScale", 120)

		await save({ interfaceFontScale: 120 }, null)

		expect(mockClineProvider.postMessageToWebview).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalled()
	})

	it("does nothing when there are no settings to save", async () => {
		await webviewMessageHandler(mockClineProvider, { type: "updateSettings", requestId: "save-6" })

		expect(mockClineProvider.contextProxy.setValue).not.toHaveBeenCalled()
		expect(mockClineProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it.each(["experiments", "customSupportPrompts"])("stores nothing for an empty %s value", async (key) => {
		await save({ [key]: undefined, interfaceFontScale: 120 })

		expect(stored).not.toHaveProperty(key)
		expect(stored.interfaceFontScale).toBe(120)
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ requestId: "save-1", success: true }),
		)
	})

	describe("when the state refresh fails", () => {
		it("keeps a stored save and still reports success", async () => {
			vi.mocked(mockClineProvider.postStateToWebview).mockRejectedValueOnce(new Error("state unavailable"))

			await save({ interfaceFontScale: 120, terminalFontSize: 14 })

			expect(stored).toMatchObject({ interfaceFontScale: 120, terminalFontSize: 14 })
			expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
				type: "settingsSaveResult",
				requestId: "save-1",
				success: true,
			})
			expect(mockClineProvider.log).toHaveBeenCalledWith(expect.stringContaining("state unavailable"))
			expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
		})

		it("logs a refresh failure that is not an Error", async () => {
			vi.mocked(mockClineProvider.postStateToWebview).mockRejectedValueOnce("plain refresh failure")

			await save({ interfaceFontScale: 120 })

			expect(mockClineProvider.log).toHaveBeenCalledWith(expect.stringContaining("plain refresh failure"))
			expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith(
				expect.objectContaining({ requestId: "save-1", success: true }),
			)
		})

		it("still reports a failed save", async () => {
			failWriteOf("interfaceFontScale", 120)
			vi.mocked(mockClineProvider.postStateToWebview).mockRejectedValueOnce(new Error("state unavailable"))

			await save({ interfaceFontScale: 120 })

			expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
				type: "settingsSaveResult",
				requestId: "save-1",
				success: false,
				error: "storage unavailable",
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
			Promise<unknown> | undefined
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

describe("webviewMessageHandler - collapseCommandOutputByDefault", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it.each([true, false, undefined])(
		"persists the output collapse preference (%s) without changing terminal mode",
		async (value) => {
			await webviewMessageHandler(mockClineProvider, {
				type: "updateSettings",
				updatedSettings: { collapseCommandOutputByDefault: value },
			})
			expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith(
				"collapseCommandOutputByDefault",
				value,
			)
			expect(mockClineProvider.contextProxy.setValue).not.toHaveBeenCalledWith(
				"terminalShellIntegrationDisabled",
				expect.anything(),
			)
			expect(mockClineProvider.postStateToWebview).toHaveBeenCalledTimes(1)
		},
	)
})

describe("updateProfileModel", () => {
	let updateProfileModel: Mock<ClineProvider["updateProfileModel"]>

	beforeEach(() => {
		vi.clearAllMocks()
		updateProfileModel = vi.fn<ClineProvider["updateProfileModel"]>().mockResolvedValue(undefined)
		mockClineProvider.updateProfileModel = updateProfileModel
	})

	it("delegates a valid message to the provider", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "updateProfileModel",
			text: "my-profile",
			values: {
				expectedProvider: providerIdentifiers.openrouter,
				patch: { openRouterModelId: "a/b", reasoningEffort: null },
			},
		})

		expect(updateProfileModel).toHaveBeenCalledWith("my-profile", providerIdentifiers.openrouter, {
			openRouterModelId: "a/b",
			reasoningEffort: null,
		})
	})

	it.each([
		["missing profile name", { values: { expectedProvider: providerIdentifiers.openrouter, patch: {} } }],
		["missing expectedProvider", { text: "p", values: { patch: {} } }],
		["non-object patch", { text: "p", values: { expectedProvider: providerIdentifiers.openrouter, patch: "x" } }],
		["array patch", { text: "p", values: { expectedProvider: providerIdentifiers.openrouter, patch: [] } }],
		["missing values", { text: "p" }],
	])("ignores a malformed message: %s", async (_label, partial) => {
		await webviewMessageHandler(mockClineProvider, {
			type: "updateProfileModel",
			...partial,
		} as unknown as Parameters<typeof webviewMessageHandler>[1])

		expect(updateProfileModel).not.toHaveBeenCalled()
	})
})

describe("webviewMessageHandler - renameTaskWithId", () => {
	beforeEach(() => {
		vi.mocked(mockClineProvider.renameTaskWithId).mockClear()
	})

	it.each([
		["forwards taskId and text", { taskId: "task-1", text: "New name" }, [["task-1", "New name"]]],
		["forwards an empty title so the provider can clear it", { taskId: "task-1", text: "" }, [["task-1", ""]]],
		["skips the call when taskId is missing", { text: "New name" }, []],
	])("%s", async (_label, payload, expectedCalls) => {
		await webviewMessageHandler(mockClineProvider, { type: "renameTaskWithId", ...payload })

		expect(vi.mocked(mockClineProvider.renameTaskWithId).mock.calls).toEqual(expectedCalls)
	})
})
