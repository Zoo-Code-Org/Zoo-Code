import { describe, expect, it, vi } from "vitest"
import type * as vscode from "vscode"

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
			setValues,
			contextProxy: { setValues, getProviderSettings: vi.fn().mockReturnValue({}) },
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
			// The payload saves this profile: siblings pinned to it are refreshed
			// from the payload instead of pinned to a pre-save snapshot.
			{ savedProfileName: "default" },
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
			contextProxy: { setValues, getProviderSettings: vi.fn().mockReturnValue({}) },
			providerSettingsManager: { saveConfig, setModeConfig },
			postStateToWebview,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		await api.setConfiguration({ currentApiConfigName: "default" })

		expect(setModeConfig).not.toHaveBeenCalled()
		expect(postStateToWebview).toHaveBeenCalledOnce()
	})
	it("does not refresh shared settings or sibling overlays when the profile save rejects", async () => {
		const setValues = vi.fn().mockResolvedValue(undefined)
		const saveConfig = vi.fn().mockRejectedValue(new Error("invalid profile"))
		const setModeConfig = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const provider = {
			context: {},
			on: vi.fn(),
			setValues,
			contextProxy: { setValues, getProviderSettings: vi.fn().mockReturnValue({}) },
			providerSettingsManager: { saveConfig, setModeConfig },
			postStateToWebview,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		await expect(api.setConfiguration({ currentApiConfigName: "pinned" })).rejects.toThrow("invalid profile")

		// saveConfig validates before storing: a rejected save must leave the
		// shared settings and the sibling overlays pinned to the profile
		// untouched, so no sibling serves settings the stored profile lacks.
		expect(setValues).not.toHaveBeenCalled()
		expect(postStateToWebview).not.toHaveBeenCalled()
	})
	it("restores the stored profile and shared settings when the refresh fails after the save", async () => {
		const setValues = vi.fn().mockRejectedValue(new Error("refresh down"))
		const saveConfig = vi.fn().mockResolvedValue("pinned-id")
		const deleteConfig = vi.fn().mockResolvedValue(undefined)
		const setModeConfig = vi.fn().mockResolvedValue(undefined)
		const setProviderSettings = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const sharedBefore = { currentApiConfigName: "old-shared" }
		const provider = {
			context: {},
			on: vi.fn(),
			setValues,
			contextProxy: {
				setValues,
				getProviderSettings: vi.fn().mockReturnValue(sharedBefore),
				setProviderSettings,
			},
			providerSettingsManager: {
				saveConfig,
				deleteConfig,
				setModeConfig,
				// The profile did not exist before this call: compensation must
				// delete the record the save created, not restore an old one.
				getProfile: vi.fn().mockRejectedValue(new Error("profile absent")),
			},
			postStateToWebview,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		await expect(api.setConfiguration({ currentApiConfigName: "pinned" })).rejects.toThrow("refresh down")

		// The save landed but the shared/sibling refresh rejected: the round trip
		// is one transaction, so the created record is deleted and the shared
		// provider settings are restored before the caller sees the failure.
		expect(saveConfig).toHaveBeenCalledWith("pinned", expect.objectContaining({ currentApiConfigName: "pinned" }))
		expect(deleteConfig).toHaveBeenCalledWith("pinned")
		expect(setProviderSettings).toHaveBeenCalledWith(sharedBefore)
		expect(postStateToWebview).not.toHaveBeenCalled()
	})
})
