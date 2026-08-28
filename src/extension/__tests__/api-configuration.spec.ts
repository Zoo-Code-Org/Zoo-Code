import { describe, expect, it, vi } from "vitest"
import type * as vscode from "vscode"

import { API } from "../api"
import type { ClineProvider } from "../../core/webview/ClineProvider"

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
			setValues,
			contextProxy: { setValues },
			providerSettingsManager: { saveConfig, setModeConfig },
			postStateToWebview,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider)

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
		const api = new API(outputChannel, provider)

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
		const api = new API(outputChannel, provider)

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
})
