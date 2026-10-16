import { describe, expect, it, vi } from "vitest"
import type * as vscode from "vscode"

import { providerIdentifiers } from "@roo-code/types"

import { API } from "../api"
import type { ClineProvider } from "../../core/webview/ClineProvider"
import { makeClineProviderFactory } from "../../test-utils/provider"
// The merged API constructor requires a ClineProviderFactory; this spec never
// triggers tab creation, so the factory must not be called. Cast structurally:
// the class type carries private members.
const makeUnusedTabFactory = () =>
	({
		createInNewTab: vi.fn().mockRejectedValue(new Error("Unexpected editor-tab creation in this test")),
	}) as unknown as ConstructorParameters<typeof API>[2]

vi.mock("@roo-code/ipc", () => ({
	IpcServer: class {},
}))

describe("API - configuration", () => {
	it("keeps per-view viewStates out of the flattened configuration", () => {
		const getValues = vi.fn().mockReturnValue({
			mode: "code",
			currentApiConfigName: "view-profile",
			viewStates: { "sidebar-1": { mode: "architect", updatedAt: 5 } },
			apiConfiguration: {
				apiProvider: providerIdentifiers.openai,
				apiModelId: "gpt-4o",
			},
		})
		// Structural double: API.getConfiguration() only reads sidebarProvider.getValues()
		// from the provider; the double assertion adapts this minimal shape to the
		// constructor's ClineProvider parameter (same pattern as the tests above).
		const provider = {
			context: {},
			on: vi.fn(),
			getValues,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		const configuration = api.getConfiguration() as Record<string, unknown>

		// viewStates is per-view durable state owned by the extension host: a caller
		// that round-trips the configuration must not see (and later write back) a
		// snapshot that can clobber newer per-view selections.
		expect(configuration.viewStates).toBeUndefined()
		expect(configuration.mode).toBe("code")
		expect(configuration.apiModelId).toBe("gpt-4o")
	})

	it("keeps per-view viewStates out of the configuration when no profile is nested", () => {
		const getValues = vi.fn().mockReturnValue({
			mode: "code",
			apiProvider: providerIdentifiers.anthropic,
			viewStates: { "sidebar-1": { mode: "architect", updatedAt: 5 } },
		})
		// Structural double: see the note on the double above.
		const provider = {
			context: {},
			on: vi.fn(),
			getValues,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		const configuration = api.getConfiguration() as Record<string, unknown>

		expect(configuration.viewStates).toBeUndefined()
		expect(configuration.apiProvider).toBe(providerIdentifiers.anthropic)
	})

	it("refuses a caller-supplied viewStates snapshot when writing configuration", async () => {
		const setValues = vi.fn().mockResolvedValue(undefined)
		const saveConfig = vi.fn().mockResolvedValue("default-id")
		const provider = {
			context: {},
			on: vi.fn(),
			getValue: vi.fn(),
			setValues,
			contextProxy: { setValues },
			providerSettingsManager: { saveConfig },
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		await api.setConfiguration({
			currentApiConfigName: "default",
			apiProvider: providerIdentifiers.openai,
			viewStates: { "sidebar-1": { mode: "code", updatedAt: 1 } },
		} as never)

		// The stale per-view snapshot is dropped before storage: neither the shared
		// write nor the profile save may carry it back in.
		expect(setValues).toHaveBeenCalledWith(expect.not.objectContaining({ viewStates: expect.anything() }))
		expect(saveConfig).toHaveBeenCalledWith(
			"default",
			expect.not.objectContaining({ viewStates: expect.anything() }),
		)
	})

	it("persists every supplied mode API config mapping", async () => {
		const setValues = vi.fn().mockResolvedValue(undefined)
		const saveConfig = vi.fn().mockResolvedValue("default-id")
		const setModeConfig = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const provider = {
			context: {},
			on: vi.fn(),
			setValues,
			contextProxy: { setValues },
			providerSettingsManager: { saveConfig, setModeConfig },
			postStateToWebview,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		await api.setConfiguration({
			currentApiConfigName: "default",
			modeApiConfigs: { code: "code-config", architect: "architect-config" },
		})

		expect(saveConfig).toHaveBeenCalledWith("default", expect.objectContaining({ currentApiConfigName: "default" }))
		expect(setValues).toHaveBeenCalledWith(
			expect.objectContaining({
				currentApiConfigName: "default",
				modeApiConfigs: expect.anything(),
			}),
		)
		expect(setModeConfig).toHaveBeenCalledTimes(2)
		expect(setModeConfig).toHaveBeenCalledWith("code", "code-config")
		expect(setModeConfig).toHaveBeenCalledWith("architect", "architect-config")
		expect(postStateToWebview).toHaveBeenCalledOnce()
	})

	it("does not persist mode mappings when none are supplied", async () => {
		const setValues = vi.fn().mockResolvedValue(undefined)
		const saveConfig = vi.fn().mockResolvedValue("default-id")
		const setModeConfig = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const provider = {
			context: {},
			on: vi.fn(),
			setValues,
			contextProxy: { setValues },
			providerSettingsManager: { saveConfig, setModeConfig },
			postStateToWebview,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		await api.setConfiguration({ currentApiConfigName: "default" })

		expect(setModeConfig).not.toHaveBeenCalled()
		expect(postStateToWebview).toHaveBeenCalledOnce()
	})

	it("flattens the nested view-local apiConfiguration and strips its secrets", () => {
		const getValues = vi.fn().mockReturnValue({
			mode: "architect",
			currentApiConfigName: "view-profile",
			apiConfiguration: {
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "openai/gpt-4o",
				apiKey: "nested-secret-key",
				openRouterApiKey: "nested-openrouter-secret",
			},
		})
		// Structural double: API.getConfiguration() only reads sidebarProvider.getValues()
		// from the provider; the double assertion adapts this minimal shape to the
		// constructor's ClineProvider parameter (same pattern as the tests above).
		const provider = {
			context: {},
			on: vi.fn(),
			getValues,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeUnusedTabFactory())

		const configuration = api.getConfiguration()

		expect(getValues).toHaveBeenCalledOnce()
		expect(configuration.mode).toBe("architect")
		expect(configuration.currentApiConfigName).toBe("view-profile")
		expect(configuration.apiProvider).toBe(providerIdentifiers.openrouter)
		expect(configuration.openRouterModelId).toBe("openai/gpt-4o")
		expect(configuration).not.toHaveProperty("apiConfiguration")
		expect(configuration).not.toHaveProperty("apiKey")
		expect(configuration).not.toHaveProperty("openRouterApiKey")
	})

	it("drops shared flat provider settings when a view-local profile is present", () => {
		const getValues = vi.fn().mockReturnValue({
			mode: "code",
			currentApiConfigName: "view-profile",
			// Flat provider keys belonging to whichever profile owns the shared store.
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "claude-sonnet-4-5",
			anthropicBaseUrl: "https://shared.example/v1",
			// A non-provider shared setting: must survive the strip.
			customInstructions: "keep me",
			apiConfiguration: {
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "openai/gpt-4o",
			},
		})
		// Structural double: API.getConfiguration() only reads sidebarProvider.getValues()
		// from the provider; the double assertion adapts this minimal shape to the
		// constructor's ClineProvider parameter (same pattern as the tests above).
		const provider = {
			context: {},
			on: vi.fn(),
			getValues,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		const configuration = api.getConfiguration()

		// The view-local snapshot wins outright; the shared store's provider keys
		// the profile never defined must not leak through.
		expect(configuration.apiProvider).toBe(providerIdentifiers.openrouter)
		expect(configuration.apiModelId).toBeUndefined()
		expect(configuration.anthropicBaseUrl).toBeUndefined()
		expect(configuration.openRouterModelId).toBe("openai/gpt-4o")
		expect(configuration.customInstructions).toBe("keep me")
		expect(configuration.mode).toBe("code")
		expect(configuration.currentApiConfigName).toBe("view-profile")
	})

	it("falls back to the shared provider when a view-local profile pins none", () => {
		const getValues = vi.fn().mockReturnValue({
			mode: "code",
			currentApiConfigName: "view-profile",
			// The shared store's provider selection: a legacy/partial pinned
			// profile carries no apiProvider, and getState() falls back to this.
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "claude-sonnet-4-5",
			anthropicBaseUrl: "https://shared.example/v1",
			apiConfiguration: {
				apiModelId: "gpt-4o",
			},
		})
		// Structural double: API.getConfiguration() only reads sidebarProvider.getValues()
		// from the provider; the double assertion adapts this minimal shape to the
		// constructor's ClineProvider parameter (same pattern as the tests above).
		const provider = {
			context: {},
			on: vi.fn(),
			getValues,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		const configuration = api.getConfiguration()

		// The shared provider survives as the fallback (matching getState()),
		// while every other shared provider-setting key stays stripped.
		expect(configuration.apiProvider).toBe(providerIdentifiers.anthropic)
		expect(configuration.apiModelId).toBe("gpt-4o")
		expect(configuration.anthropicBaseUrl).toBeUndefined()
	})

	it("falls back to the shared provider when a view-local profile sets apiProvider to undefined", () => {
		const getValues = vi.fn().mockReturnValue({
			mode: "code",
			currentApiConfigName: "view-profile",
			apiProvider: providerIdentifiers.anthropic,
			// Explicit undefined in the nested profile: the flatten spread must not
			// let it clobber the retained shared fallback (getState() uses ??).
			apiConfiguration: {
				apiProvider: undefined,
				apiModelId: "gpt-4o",
			},
		})
		// Structural double: API.getConfiguration() only reads sidebarProvider.getValues()
		// from the provider; the double assertion adapts this minimal shape to the
		// constructor's ClineProvider parameter (same pattern as the tests above).
		const provider = {
			context: {},
			on: vi.fn(),
			getValues,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		const configuration = api.getConfiguration()

		expect(configuration.apiProvider).toBe(providerIdentifiers.anthropic)
		expect(configuration.apiModelId).toBe("gpt-4o")
	})

	it("omits credential-bearing keys that SECRET_STATE_KEYS does not name", () => {
		const getValues = vi.fn().mockReturnValue({
			mode: "code",
			currentApiConfigName: "view-profile",
			apiConfiguration: {
				apiProvider: providerIdentifiers.openai,
				apiKey: "sk-secret",
				openAiHeaders: { Authorization: "Bearer header-token" },
				vertexJsonCredentials: JSON.stringify({ token: "svc" }),
				vertexKeyFile: "C:/secrets/vertex.json",
				zooSessionToken: "zoo-session-token",
				mimoApiKey: "mimo-key",
				poeApiKey: "poe-key",
				qwenCodeOauthPath: "C:/secrets/qwen-oauth.json",
				geminiCliOAuthPath: "C:/secrets/gemini-oauth.json",
				modelTemperature: 0.5,
			},
		})
		// Structural double: API.getConfiguration() only reads sidebarProvider.getValues()
		// from the provider; the double assertion adapts this minimal shape to the
		// constructor's ClineProvider parameter (same pattern as the tests above).
		const provider = {
			context: {},
			on: vi.fn(),
			getValues,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		const configuration = api.getConfiguration()

		expect(configuration.apiKey).toBeUndefined()
		expect(configuration.openAiHeaders).toBeUndefined()
		expect(configuration.vertexJsonCredentials).toBeUndefined()
		expect(configuration.vertexKeyFile).toBeUndefined()
		expect(configuration.zooSessionToken).toBeUndefined()
		expect(configuration.mimoApiKey).toBeUndefined()
		expect(configuration.poeApiKey).toBeUndefined()
		expect(configuration.qwenCodeOauthPath).toBeUndefined()
		expect(configuration.geminiCliOAuthPath).toBeUndefined()
		expect(configuration.modelTemperature).toBe(0.5)
		expect(configuration.apiProvider).toBe(providerIdentifiers.openai)
	})

	it("keeps shared flat provider settings when no view-local profile is present", () => {
		const getValues = vi.fn().mockReturnValue({
			mode: "code",
			currentApiConfigName: "shared-profile",
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "claude-sonnet-4-5",
		})
		// Structural double: same pattern as the tests above.
		const provider = {
			context: {},
			on: vi.fn(),
			getValues,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		const configuration = api.getConfiguration()

		expect(configuration.apiProvider).toBe(providerIdentifiers.anthropic)
		expect(configuration.apiModelId).toBe("claude-sonnet-4-5")
	})
})
