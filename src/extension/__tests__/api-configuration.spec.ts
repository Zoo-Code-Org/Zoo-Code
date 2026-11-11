import { describe, expect, it, vi } from "vitest"
import type * as vscode from "vscode"

import { API } from "../api"
import { ClineProvider } from "../../core/webview/ClineProvider"
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
			contextProxy: { setValues },
			providerSettingsManager: {
				saveConfig,
				setModeConfig,
				listConfig: vi.fn().mockResolvedValue([
					{ name: "code", id: "code-config" },
					{ name: "custom", id: "architect-config" },
				]),
			},
			profileMutationAbortController: new AbortController(),
			modeProfileState: { reset: undefined, activeMutationSignals: new Set<AbortSignal>() },
			localModeConfigIds: new Map<string, string>(),
			modeConfigWriteOwners: new Map<string, symbol>(),
			modeConfigWrites: new Map<string, Promise<void>>(),
			initialModeConfigIds: Promise.resolve({}),
			setModeConfig: ClineProvider.prototype.setModeConfig,
			writeModeConfig: ClineProvider.prototype["writeModeConfig"],
			getModeConfigId: ClineProvider.prototype["getModeConfigId"],
			postStateToWebview,
			// Provides the configuration methods and event registration used by API.
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		await api.setConfiguration({
			currentApiConfigName: "default",
			modeApiConfigs: { code: "code-config", "new-custom-mode": "architect-config" },
		})

		expect(saveConfig).toHaveBeenCalledWith("default", expect.objectContaining({ currentApiConfigName: "default" }))
		expect(setValues).toHaveBeenCalledWith(
			expect.objectContaining({
				currentApiConfigName: "default",
				modeApiConfigs: expect.anything(),
			}),
		)
		expect(setModeConfig).toHaveBeenCalledTimes(2)
		expect(setModeConfig).toHaveBeenCalledWith("code", "code-config", expect.any(Function), expect.any(AbortSignal))
		expect(setModeConfig).toHaveBeenCalledWith(
			"new-custom-mode",
			"architect-config",
			expect.any(Function),
			expect.any(AbortSignal),
		)
		await expect(provider["getModeConfigId"]("code")).resolves.toBe("code-config")
		await expect(provider["getModeConfigId"]("new-custom-mode")).resolves.toBe("architect-config")
		expect(postStateToWebview).toHaveBeenCalledOnce()
	})

	it("reports partial persistence after all mode writes settle when reset cancels a mapping", async () => {
		const setValues = vi.fn().mockResolvedValue(undefined)
		const saveConfig = vi.fn().mockResolvedValue("default-id")
		let release = () => {}
		const pending = new Promise<void>((resolve) => {
			release = resolve
		})
		const setModeConfig = vi
			.fn()
			.mockRejectedValueOnce(new Error("Mode profile write cancelled by settings reset"))
			.mockImplementationOnce(async () => {
				await pending
			})
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		// Supplies configuration persistence, profile storage, and the event hook used by API.
		const provider = {
			context: {},
			on: vi.fn(),
			contextProxy: { setValues },
			providerSettingsManager: { saveConfig },
			setModeConfig,
			postStateToWebview,
		} as unknown as ClineProvider
		// API only appends log lines to this output double.
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())
		const outcomes: string[] = []
		const updated = api
			.setConfiguration({
				currentApiConfigName: "default",
				modeApiConfigs: { code: "code-id", architect: "architect-id" },
			})
			.finally(() => {
				outcomes.push("settled")
			})
		const failed = expect(updated).rejects.toThrow("Configuration update may be partially persisted")
		await vi.waitFor(() => expect(setModeConfig).toHaveBeenCalledTimes(2))
		expect(setValues).toHaveBeenCalledOnce()
		expect(saveConfig).toHaveBeenCalledOnce()
		expect(outcomes).toEqual([])
		release()
		await failed

		expect(postStateToWebview).not.toHaveBeenCalled()
	})

	it("does not persist mode mappings when none are supplied", async () => {
		const setValues = vi.fn().mockResolvedValue(undefined)
		const saveConfig = vi.fn().mockResolvedValue("default-id")
		const setModeConfig = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const provider = {
			context: {},
			on: vi.fn(),
			contextProxy: { setValues },
			providerSettingsManager: { saveConfig },
			setModeConfig,
			postStateToWebview,
			// Provides the configuration methods and event registration used by API.
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		await api.setConfiguration({ currentApiConfigName: "default" })

		expect(setModeConfig).not.toHaveBeenCalled()
		expect(postStateToWebview).toHaveBeenCalledOnce()
	})
})
