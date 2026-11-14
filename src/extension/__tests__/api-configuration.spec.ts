import { describe, expect, it, vi } from "vitest"
import type * as vscode from "vscode"

import { providerIdentifiers, type ProviderSettings, type RooCodeSettings } from "@roo-code/types"

import { API } from "../api"
import type { ClineProvider } from "../../core/webview/ClineProvider"
import { makeClineProviderFactory } from "../../test-utils/provider"

vi.mock("@roo-code/ipc", () => ({
	IpcServer: class {},
}))

describe("API - configuration", () => {
	it("persists every supplied mode API config mapping", async () => {
		const setValues = vi.fn().mockResolvedValue(undefined)
		const saveConfig = vi.fn().mockResolvedValue("default-id")
		const setModeConfig = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const provider = {
			context: {},
			on: vi.fn(),
			log: vi.fn(),
			contextProxy: { setValues },
			providerSettingsManager: { saveConfig },
			setModeConfig,
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

	it("strips provider secrets nested inside the configuration it hands out", () => {
		const apiConfiguration: ProviderSettings = {
			apiProvider: providerIdentifiers.openrouter,
			openRouterModelId: "model-x",
			openRouterBaseUrl: "https://example.test/v1",
			openRouterApiKey: "nested-secret-value",
		}
		const getValues = vi.fn().mockReturnValue({
			currentApiConfigName: "my-profile",
			apiConfiguration,
			openRouterApiKey: "top-level-secret",
			openAiApiKey: "second-top-level-secret",
			alwaysAllowReadOnly: true,
		})
		const provider = {
			context: {},
			on: vi.fn(),
			log: vi.fn(),
			getValues,
			contextProxy: { setValues: vi.fn().mockResolvedValue(undefined) },
			providerSettingsManager: { saveConfig: vi.fn(), setModeConfig: vi.fn() },
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		// The public signature says RooCodeSettings; the runtime value also carries the view profile
		// buffer under apiConfiguration, which is what this test is about.
		const configuration: RooCodeSettings & { apiConfiguration?: ProviderSettings } = api.getConfiguration()

		// The names filtered here are names a profile carries: SECRET_STATE_KEYS are keys of
		// ProviderSettings (SecretState in packages/types/src/global-settings.ts), so a profile saved with
		// one of them used to be readable through the public API even though the top-level key of the same
		// name was filtered out.
		expect(configuration["openRouterApiKey"]).toBeUndefined()
		expect(configuration["openAiApiKey"]).toBeUndefined()
		expect(configuration.alwaysAllowReadOnly).toBe(true)
		expect(configuration.currentApiConfigName).toBe("my-profile")
		expect(configuration.apiConfiguration).toEqual({
			apiProvider: providerIdentifiers.openrouter,
			openRouterModelId: "model-x",
			openRouterBaseUrl: "https://example.test/v1",
		})
		expect(JSON.stringify(configuration.apiConfiguration)).not.toContain("nested-secret-value")
		expect(getValues).toHaveBeenCalledOnce()
	})

	it("hands back the same nested configuration object when it holds no secret", () => {
		const apiConfiguration: ProviderSettings = {
			apiProvider: providerIdentifiers.openrouter,
			openRouterModelId: "model-x",
		}
		const getValues = vi.fn().mockReturnValue({ currentApiConfigName: "my-profile", apiConfiguration })
		const provider = {
			context: {},
			on: vi.fn(),
			log: vi.fn(),
			getValues,
			contextProxy: { setValues: vi.fn().mockResolvedValue(undefined) },
			providerSettingsManager: { saveConfig: vi.fn(), setModeConfig: vi.fn() },
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		const configuration: RooCodeSettings & { apiConfiguration?: ProviderSettings } = api.getConfiguration()

		// A reader comparing the configuration it received against the object the provider holds is not
		// disturbed by a call that had nothing to strip.
		expect(configuration.apiConfiguration).toBe(apiConfiguration)
	})

	it("keeps the per-view state record out of the configuration it hands out", () => {
		const getValues = vi.fn().mockReturnValue({
			currentApiConfigName: "my-profile",
			viewStates: { "view-a": { mode: "code" }, "view-b": { mode: "architect" } },
			alwaysAllowReadOnly: true,
		})
		const provider = {
			context: {},
			on: vi.fn(),
			log: vi.fn(),
			getValues,
			contextProxy: { setValues: vi.fn().mockResolvedValue(undefined) },
			providerSettingsManager: { saveConfig: vi.fn(), setModeConfig: vi.fn() },
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		const configuration = api.getConfiguration()

		// The record is this machine's map of every view's buffer, not a setting: an extension holding
		// the API must not be handed it as configuration, and the rest of the settings bag still comes
		// through unchanged.
		expect(configuration).not.toHaveProperty("viewStates")
		expect(configuration.currentApiConfigName).toBe("my-profile")
		expect(configuration.alwaysAllowReadOnly).toBe(true)
		expect(getValues).toHaveBeenCalledOnce()
	})

	it("does not persist mode mappings when none are supplied", async () => {
		const setValues = vi.fn().mockResolvedValue(undefined)
		const saveConfig = vi.fn().mockResolvedValue("default-id")
		const setModeConfig = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const provider = {
			context: {},
			on: vi.fn(),
			log: vi.fn(),
			contextProxy: { setValues },
			providerSettingsManager: { saveConfig },
			setModeConfig,
			postStateToWebview,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		await api.setConfiguration({ currentApiConfigName: "default" })

		expect(setModeConfig).not.toHaveBeenCalled()
		expect(postStateToWebview).toHaveBeenCalledOnce()
	})

	describe("the display settings", () => {
		const setup = () => {
			const setValues = vi.fn().mockResolvedValue(undefined)
			const log = vi.fn()
			const provider = {
				context: {},
				on: vi.fn(),
				log,
				contextProxy: { setValues },
				providerSettingsManager: {
					saveConfig: vi.fn().mockResolvedValue("default-id"),
					setModeConfig: vi.fn(),
				},
				postStateToWebview: vi.fn().mockResolvedValue(undefined),
			} as unknown as ClineProvider
			const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
			return { api: new API(outputChannel, provider, makeClineProviderFactory()), setValues, log }
		}

		it.each([
			["timeFormat", "24h"],
			["dateFormat", "ymd"],
			["showRelativeTimes", false],
		])("stores a valid %s = %j", async (key, value) => {
			const { api, setValues, log } = setup()

			await api.setConfiguration({ [key]: value })

			expect(setValues).toHaveBeenCalledWith({ [key]: value })
			expect(log).not.toHaveBeenCalled()
		})

		it("rejects when a setting cannot be stored, and writes nothing after the settings", async () => {
			const { api, setValues } = setup()
			setValues.mockRejectedValue(new Error("storage unavailable"))
			const provider = api["sidebarProvider"]

			await expect(api.setConfiguration({ timeFormat: "24h", currentApiConfigName: "default" })).rejects.toThrow(
				"storage unavailable",
			)

			expect(provider.providerSettingsManager.saveConfig).not.toHaveBeenCalled()
			expect(provider.postStateToWebview).not.toHaveBeenCalled()
		})

		it.each([
			["timeFormat", "13h"],
			["dateFormat", "dd/mm"],
			["showRelativeTimes", "yes"],
		])("ignores an invalid %s = %j, and keeps the other values", async (key, value) => {
			const { api, setValues, log } = setup()

			// A hand-written value that the typed signature does not allow.
			await api.setConfiguration({ [key]: value, soundEnabled: true } as unknown as RooCodeSettings)

			expect(setValues).toHaveBeenCalledWith({ soundEnabled: true })
			expect(log).toHaveBeenCalledWith(`[setConfiguration] Ignored an invalid value for ${key}`)
		})
	})
})
