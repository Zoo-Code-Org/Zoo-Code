import { describe, expect, it, vi } from "vitest"
import type * as vscode from "vscode"

import { providerIdentifiers } from "@roo-code/types"

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
			getProviderProfileEntries: vi.fn().mockReturnValue([]),
			getValues: vi.fn().mockReturnValue({}),
			setValues,
			contextProxy: {
				getValue: vi.fn().mockReturnValue(undefined),
				setValues,
				getProviderSettings: vi.fn().mockReturnValue({}),
			},
			providerSettingsManager: {
				saveConfig,
				setModeConfig,
				hasConfig: vi.fn().mockResolvedValue(false),
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
			},
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
			getProviderProfileEntries: vi.fn().mockReturnValue([]),
			getValues: vi.fn().mockReturnValue({}),
			setValues,
			contextProxy: {
				getValue: vi.fn().mockReturnValue(undefined),
				setValues,
				getProviderSettings: vi.fn().mockReturnValue({}),
			},
			providerSettingsManager: {
				saveConfig,
				setModeConfig,
				hasConfig: vi.fn().mockResolvedValue(false),
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
			},
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
		const deleteConfig = vi.fn().mockResolvedValue(undefined)
		const setModeConfig = vi.fn().mockResolvedValue(undefined)
		const setProviderSettings = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const provider = {
			context: {},
			on: vi.fn(),
			getProviderProfileEntries: vi.fn().mockReturnValue([]),
			getValues: vi.fn().mockReturnValue({}),
			setValues,
			contextProxy: {
				getValue: vi.fn().mockReturnValue(undefined),
				setValues,
				getProviderSettings: vi.fn().mockReturnValue({}),
				setProviderSettings,
			},
			providerSettingsManager: {
				saveConfig,
				deleteConfig,
				setModeConfig,
				hasConfig: vi.fn().mockResolvedValue(false),
			},
			postStateToWebview,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		await expect(api.setConfiguration({ currentApiConfigName: "pinned" })).rejects.toThrow("invalid profile")

		// saveConfig validates before storing: a rejected save must leave the
		// shared settings and the sibling overlays pinned to the profile
		// untouched, so no sibling serves settings the stored profile lacks.
		expect(setValues).not.toHaveBeenCalled()
		// saveConfig validates before storing: a rejected save wrote nothing, so
		// rollback must not run at all - no delete, no shared-settings restore.
		expect(deleteConfig).not.toHaveBeenCalled()
		expect(setProviderSettings).not.toHaveBeenCalled()
		expect(postStateToWebview).not.toHaveBeenCalled()
	})
	it("restores the stored profile and shared settings when the refresh fails after the save", async () => {
		const setValues = vi.fn().mockRejectedValue(new Error("refresh down"))
		const saveConfig = vi.fn().mockResolvedValue("pinned-id")
		const deleteConfig = vi.fn().mockResolvedValue(undefined)
		const setModeConfig = vi.fn().mockResolvedValue(undefined)
		const setProviderSettings = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		// Real provider-setting keys: getProviderSettings only returns
		// PROVIDER_SETTINGS_KEYS, so the restore assertion must use provider keys.
		const sharedBefore = { apiProvider: providerIdentifiers.anthropic, apiModelId: "model-old" }
		const provider = {
			context: {},
			on: vi.fn(),
			getProviderProfileEntries: vi.fn().mockReturnValue([]),
			getValues: vi.fn().mockReturnValue({}),
			setValues,
			contextProxy: {
				getValue: vi.fn().mockReturnValue(undefined),
				setValues,
				getProviderSettings: vi.fn().mockReturnValue(sharedBefore),
				setProviderSettings,
			},
			providerSettingsManager: {
				saveConfig,
				deleteConfig,
				setModeConfig,
				// Existence is read from the store: the profile did not exist before this
				// call, so compensation must delete the record the save created.
				hasConfig: vi.fn().mockResolvedValue(false),
				getProfile: vi.fn(),
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

	// Rollback regression: getConfiguration() merges this view's overlay, so its mode and pin
	// are not the shared values the rollback should put back for every other view.
	it("restores the shared mode and profile pin from shared state, not this view's overlay", async () => {
		// Both the failing refresh and the compensation replay go through provider.setValues, and the
		// shared-pair restore goes through contextProxy.setValues: tag every call so the test can
		// assert the order of the two channels, not merely that each one happened.
		const writeOrder: string[] = []
		const setValues = vi.fn().mockImplementation(() => {
			writeOrder.push("provider.setValues")
			return Promise.reject(new Error("refresh down"))
		})
		const sharedSetValues = vi.fn().mockImplementation(() => {
			writeOrder.push("contextProxy.setValues")
			return Promise.resolve(undefined)
		})
		const saveConfig = vi.fn().mockResolvedValue("pinned-id")
		const deleteConfig = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		// The shared store carries one mode and pin; this view's overlay carries another, and
		// getConfiguration() - which the rollback replays - merges the overlay over shared state.
		const sharedBefore = { mode: "code", currentApiConfigName: "shared-profile" }
		const mergedBefore = { mode: "programmer", currentApiConfigName: "view-pinned-profile" }
		const provider = {
			context: {},
			on: vi.fn(),
			getProviderProfileEntries: vi.fn().mockReturnValue([]),
			getValues: vi.fn().mockReturnValue(mergedBefore),
			setValues,
			contextProxy: {
				getValue: vi.fn((key: string) => sharedBefore[key as keyof typeof sharedBefore]),
				setValues: sharedSetValues,
				getProviderSettings: vi.fn().mockReturnValue({}),
				setProviderSettings: vi.fn().mockResolvedValue(undefined),
			},
			providerSettingsManager: {
				saveConfig,
				deleteConfig,
				setModeConfig: vi.fn().mockResolvedValue(undefined),
				// The profile did not exist before this call: compensation deletes the record the
				// save created, which keeps the focus here on the settings restore.
				hasConfig: vi.fn().mockResolvedValue(false),
				getProfile: vi.fn(),
			},
			postStateToWebview,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		await expect(api.setConfiguration({ currentApiConfigName: "pinned", mode: "architect" })).rejects.toThrow(
			"refresh down",
		)

		// The replayed configuration carries this view's own mode and pin - that is the merged
		// copy, and the per-view half of the restore needs it.
		expect(setValues).toHaveBeenCalledWith(
			expect.objectContaining({ mode: "programmer", currentApiConfigName: "view-pinned-profile" }),
			expect.anything(),
		)
		// The shared pair is restored from the pre-write shared snapshot instead, after that
		// replay, so other unpinned views end on the mode and profile they had before this call
		// rather than on this view's.
		expect(sharedSetValues).toHaveBeenCalledWith({ mode: "code", currentApiConfigName: "shared-profile" })
		// Order is the fix, and presence alone cannot prove it. The replay above writes this view’s
		// merged mode and pin into the shared store; the shared pair must be written after that
		// replay, so moving the shared restore earlier - where the replay would overwrite it -
		// fails here instead of leaving every unpinned view on this view’s mode and profile.
		expect(writeOrder.filter((entry) => entry === "provider.setValues").length).toBe(2)
		expect(writeOrder.indexOf("contextProxy.setValues")).toBeGreaterThan(
			writeOrder.lastIndexOf("provider.setValues"),
		)
		expect(postStateToWebview).not.toHaveBeenCalled()
	})
	it("restores the previous record when rolling back a save over an existing profile", async () => {
		// The shared refresh succeeds and the mode fan-out fails: the overlays
		// pinned to the saved profile already hold the new settings, so rollback
		// must replay the restored record to those overlays as well.
		const setValues = vi.fn().mockResolvedValue(undefined)
		const saveConfig = vi.fn().mockResolvedValue("pinned-id")
		const deleteConfig = vi.fn().mockResolvedValue(undefined)
		const setModeConfig = vi.fn().mockRejectedValue(new Error("mode write failed"))
		const refreshSpy = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const previousRecord = {
			name: "pinned",
			id: "pinned-id",
			apiProvider: providerIdentifiers.anthropic,
			apiKey: "old-key",
		}
		const provider = {
			context: {},
			on: vi.fn(),
			// The profile entry exists before the call: rollback must restore the
			// prior record, never delete the profile.
			getProviderProfileEntries: vi.fn().mockReturnValue([{ name: "pinned", id: "pinned-id" }]),
			getValues: vi.fn().mockReturnValue({}),
			setValues,
			contextProxy: {
				getValue: vi.fn().mockReturnValue(undefined),
				setValues,
				getProviderSettings: vi.fn().mockReturnValue({ apiProvider: providerIdentifiers.anthropic }),
				setProviderSettings: vi.fn().mockResolvedValue(undefined),
			},
			refreshViewLocalStateForUpdatedProfile: refreshSpy,
			providerSettingsManager: {
				saveConfig,
				deleteConfig,
				hasConfig: vi.fn().mockResolvedValue(true),
				getProfile: vi.fn().mockResolvedValue(previousRecord),
				setModeConfig,
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
			},
			postStateToWebview,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		await expect(
			api.setConfiguration({ currentApiConfigName: "pinned", modeApiConfigs: { code: "new-code-config" } }),
		).rejects.toThrow("mode write failed")

		// Rollback restores the prior record (minus name/id bookkeeping) instead of
		// deleting the profile that existed before the call, and replays it to the
		// sibling overlays pinned to the saved profile.
		expect(saveConfig).toHaveBeenLastCalledWith("pinned", expect.objectContaining({ apiKey: "old-key" }))
		expect(deleteConfig).not.toHaveBeenCalled()
		expect(refreshSpy).toHaveBeenCalledWith("pinned", expect.objectContaining({ apiKey: "old-key" }))
		expect(postStateToWebview).not.toHaveBeenCalled()
	})

	it("rolls back the complete mutation when a mode mapping write fails", async () => {
		const setValues = vi.fn().mockResolvedValue(undefined)
		const saveConfig = vi.fn().mockResolvedValue("pinned-id")
		const deleteConfig = vi.fn().mockResolvedValue(undefined)
		const setModeConfig = vi.fn().mockRejectedValue(new Error("mode write failed"))
		const setProviderSettings = vi.fn().mockResolvedValue(undefined)
		// The shared-pair restore below writes the shared store directly, so it gets its own
		// spy and cannot disturb the last-call assertion on the configuration round trip.
		const sharedSetValues = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const sharedBefore = { apiProvider: providerIdentifiers.anthropic, apiModelId: "model-old" }
		const provider = {
			context: {},
			on: vi.fn(),
			getProviderProfileEntries: vi.fn().mockReturnValue([]),
			getValues: vi.fn().mockReturnValue({ currentApiConfigName: "old-profile" }),
			setValues,
			contextProxy: {
				getValue: vi.fn().mockReturnValue(undefined),
				setValues: sharedSetValues,
				getProviderSettings: vi.fn().mockReturnValue(sharedBefore),
				setProviderSettings,
			},
			refreshViewLocalStateForUpdatedProfile: vi.fn().mockResolvedValue(undefined),
			providerSettingsManager: {
				saveConfig,
				deleteConfig,
				setModeConfig,
				// The profile did not exist before the call.
				hasConfig: vi.fn().mockResolvedValue(false),
				// The code mode had no mapping before: rollback must clear the
				// mapping this call created rather than leave it pointing at the
				// config the failed fan-out chose.
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
			},
			postStateToWebview,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		await expect(
			api.setConfiguration({ currentApiConfigName: "pinned", modeApiConfigs: { code: "new-code-config" } }),
		).rejects.toThrow("mode write failed")

		// The shared refresh had already succeeded when the mode write failed, so
		// rollback re-applies the complete prior configuration (global values,
		// view-local state, and sibling overlays), the shared provider settings,
		// deletes the record the save created, and restores the prior mode
		// mapping (undefined clears the mapping this call created).
		expect(setValues).toHaveBeenLastCalledWith(expect.objectContaining({ currentApiConfigName: "old-profile" }), {
			savedProfileName: "old-profile",
		})
		expect(setProviderSettings).toHaveBeenCalledWith(sharedBefore)
		expect(deleteConfig).toHaveBeenCalledWith("pinned")
		// The profile did not exist before: its overlay is restored to empty.
		expect(provider["refreshViewLocalStateForUpdatedProfile"]).toHaveBeenCalledWith("pinned", {})
		expect(setModeConfig).toHaveBeenLastCalledWith("code", undefined)
		expect(postStateToWebview).not.toHaveBeenCalled()
	})
	it("replays the restored overlay after the configuration restore for the active profile", async () => {
		const setValues = vi.fn().mockResolvedValue(undefined)
		const saveConfig = vi.fn().mockResolvedValue("pinned-id")
		const deleteConfig = vi.fn().mockResolvedValue(undefined)
		const setModeConfig = vi.fn().mockRejectedValue(new Error("mode write failed"))
		const refreshSpy = vi.fn().mockResolvedValue(undefined)
		// The shared-pair restore writes the shared store directly: give it its own spy so the
		// last-call assertion below still speaks about the configuration round trip.
		const sharedSetValues = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const previousRecord = {
			name: "pinned",
			id: "pinned-id",
			apiProvider: providerIdentifiers.anthropic,
			apiKey: "old-key",
		}
		const provider = {
			context: {},
			on: vi.fn(),
			getProviderProfileEntries: vi.fn().mockReturnValue([{ name: "pinned", id: "pinned-id" }]),
			// The saved profile is also the active profile: the configuration
			// restore refreshes the same pinned siblings, with non-secret values.
			getValues: vi.fn().mockReturnValue({ currentApiConfigName: "pinned" }),
			setValues,
			contextProxy: {
				getValue: vi.fn().mockReturnValue(undefined),
				setValues: sharedSetValues,
				getProviderSettings: vi.fn().mockReturnValue({ apiProvider: providerIdentifiers.anthropic }),
				setProviderSettings: vi.fn().mockResolvedValue(undefined),
			},
			refreshViewLocalStateForUpdatedProfile: refreshSpy,
			providerSettingsManager: {
				saveConfig,
				deleteConfig,
				hasConfig: vi.fn().mockResolvedValue(true),
				getProfile: vi.fn().mockResolvedValue(previousRecord),
				setModeConfig,
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
			},
			postStateToWebview,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		await expect(
			api.setConfiguration({ currentApiConfigName: "pinned", modeApiConfigs: { code: "new-code-config" } }),
		).rejects.toThrow("mode write failed")

		// The configuration restore refreshes the same pinned siblings with
		// non-secret values, so the overlay replay must run after it and be the
		// last refresh, ending the overlays on the restored record's settings.
		expect(setValues).toHaveBeenLastCalledWith(expect.objectContaining({ currentApiConfigName: "pinned" }), {
			savedProfileName: "pinned",
		})
		expect(refreshSpy.mock.invocationCallOrder[0]).toBeGreaterThan(setValues.mock.invocationCallOrder[1])
		expect(refreshSpy).toHaveBeenCalledWith("pinned", expect.objectContaining({ apiKey: "old-key" }))
	})
	it("preserves credentials in overlays pinned to a different previous profile", async () => {
		const setValues = vi.fn().mockResolvedValue(undefined)
		const saveConfig = vi.fn().mockResolvedValue("pinned-id")
		const deleteConfig = vi.fn().mockResolvedValue(undefined)
		const setModeConfig = vi.fn().mockRejectedValue(new Error("mode write failed"))
		const refreshSpy = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const pinnedRecord = {
			name: "pinned",
			id: "pinned-id",
			apiProvider: providerIdentifiers.anthropic,
			apiKey: "pinned-old-key",
		}
		const oldProfileRecord = {
			name: "old-profile",
			id: "old-id",
			apiProvider: providerIdentifiers.openrouter,
			apiKey: "old-profile-key",
		}
		const provider = {
			context: {},
			on: vi.fn(),
			getProviderProfileEntries: vi.fn().mockReturnValue([{ name: "pinned", id: "pinned-id" }]),
			// The mutation switched profiles: siblings pinned to the previous
			// profile were refreshed from non-secret values by the restore and
			// must be replayed from the previous profile's complete record.
			getValues: vi.fn().mockReturnValue({ currentApiConfigName: "old-profile" }),
			setValues,
			contextProxy: {
				getValue: vi.fn().mockReturnValue(undefined),
				setValues,
				getProviderSettings: vi.fn().mockReturnValue({ apiProvider: providerIdentifiers.anthropic }),
				setProviderSettings: vi.fn().mockResolvedValue(undefined),
			},
			refreshViewLocalStateForUpdatedProfile: refreshSpy,
			providerSettingsManager: {
				saveConfig,
				deleteConfig,
				hasConfig: vi.fn().mockResolvedValue(true),
				getProfile: vi
					.fn()
					.mockImplementation(({ name }: { name: string }) =>
						name === "pinned"
							? Promise.resolve(pinnedRecord)
							: name === "old-profile"
								? Promise.resolve(oldProfileRecord)
								: Promise.reject(new Error("profile absent")),
					),
				setModeConfig,
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
			},
			postStateToWebview,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		await expect(
			api.setConfiguration({ currentApiConfigName: "pinned", modeApiConfigs: { code: "new-code-config" } }),
		).rejects.toThrow("mode write failed")

		// Both pinned groups end on complete records: the saved profile's
		// overlays from the restored record, the previous profile's overlays from
		// its own stored record - not the credential-less non-secret snapshot.
		expect(refreshSpy).toHaveBeenCalledWith("pinned", expect.objectContaining({ apiKey: "pinned-old-key" }))
		expect(refreshSpy).toHaveBeenCalledWith("old-profile", expect.objectContaining({ apiKey: "old-profile-key" }))
		expect(postStateToWebview).not.toHaveBeenCalled()
	})
})
