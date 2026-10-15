import { describe, expect, it, vi } from "vitest"
import { makeClineProviderFactory } from "../../test-utils/provider"

import { providerIdentifiers } from "@roo-code/types"

import { API } from "../api"
import type { ClineProvider } from "../../core/webview/ClineProvider"
import type { OutputChannel } from "vscode"

vi.mock("@roo-code/ipc", () => ({
	IpcServer: class {},
}))

vi.mock("../../integrations/terminal/Terminal", () => ({
	Terminal: {
		getTerminalProfile: vi.fn(),
		setTerminalProfile: vi.fn(),
	},
}))

vi.mock("../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: {
		closeIdleTerminals: vi.fn(),
	},
}))

describe("API.setConfiguration", () => {
	it("routes configuration through ClineProvider.setValues so view-local state stays in sync", async () => {
		const provider = Object.assign({} as ClineProvider, {
			context: {},
			on: vi.fn(),
			setValues: vi.fn().mockResolvedValue(undefined),
			getValue: vi.fn(),
			contextProxy: {
				setValues: vi.fn().mockResolvedValue(undefined),
			},
			providerSettingsManager: {
				saveConfig: vi.fn().mockResolvedValue("default-id"),
				getProfile: vi.fn().mockRejectedValue(new Error("profile not found")),
			},
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		})
		const api = new API(
			Object.assign({} as OutputChannel, { appendLine: vi.fn() }),
			provider,
			makeClineProviderFactory(),
		)
		const configuration = {
			apiProvider: providerIdentifiers.bedrock,
			currentApiConfigName: "default",
			awsRegion: "us-east-1",
			apiModelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
		}

		await api.setConfiguration(configuration)

		// Exact side-effect counts: a regression that repeats any of these operations
		// (duplicate settings write, duplicate profile save, duplicate webview post) fails.
		expect(provider.setValues).toHaveBeenCalledTimes(1)
		expect(provider.setValues).toHaveBeenCalledWith(configuration)
		expect(provider.contextProxy.setValues).not.toHaveBeenCalled()
		expect(provider.providerSettingsManager.saveConfig).toHaveBeenCalledTimes(1)
		expect(provider.providerSettingsManager.saveConfig).toHaveBeenCalledWith("default", configuration)
		expect(provider.postStateToWebview).toHaveBeenCalledTimes(1)
	})

	it("compensates the landed writes when a later write fails", async () => {
		const provider = Object.assign({} as ClineProvider, {
			context: {},
			on: vi.fn(),
			getValue: vi.fn((key: string) => (key === "currentApiConfigName" ? "old-name" : undefined)),
			setValues: vi.fn().mockResolvedValue(undefined),
			contextProxy: {
				setValues: vi.fn().mockResolvedValue(undefined),
			},
			providerSettingsManager: {
				getProfile: vi.fn().mockRejectedValue(new Error("profile not found")),
				getModeConfigId: vi.fn().mockResolvedValue("old-mode-id"),
				saveConfig: vi.fn().mockResolvedValue("default-id"),
				setModeConfig: vi.fn().mockRejectedValue(new Error("mode write failed")),
				deleteConfig: vi.fn().mockResolvedValue(undefined),
			},
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		})
		const api = new API(
			Object.assign({} as OutputChannel, { appendLine: vi.fn() }),
			provider,
			makeClineProviderFactory(),
		)

		await expect(
			api.setConfiguration({
				currentApiConfigName: "default",
				apiProvider: providerIdentifiers.openai,
				modeApiConfigs: { code: "new-id" },
			}),
		).rejects.toThrow("mode write failed")

		// Every landed write is undone: the mode mapping returns to its prior id, the
		// profile this call created is removed (it did not exist before), and the
		// shared values are restored through the same provider setter.
		expect(provider.providerSettingsManager.setModeConfig).toHaveBeenCalledWith("code", "old-mode-id")
		expect(provider.providerSettingsManager.deleteConfig).toHaveBeenCalledWith("default")
		expect(provider.setValues).toHaveBeenCalledTimes(2)
		expect(provider.setValues.mock.calls[1][0]).toEqual({
			currentApiConfigName: "old-name",
			apiProvider: undefined,
			modeApiConfigs: undefined,
		})
		expect(provider.postStateToWebview).not.toHaveBeenCalled()
	})
})
