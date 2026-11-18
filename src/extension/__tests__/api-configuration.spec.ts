import { describe, expect, it, vi } from "vitest"
import type * as vscode from "vscode"

import { providerIdentifiers } from "@roo-code/types"
import type { RooCodeSettings } from "@roo-code/types"

import { API } from "../api"
import { ClineProvider } from "../../core/webview/ClineProvider"
import type { Mode } from "../../shared/modes"
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

// A manager double runs a cross-instance critical section inline, which is what the real queue
// does whenever no other view holds it. The queue itself is exercised by the interleaving test
// below, which installs its own.
const runManagerSectionInline = <T>(cb: () => Promise<T>): Promise<T> => cb()

// The manager double for the profile store: hasConfig, getProfile, saveConfig and deleteConfig all
// read and write one map, so the existence re-read that the compensation runs inside the critical
// section sees the record this call saved - which is what the section orders in production. A
// static hasConfig mock cannot model that: it answers "absent" both before the save and after it.
const makeProfileStoreDouble = (seed: Record<string, { id: string; settings: Record<string, unknown> }> = {}) => {
	const entries = new Map(Object.entries(seed))
	const hasConfig = vi.fn((name: string) => Promise.resolve(entries.has(name)))
	const getProfile = vi.fn(({ name }: { name: string }) => {
		const entry = entries.get(name)
		if (!entry) {
			return Promise.reject(new Error(`Profile "${name}" does not exist`))
		}
		return Promise.resolve({ name, id: entry.id, ...entry.settings })
	})
	const saveConfig = vi.fn((name: string, settings: Record<string, unknown>) => {
		const id = entries.get(name)?.id ?? "created-id"
		entries.set(name, { id, settings })
		return Promise.resolve(id)
	})
	const deleteConfig = vi.fn((name: string) => {
		entries.delete(name)
		return Promise.resolve()
	})
	return { entries, hasConfig, getProfile, saveConfig, deleteConfig }
}

// A second extension-host window reaches the same profile store through its own manager instance:
// the datastore is shared, the instance is not. These are the record methods pointed at an entry
// map another double already owns, which is how a competing writer changes a record after this call
// saved it and before this call compensates. The id is preserved on an overwrite exactly as the
// production manager does, which is what makes the id alone useless as an ownership test.
const makeSharedStoreManagerView = (entries: Map<string, { id: string; settings: Record<string, unknown> }>) => ({
	hasConfig: (name: string) => Promise.resolve(entries.has(name)),
	getProfile: ({ name }: { name: string }) => {
		const entry = entries.get(name)
		if (!entry) {
			return Promise.reject(new Error(`Profile "${name}" does not exist`))
		}
		return Promise.resolve({ name, id: entry.id, ...entry.settings })
	},
	saveConfig: (name: string, settings: Record<string, unknown>) => {
		const id = entries.get(name)?.id ?? "other-window-id"
		entries.set(name, { id, settings })
		return Promise.resolve(id)
	},
	deleteConfig: (name: string) => {
		entries.delete(name)
		return Promise.resolve()
	},
})
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
			getProviderProfileEntries: vi.fn().mockReturnValue([]),
			getValues: vi.fn().mockReturnValue({}),
			setValues,
			contextProxy: {
				getValue: vi.fn().mockReturnValue(undefined),
				setValues,
				getProviderSettings: vi.fn().mockReturnValue({}),
			},
			providerSettingsManager: {
				runExclusiveAcrossInstances: runManagerSectionInline,
				saveConfig,
				setModeConfig,
				hasConfig: vi.fn().mockResolvedValue(false),
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
			},
			setModeConfig,
			// The window-local mode mapping ClineProvider keeps beside the store. The two
			// compensation seams delegate to the production methods instead of copying them.
			localModeConfigIds: new Map<string, string>(),
			getLocalModeConfigId(mode: Mode) {
				return ClineProvider.prototype.getLocalModeConfigId.call(this, mode)
			},
			restoreLocalModeConfig(mode: Mode, localId: string | undefined) {
				ClineProvider.prototype.restoreLocalModeConfig.call(this, mode, localId)
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
	it("aborts before the profile save when the prior mode mapping read fails", async () => {
		const store = makeProfileStoreDouble({
			default: { id: "prior-id", settings: { apiProvider: providerIdentifiers.openrouter } },
		})
		const setValues = vi.fn().mockResolvedValue(undefined)
		const setModeConfig = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		// The prior mapping of each mode the payload touches is read before anything is written, so
		// the read joins the fail-closed reads the critical section below already runs.
		const getModeConfigId = vi.fn().mockRejectedValue(new Error("mode mapping read failed"))
		const provider = {
			context: {},
			on: vi.fn(),
			log: vi.fn(),
			getProviderProfileEntries: vi.fn().mockReturnValue([]),
			getValues: vi.fn().mockReturnValue({}),
			setValues,
			contextProxy: {
				getValue: vi.fn().mockReturnValue(undefined),
				setValues,
				getProviderSettings: vi.fn().mockReturnValue({ apiProvider: providerIdentifiers.anthropic }),
			},
			providerSettingsManager: {
				runExclusiveAcrossInstances: runManagerSectionInline,
				...store,
				setModeConfig,
				getModeConfigId,
			},
			setModeConfig,
			// The window-local mode mapping ClineProvider keeps beside the store. The two
			// compensation seams delegate to the production methods instead of copying them.
			localModeConfigIds: new Map<string, string>(),
			getLocalModeConfigId(mode: Mode) {
				return ClineProvider.prototype.getLocalModeConfigId.call(this, mode)
			},
			restoreLocalModeConfig(mode: Mode, localId: string | undefined) {
				ClineProvider.prototype.restoreLocalModeConfig.call(this, mode, localId)
			},
			postStateToWebview,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		await expect(
			api.setConfiguration({
				currentApiConfigName: "default",
				apiProvider: providerIdentifiers.openrouter,
				modeApiConfigs: { code: "code-config" },
			}),
		).rejects.toThrow("mode mapping read failed")

		// Nothing may have been mutated: the record this call found must still be the record it found,
		// with its own id, and no shared write may have run. A rejection after the save would leave a
		// created-or-overwritten record that the compensation never sees, because the compensation
		// only runs for failures of the writes that follow the capture.
		expect(store.saveConfig).not.toHaveBeenCalled()
		expect(setValues).not.toHaveBeenCalled()
		expect(setModeConfig).not.toHaveBeenCalled()
		expect(postStateToWebview).not.toHaveBeenCalled()
		expect(store.entries.get("default")).toEqual({
			id: "prior-id",
			settings: { apiProvider: providerIdentifiers.openrouter },
		})
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
			getProviderProfileEntries: vi.fn().mockReturnValue([]),
			getValues: vi.fn().mockReturnValue({}),
			setValues,
			contextProxy: {
				getValue: vi.fn().mockReturnValue(undefined),
				setValues,
				getProviderSettings: vi.fn().mockReturnValue({}),
			},
			providerSettingsManager: {
				runExclusiveAcrossInstances: runManagerSectionInline,
				saveConfig,
				setModeConfig,
				hasConfig: vi.fn().mockResolvedValue(false),
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
			},
			setModeConfig,
			// The window-local mode mapping ClineProvider keeps beside the store. The two
			// compensation seams delegate to the production methods instead of copying them.
			localModeConfigIds: new Map<string, string>(),
			getLocalModeConfigId(mode: Mode) {
				return ClineProvider.prototype.getLocalModeConfigId.call(this, mode)
			},
			restoreLocalModeConfig(mode: Mode, localId: string | undefined) {
				ClineProvider.prototype.restoreLocalModeConfig.call(this, mode, localId)
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
				runExclusiveAcrossInstances: runManagerSectionInline,
				saveConfig,
				deleteConfig,
				setModeConfig,
				hasConfig: vi.fn().mockResolvedValue(false),
			},
			setModeConfig,
			// The window-local mode mapping ClineProvider keeps beside the store. The two
			// compensation seams delegate to the production methods instead of copying them.
			localModeConfigIds: new Map<string, string>(),
			getLocalModeConfigId(mode: Mode) {
				return ClineProvider.prototype.getLocalModeConfigId.call(this, mode)
			},
			restoreLocalModeConfig(mode: Mode, localId: string | undefined) {
				ClineProvider.prototype.restoreLocalModeConfig.call(this, mode, localId)
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
		// The store double keeps the compensation re-read honest: this call creates the record, so the
		const { saveConfig, deleteConfig, hasConfig, getProfile } = makeProfileStoreDouble()
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
				hasConfig,
				getProfile,
				setModeConfig,
				runExclusiveAcrossInstances: runManagerSectionInline,
			},
			setModeConfig,
			// The window-local mode mapping ClineProvider keeps beside the store. The two
			// compensation seams delegate to the production methods instead of copying them.
			localModeConfigIds: new Map<string, string>(),
			getLocalModeConfigId(mode: Mode) {
				return ClineProvider.prototype.getLocalModeConfigId.call(this, mode)
			},
			restoreLocalModeConfig(mode: Mode, localId: string | undefined) {
				ClineProvider.prototype.restoreLocalModeConfig.call(this, mode, localId)
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
		// The store double keeps the compensation re-read honest: this call creates the record, so the
		const { saveConfig, deleteConfig, hasConfig, getProfile } = makeProfileStoreDouble()
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
				hasConfig,
				getProfile,
				setModeConfig: vi.fn().mockResolvedValue(undefined),
				runExclusiveAcrossInstances: runManagerSectionInline,
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
				runExclusiveAcrossInstances: runManagerSectionInline,
				saveConfig,
				deleteConfig,
				hasConfig: vi.fn().mockResolvedValue(true),
				getProfile: vi.fn().mockResolvedValue(previousRecord),
				setModeConfig,
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
			},
			setModeConfig,
			// The window-local mode mapping ClineProvider keeps beside the store. The two
			// compensation seams delegate to the production methods instead of copying them.
			localModeConfigIds: new Map<string, string>(),
			getLocalModeConfigId(mode: Mode) {
				return ClineProvider.prototype.getLocalModeConfigId.call(this, mode)
			},
			restoreLocalModeConfig(mode: Mode, localId: string | undefined) {
				ClineProvider.prototype.restoreLocalModeConfig.call(this, mode, localId)
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
		// The store double keeps the compensation re-read honest: this call creates the record, so
		// the re-read inside the critical section must find it rather than repeat the pre-call answer.
		const { saveConfig, deleteConfig, hasConfig, getProfile } = makeProfileStoreDouble()
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
				hasConfig,
				getProfile,
				setModeConfig,
				// The code mode had no mapping before: rollback must clear the
				// mapping this call created rather than leave it pointing at the
				// config the failed fan-out chose.
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
				runExclusiveAcrossInstances: runManagerSectionInline,
			},
			setModeConfig,
			// The window-local mode mapping ClineProvider keeps beside the store. The two
			// compensation seams delegate to the production methods instead of copying them.
			localModeConfigIds: new Map<string, string>(),
			getLocalModeConfigId(mode: Mode) {
				return ClineProvider.prototype.getLocalModeConfigId.call(this, mode)
			},
			restoreLocalModeConfig(mode: Mode, localId: string | undefined) {
				ClineProvider.prototype.restoreLocalModeConfig.call(this, mode, localId)
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

	it("replays a written key the snapshot did not hold instead of leaving it pinned", async () => {
		const written: Array<{ values: RooCodeSettings; options?: { savedProfileName?: string } }> = []
		const setValues = vi.fn(async (values: RooCodeSettings, options?: { savedProfileName?: string }) => {
			written.push({ values, options })
		})
		const { saveConfig, deleteConfig, hasConfig, getProfile } = makeProfileStoreDouble()
		const setModeConfig = vi.fn().mockRejectedValue(new Error("mode write failed"))
		const setProviderSettings = vi.fn().mockResolvedValue(undefined)
		const sharedSetValues = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const sharedBefore = { apiModelId: "model-old" }
		// The snapshot holds no profile pin at all, and the pin is one of the keys this call
		// writes: the replay must carry it back as absent. Replaying only the keys the
		// snapshot happened to hold left every view pinned to the record the compensation
		// had just deleted.
		const provider = {
			context: {},
			on: vi.fn(),
			getProviderProfileEntries: vi.fn().mockReturnValue([]),
			getValues: vi.fn().mockReturnValue({ apiModelId: "model-old" }),
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
				hasConfig,
				getProfile,
				setModeConfig,
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
				runExclusiveAcrossInstances: runManagerSectionInline,
			},
			setModeConfig,
			// The window-local mode mapping ClineProvider keeps beside the store. The two
			// compensation seams delegate to the production methods instead of copying them.
			localModeConfigIds: new Map<string, string>(),
			getLocalModeConfigId(mode: Mode) {
				return ClineProvider.prototype.getLocalModeConfigId.call(this, mode)
			},
			restoreLocalModeConfig(mode: Mode, localId: string | undefined) {
				ClineProvider.prototype.restoreLocalModeConfig.call(this, mode, localId)
			},
			postStateToWebview,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		await expect(
			api.setConfiguration({
				currentApiConfigName: "pinned",
				modeApiConfigs: { code: "new-code-config" },
			}),
		).rejects.toThrow("mode write failed")

		const replayed: Partial<RooCodeSettings> = written[written.length - 1]?.values ?? {}
		// The pin returns as an explicit absent key so the views drop the pin to the deleted
		// record instead of naming a profile the store no longer has.
		expect(Object.keys(replayed)).toContain("currentApiConfigName")
		expect(replayed.currentApiConfigName).toBeUndefined()
		// The mode mapping is a key this call owns too, and the snapshot did not hold it:
		// the replay clears it alongside the store write it compensates.
		expect(Object.keys(replayed)).toContain("modeApiConfigs")
		expect(written[written.length - 1]?.options).toEqual({ savedProfileName: "default" })
		expect(deleteConfig).toHaveBeenCalledWith("pinned")
	})

	it("restores this window mode mapping when a mode mapping write is rolled back", async () => {
		const setValues = vi.fn().mockResolvedValue(undefined)
		const { saveConfig, deleteConfig, hasConfig, getProfile } = makeProfileStoreDouble()
		const setProviderSettings = vi.fn().mockResolvedValue(undefined)
		const sharedSetValues = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		// The window-local mapping layer, the same map ClineProvider keeps: architect had a
		// local id before this call and code had none.
		const localModeConfigIds = new Map<string, string>([["architect", "window-architect-config"]])
		// The store accepts an undefined clear, so only the forward write of the new code
		// mapping fails; the rollback clear of the same mode succeeds.
		const managerSetModeConfig = vi.fn(async (mode: string, _configId?: string) => {
			if (mode === "code" && _configId !== undefined) {
				throw new Error("mode write failed")
			}
		})
		// The fixture below binds ClineProvider's own setModeConfig, getLocalModeConfigId and
		// restoreLocalModeConfig; only the manager storage boundary is mocked. The wrapper writes
		// the store and records the id in this window map, so a rollback that rewinds only one of
		// the two layers is observable here rather than hidden behind a copy of the wrapper.
		const provider = {
			context: {},
			on: vi.fn(),
			getProviderProfileEntries: vi.fn().mockReturnValue([]),
			getValues: vi.fn().mockReturnValue({ currentApiConfigName: "old-profile" }),
			setValues,
			contextProxy: {
				getValue: vi.fn().mockReturnValue(undefined),
				setValues: sharedSetValues,
				getProviderSettings: vi.fn().mockReturnValue({ apiModelId: "model-old" }),
				setProviderSettings,
			},
			refreshViewLocalStateForUpdatedProfile: vi.fn().mockResolvedValue(undefined),
			providerSettingsManager: {
				saveConfig,
				deleteConfig,
				hasConfig,
				getProfile,
				setModeConfig: managerSetModeConfig,
				// architect was mapped before the call, code was not.
				getModeConfigId: vi.fn(async (mode: string) =>
					mode === "architect" ? "old-architect-config" : undefined,
				),
				runExclusiveAcrossInstances: runManagerSectionInline,
			},
			localModeConfigIds,
			setModeConfig(mode: Mode, configId: string) {
				return ClineProvider.prototype.setModeConfig.call(this, mode, configId)
			},
			getLocalModeConfigId(mode: Mode) {
				return ClineProvider.prototype.getLocalModeConfigId.call(this, mode)
			},
			restoreLocalModeConfig(mode: Mode, localId: string | undefined) {
				ClineProvider.prototype.restoreLocalModeConfig.call(this, mode, localId)
			},
			postStateToWebview,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		await expect(
			api.setConfiguration({
				currentApiConfigName: "pinned",
				modeApiConfigs: { architect: "new-architect-config", code: "new-code-config" },
			}),
		).rejects.toThrow("mode write failed")

		// The architect write landed through the wrapper before code rejected, so its new id sat
		// in this window map. Each layer rewinds to its own snapshot: the store to the value the
		// manager held, this window entry to the value this window held, which is the different
		// one here. Rewinding the local entry to the store value is what this assertion rejects.
		expect(localModeConfigIds.get("architect")).toBe("window-architect-config")
		expect(managerSetModeConfig).toHaveBeenCalledWith("architect", "old-architect-config")
		// The code mapping did not exist before the call: the rollback clears the store entry
		// and leaves no local entry naming a mapping the store no longer has.
		expect(localModeConfigIds.has("code")).toBe(false)
		expect(managerSetModeConfig).toHaveBeenCalledWith("code", undefined)
		expect(deleteConfig).toHaveBeenCalledWith("pinned")
	})
	it("keeps host-owned viewStates out of both the settings write and the rollback replay", async () => {
		// Same rollback scenario as the mode-mapping test above, but the caller payload and
		// the pre-call snapshot each carry a viewStates map: the forward write would pin other
		// views where this caller found them, and the replay would roll them back to where this
		// call found them. Both are machine-local host state, excluded by
		// NON_PORTABLE_SETTINGS_KEYS - the same list the export and import paths use, and the
		// list #2226 filters the read side with. getValues() itself keeps the key: the host's
		// own consumers still need it.
		const setValues = vi.fn().mockResolvedValue(undefined)
		// The store double keeps the compensation re-read honest: this call creates the record, so
		// the re-read inside the critical section must find it rather than repeat the pre-call answer.
		const { saveConfig, deleteConfig, hasConfig, getProfile } = makeProfileStoreDouble()
		const setModeConfig = vi.fn().mockRejectedValue(new Error("mode write failed"))
		const setProviderSettings = vi.fn().mockResolvedValue(undefined)
		const sharedSetValues = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const provider = {
			context: {},
			on: vi.fn(),
			getProviderProfileEntries: vi.fn().mockReturnValue([]),
			getValues: vi.fn().mockReturnValue({
				currentApiConfigName: "old-profile",
				viewStates: { "sidebar-1": { currentApiConfigName: "snapshot-pin", updatedAt: 1 } },
			}),
			setValues,
			contextProxy: {
				getValue: vi.fn().mockReturnValue(undefined),
				setValues: sharedSetValues,
				getProviderSettings: vi.fn().mockReturnValue({ apiProvider: providerIdentifiers.anthropic }),
				setProviderSettings,
			},
			refreshViewLocalStateForUpdatedProfile: vi.fn().mockResolvedValue(undefined),
			providerSettingsManager: {
				saveConfig,
				deleteConfig,
				hasConfig,
				getProfile,
				setModeConfig,
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
				runExclusiveAcrossInstances: runManagerSectionInline,
			},
			setModeConfig,
			// The window-local mode mapping ClineProvider keeps beside the store. The two
			// compensation seams delegate to the production methods instead of copying them.
			localModeConfigIds: new Map<string, string>(),
			getLocalModeConfigId(mode: Mode) {
				return ClineProvider.prototype.getLocalModeConfigId.call(this, mode)
			},
			restoreLocalModeConfig(mode: Mode, localId: string | undefined) {
				ClineProvider.prototype.restoreLocalModeConfig.call(this, mode, localId)
			},
			postStateToWebview,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		await expect(
			api.setConfiguration({
				currentApiConfigName: "pinned",
				modeApiConfigs: { code: "new-code-config" },
				viewStates: { "sidebar-9": { currentApiConfigName: "payload-pin", updatedAt: 2 } },
			}),
		).rejects.toThrow("mode write failed")

		// Two settings writes happen in this call: the forward payload, then the rollback
		// replay of the pre-call snapshot. The shared-pair restore writes the shared store
		// directly (sharedSetValues), so it is not counted here.
		const written = setValues.mock.calls.map((call: unknown[]) => call[0] as Record<string, unknown>)
		expect(written).toHaveLength(2)
		expect(written[0]).toEqual(expect.objectContaining({ currentApiConfigName: "pinned" }))
		expect(written[1]).toEqual(expect.objectContaining({ currentApiConfigName: "old-profile" }))
		written.forEach((values: Record<string, unknown>) => {
			expect(values).not.toHaveProperty("viewStates")
			expect(JSON.stringify(values)).not.toContain("payload-pin")
			expect(JSON.stringify(values)).not.toContain("snapshot-pin")
		})
	})

	it("restores a same-name record another view created instead of deleting it", async () => {
		// The interleaving this critical section exists to close. A second view enters the manager
		// cross-instance queue and parks there while it creates the profile this call is about to
		// save. Our call must queue behind it, so the create lands before our existence check, our
		// own write then fails, and the rollback restores that view record instead of deleting it
		// together with its secret.
		let queue: Promise<unknown> = Promise.resolve()
		const runExclusiveAcrossInstances = <T>(cb: () => Promise<T>): Promise<T> => {
			const run = queue.then(cb)
			// A settled-clean owner keeps one failed section from poisoning the queue for the next
			// caller, which is why the production queue stores one.
			queue = run.then(
				() => {},
				() => {},
			)
			return run
		}
		const callOrder: string[] = []
		const records = new Map<string, { id: string; settings: Record<string, unknown> }>()
		let releaseOtherView: (() => void) | undefined
		const otherViewCreate = new Promise<void>((resolve) => {
			releaseOtherView = resolve
		})
		const otherView = runExclusiveAcrossInstances(async () => {
			callOrder.push("other view entered the section")
			await otherViewCreate
			records.set("pinned", { id: "other-view-id", settings: { apiKey: "other-view-secret" } })
			callOrder.push("other view created the record")
		})
		const hasConfig = vi.fn((name: string) => {
			callOrder.push("this call checked existence")
			return Promise.resolve(records.has(name))
		})
		const getProfile = vi.fn(({ name }: { name: string }) => {
			const entry = records.get(name)
			return entry
				? Promise.resolve({ name, id: entry.id, ...entry.settings })
				: Promise.reject(new Error(`Profile "${name}" does not exist`))
		})
		const saveConfig = vi.fn((name: string, settings: Record<string, unknown>) => {
			// A store that keeps an existing record id on an overwrite is what the production
			// manager does, and it is the reason the compensation has to compare ids.
			const id = records.get(name)?.id ?? "this-call-id"
			records.set(name, { id, settings })
			callOrder.push("this call saved the record")
			return Promise.resolve(id)
		})
		const deleteConfig = vi.fn((name: string) => {
			records.delete(name)
			callOrder.push("this call deleted the record")
			return Promise.resolve()
		})
		const setValues = vi.fn().mockResolvedValue(undefined)
		const setModeConfig = vi.fn().mockRejectedValue(new Error("mode write failed"))
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const provider = {
			context: {},
			on: vi.fn(),
			log: vi.fn(),
			getProviderProfileEntries: vi.fn().mockReturnValue([]),
			// Releasing the parked create from the snapshot read keeps the interleaving
			// deterministic: the snapshot is taken before this call enters the section, so the
			// other view wakes, finishes its create, and releases the lock before our existence
			// check runs - and only because our call queued behind it.
			getValues: vi.fn().mockImplementation(() => {
				releaseOtherView?.()
				return { currentApiConfigName: "old-profile" }
			}),
			setValues,
			contextProxy: {
				getValue: vi.fn().mockReturnValue(undefined),
				setValues: vi.fn().mockResolvedValue(undefined),
				getProviderSettings: vi.fn().mockReturnValue({ apiProvider: providerIdentifiers.anthropic }),
				setProviderSettings: vi.fn().mockResolvedValue(undefined),
			},
			refreshViewLocalStateForUpdatedProfile: vi.fn().mockResolvedValue(undefined),
			providerSettingsManager: {
				runExclusiveAcrossInstances,
				hasConfig,
				getProfile,
				saveConfig,
				deleteConfig,
				setModeConfig,
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
			},
			setModeConfig,
			// The window-local mode mapping ClineProvider keeps beside the store. The two
			// compensation seams delegate to the production methods instead of copying them.
			localModeConfigIds: new Map<string, string>(),
			getLocalModeConfigId(mode: Mode) {
				return ClineProvider.prototype.getLocalModeConfigId.call(this, mode)
			},
			restoreLocalModeConfig(mode: Mode, localId: string | undefined) {
				ClineProvider.prototype.restoreLocalModeConfig.call(this, mode, localId)
			},
			postStateToWebview,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		await expect(
			api.setConfiguration({ currentApiConfigName: "pinned", modeApiConfigs: { code: "new-code-config" } }),
		).rejects.toThrow("mode write failed")
		await otherView

		// The create beat our existence check, which is what joining the section means: without it
		// this call reads the name as absent, overwrites the record, and rolls back by deleting it.
		expect(callOrder.indexOf("other view created the record")).toBeLessThan(
			callOrder.indexOf("this call checked existence"),
		)
		// The other view record survives our rollback, id and secret included, and the restore
		// re-applies its stored settings rather than removing the record.
		expect(deleteConfig).not.toHaveBeenCalled()
		expect(records.get("pinned")).toEqual({
			id: "other-view-id",
			settings: expect.objectContaining({ apiKey: "other-view-secret" }),
		})
		expect(saveConfig).toHaveBeenCalledTimes(2)
		expect(saveConfig).toHaveBeenLastCalledWith("pinned", expect.objectContaining({ apiKey: "other-view-secret" }))
		expect(postStateToWebview).not.toHaveBeenCalled()
	})

	it("keeps a record another view rewrote between the save and the compensation", async () => {
		// The reject path of the id comparison. This call creates the name, so its own rollback
		// would delete it; a locked writer that replaces the record in between owns the name now,
		// and deleting it here would remove that other view record together with its secret. The
		// store is live-backed so the re-read inside the section sees the rewrite, which a static
		// hasConfig mock cannot model.
		const records = new Map<string, { id: string; settings: Record<string, unknown> }>()
		const hasConfig = vi.fn((name: string) => Promise.resolve(records.has(name)))
		const getProfile = vi.fn(({ name }: { name: string }) => {
			const entry = records.get(name)
			return entry
				? Promise.resolve({ name, id: entry.id, ...entry.settings })
				: Promise.reject(new Error(`Profile "${name}" does not exist`))
		})
		const saveConfig = vi.fn((name: string, settings: Record<string, unknown>) => {
			records.set(name, { id: "this-call-id", settings })
			return Promise.resolve("this-call-id")
		})
		const deleteConfig = vi.fn((name: string) => {
			records.delete(name)
			return Promise.resolve()
		})
		const setModeConfig = vi.fn(async () => {
			// The interleaving the guard is for: another locked writer replaces the record this
			// call had created, under its own id.
			records.set("pinned", { id: "other-view-id", settings: { apiKey: "other-view-secret" } })
			throw new Error("mode write failed")
		})
		const setValues = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const provider = {
			context: {},
			on: vi.fn(),
			log: vi.fn(),
			getProviderProfileEntries: vi.fn().mockReturnValue([]),
			getValues: vi.fn(() => ({ currentApiConfigName: "pinned" })),
			setValues,
			contextProxy: {
				getValue: vi.fn().mockReturnValue(undefined),
				setValues: vi.fn().mockResolvedValue(undefined),
				getProviderSettings: vi.fn().mockReturnValue({ apiProvider: providerIdentifiers.anthropic }),
				setProviderSettings: vi.fn().mockResolvedValue(undefined),
			},
			refreshViewLocalStateForUpdatedProfile: vi.fn().mockResolvedValue(undefined),
			providerSettingsManager: {
				runExclusiveAcrossInstances: runManagerSectionInline,
				hasConfig,
				getProfile,
				saveConfig,
				deleteConfig,
				setModeConfig,
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
			},
			setModeConfig,
			// The window-local mode mapping ClineProvider keeps beside the store. The two
			// compensation seams delegate to the production methods instead of copying them.
			localModeConfigIds: new Map<string, string>(),
			getLocalModeConfigId(mode: Mode) {
				return ClineProvider.prototype.getLocalModeConfigId.call(this, mode)
			},
			restoreLocalModeConfig(mode: Mode, localId: string | undefined) {
				ClineProvider.prototype.restoreLocalModeConfig.call(this, mode, localId)
			},
			postStateToWebview,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		await expect(
			api.setConfiguration({ currentApiConfigName: "pinned", modeApiConfigs: { code: "new-code-config" } }),
		).rejects.toThrow("mode write failed")

		// The existence check saw the name absent, so the rollback reaches the delete branch; the
		// id its own save returned is not the id on the record any more, and the record stays.
		expect(deleteConfig).not.toHaveBeenCalled()
		expect(records.get("pinned")).toEqual({
			id: "other-view-id",
			settings: expect.objectContaining({ apiKey: "other-view-secret" }),
		})
		expect(saveConfig).toHaveBeenCalledTimes(1)
		expect(postStateToWebview).not.toHaveBeenCalled()
	})

	it("replays only the keys this call wrote and leaves keys another view changed alone", async () => {
		// A rollback may restore what this call changed and nothing else, because anything the
		// snapshot happens to hold otherwise belongs to a writer that has moved on since it was
		// taken. The payload writes two settings; after this call snapshots the configuration and
		// before its mode write fails, another view writes a shared setting and the pass-through
		// taskHistory key. Neither may be written back from this call stale snapshot.
		const store: Record<string, unknown> = {
			currentApiConfigName: "old-profile",
			modeApiConfigs: { code: "old-code-config" },
			terminalOutputLineLimit: 1000,
			taskHistory: "snapshot-tasks",
		}
		const written: Array<Record<string, unknown>> = []
		const setValues = vi.fn((values: Record<string, unknown>) => {
			written.push({ ...values })
			return Promise.resolve(undefined)
		})
		const setModeConfig = vi.fn(async () => {
			// Another view lands between the snapshot above and this failure.
			store.terminalOutputLineLimit = 42
			store.taskHistory = "other-view-tasks"
			throw new Error("mode write failed")
		})
		const { saveConfig, deleteConfig, hasConfig, getProfile } = makeProfileStoreDouble()
		const sharedSetValues = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const provider = {
			context: {},
			on: vi.fn(),
			log: vi.fn(),
			getProviderProfileEntries: vi.fn().mockReturnValue([]),
			// Live-backed so the snapshot is this call view of the store at snapshot time.
			getValues: vi.fn(() => ({ ...store })),
			setValues,
			contextProxy: {
				getValue: vi.fn().mockReturnValue(undefined),
				setValues: sharedSetValues,
				getProviderSettings: vi.fn().mockReturnValue({ apiProvider: providerIdentifiers.anthropic }),
				setProviderSettings: vi.fn().mockResolvedValue(undefined),
			},
			refreshViewLocalStateForUpdatedProfile: vi.fn().mockResolvedValue(undefined),
			providerSettingsManager: {
				saveConfig,
				deleteConfig,
				hasConfig,
				getProfile,
				setModeConfig,
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
				runExclusiveAcrossInstances: runManagerSectionInline,
			},
			setModeConfig,
			// The window-local mode mapping ClineProvider keeps beside the store. The two
			// compensation seams delegate to the production methods instead of copying them.
			localModeConfigIds: new Map<string, string>(),
			getLocalModeConfigId(mode: Mode) {
				return ClineProvider.prototype.getLocalModeConfigId.call(this, mode)
			},
			restoreLocalModeConfig(mode: Mode, localId: string | undefined) {
				ClineProvider.prototype.restoreLocalModeConfig.call(this, mode, localId)
			},
			postStateToWebview,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		await expect(
			api.setConfiguration({ currentApiConfigName: "pinned", modeApiConfigs: { code: "new-code-config" } }),
		).rejects.toThrow("mode write failed")

		// Two settings writes in this call: the payload forward, then the rollback replay.
		expect(written).toHaveLength(2)
		expect(written[0]).toEqual(expect.objectContaining({ currentApiConfigName: "pinned" }))
		// The replay carries exactly the keys this call wrote, at their pre-call values: the shared
		// setting and the pass-through key another view changed are not in it at all.
		expect(Object.keys(written[1]).sort()).toEqual(["currentApiConfigName", "modeApiConfigs"])
		expect(written[1]).toEqual({ currentApiConfigName: "old-profile", modeApiConfigs: { code: "old-code-config" } })
		expect(JSON.stringify(written[1])).not.toContain("terminalOutputLineLimit")
		expect(JSON.stringify(written[1])).not.toContain("snapshot-tasks")
		// And the other view values are still where that view put them.
		expect(store.terminalOutputLineLimit).toBe(42)
		expect(store.taskHistory).toBe("other-view-tasks")
		expect(deleteConfig).toHaveBeenCalledWith("pinned")
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
				runExclusiveAcrossInstances: runManagerSectionInline,
				saveConfig,
				deleteConfig,
				hasConfig: vi.fn().mockResolvedValue(true),
				getProfile: vi.fn().mockResolvedValue(previousRecord),
				setModeConfig,
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
			},
			setModeConfig,
			// The window-local mode mapping ClineProvider keeps beside the store. The two
			// compensation seams delegate to the production methods instead of copying them.
			localModeConfigIds: new Map<string, string>(),
			getLocalModeConfigId(mode: Mode) {
				return ClineProvider.prototype.getLocalModeConfigId.call(this, mode)
			},
			restoreLocalModeConfig(mode: Mode, localId: string | undefined) {
				ClineProvider.prototype.restoreLocalModeConfig.call(this, mode, localId)
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

	// The compensation tests below share one shape: a payload that saves a profile, writes the settings,
	// and then fails on a mode mapping write, over a live-backed profile store. The failing mode write is
	// the seam that puts another window write between this call save and this call compensation, because
	// the compensation only runs in the failure path the stub creates. Both window-local mode seams call
	// the production ClineProvider methods rather than copying them, so the rollback under test is the one
	// the extension host runs.
	const makeRollbackHarness = ({
		records,
		profileEntries,
		snapshot,
		beforeFailingModeWrite,
		profileReader,
		compensationWrite,
		productionSetValues,
	}: {
		records: Record<string, { id: string; settings: Record<string, unknown> }>
		profileEntries: { name: string; id: string }[]
		snapshot: Record<string, unknown>
		beforeFailingModeWrite?: (deps: {
			store: ReturnType<typeof makeProfileStoreDouble>
			otherWindowManager: ReturnType<typeof makeSharedStoreManagerView>
		}) => Promise<unknown>
		profileReader?: (deps: {
			store: ReturnType<typeof makeProfileStoreDouble>
			otherWindowManager: ReturnType<typeof makeSharedStoreManagerView>
		}) => (params: { name: string }) => Promise<unknown>
		// Makes the compensation write itself fail: "save" rejects the restore save (the second save this
		// call makes - the first is the forward write and must land), "delete" rejects the only delete.
		// Neither mutates the entry it rejects, which is what a storage failure leaves behind.
		compensationWrite?: "save" | "delete"
		// Routes the settings write through the production ClineProvider#setValues instead of a no-op, with
		// only its persistence boundaries mocked, so the sibling refresh that setter drives for a saved
		// profile is real in the test rather than hidden by the double.
		productionSetValues?: boolean
	}) => {
		const store = makeProfileStoreDouble(records)
		const deps = { store, otherWindowManager: makeSharedStoreManagerView(store.entries) }
		// The compensation-write seam: the store double stays the source of truth, only the write that the
		// compensation performs is made to reject, and it rejects before touching the entry.
		let saveCalls = 0
		const saveConfig =
			compensationWrite === "save"
				? vi.fn((name: string, settings: Record<string, unknown>) => {
						saveCalls += 1
						if (saveCalls === 2) {
							return Promise.reject(new Error("compensation save failed"))
						}
						return store.saveConfig(name, settings)
					})
				: store.saveConfig
		const deleteConfig =
			compensationWrite === "delete"
				? vi.fn((_name: string) => Promise.reject(new Error("compensation delete failed")))
				: store.deleteConfig
		// The persistence boundaries of the production setter: the shared write, the per-view record and the
		// sibling-overlay snapshot are mocked; the validation, ordering and the refresh it drives are not.
		const saveViewLocalStateSpy = vi.fn().mockResolvedValue(undefined)
		const overlaySnapshotSpy = vi.fn().mockResolvedValue(undefined)
		const setValuesViaProvider = ClineProvider.prototype.setValues
		const setValues = productionSetValues
			? vi.fn((values: RooCodeSettings, options?: { savedProfileName?: string }) =>
					setValuesViaProvider.call(provider, values, options),
				)
			: vi.fn().mockResolvedValue(undefined)
		const managerSetModeConfig = vi.fn().mockResolvedValue(undefined)
		const refreshSpy = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const log = vi.fn()
		const setModeConfig = vi.fn(async () => {
			if (beforeFailingModeWrite) {
				await beforeFailingModeWrite(deps)
			}
			throw new Error("mode write failed")
		})
		const provider = {
			context: {},
			on: vi.fn(),
			log,
			getProviderProfileEntries: vi.fn().mockReturnValue(profileEntries),
			getValues: vi.fn().mockReturnValue({ ...snapshot }),
			setValues,
			contextProxy: {
				getValue: vi.fn().mockReturnValue(undefined),
				setValues: vi.fn().mockResolvedValue(undefined),
				getProviderSettings: vi.fn().mockReturnValue({ apiProvider: providerIdentifiers.anthropic }),
				setProviderSettings: vi.fn().mockResolvedValue(undefined),
			},
			refreshViewLocalStateForUpdatedProfile: refreshSpy,
			// Bracketed private members of ClineProvider stand in as the mocked persistence boundaries the
			// production setter needs; they are not copies of its behaviour.
			snapshotSiblingOverlaysBeforeSharedSettingsWrite: overlaySnapshotSpy,
			_saveViewLocalStateFromMutation: saveViewLocalStateSpy,
			providerSettingsManager: {
				runExclusiveAcrossInstances: runManagerSectionInline,
				hasConfig: store.hasConfig,
				getProfile: profileReader ? profileReader(deps) : store.getProfile,
				saveConfig,
				deleteConfig,
				setModeConfig: managerSetModeConfig,
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
			},
			setModeConfig,
			localModeConfigIds: new Map<string, string>(),
			getLocalModeConfigId(mode: Mode) {
				return ClineProvider.prototype.getLocalModeConfigId.call(this, mode)
			},
			restoreLocalModeConfig(mode: Mode, localId: string | undefined) {
				ClineProvider.prototype.restoreLocalModeConfig.call(this, mode, localId)
			},
			postStateToWebview,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		// Logging is enabled so the compensation log lines land on the output channel, where the tests
		// below assert them; without the fifth argument this.log is a no-op. The socket path stays unset
		// so the API never enters ipc mode.
		const api = new API(outputChannel, provider, makeClineProviderFactory(), undefined, true)
		return {
			api,
			provider,
			store,
			setValues,
			managerSetModeConfig,
			refreshSpy,
			overlaySnapshotSpy,
			saveViewLocalStateSpy,
			outputChannel,
			otherWindowManager: deps.otherWindowManager,
		}
	}

	it("keeps a record another window rewrote after this call saved it", async () => {
		// Finding 4604351737, the case the different-id test cannot reach. The record existed before this
		// call, so the compensation used to write the prior record back whatever the store held. A second
		// window saves the same profile after this call releases the manager section, and this call own
		// save - not that write - is what moved the value away from the prior record, so the ownership
		// base is the value this call wrote. The newer record stays and the rest of the rollback runs.
		const priorSettings = { apiProvider: providerIdentifiers.anthropic, apiKey: "prior-key" }
		const { api, store, managerSetModeConfig, setValues, outputChannel } = makeRollbackHarness({
			records: { pinned: { id: "pinned-id", settings: priorSettings } },
			profileEntries: [{ name: "pinned", id: "pinned-id" }],
			snapshot: { currentApiConfigName: "pinned", apiProvider: providerIdentifiers.anthropic },
			beforeFailingModeWrite: ({ otherWindowManager }) =>
				otherWindowManager.saveConfig("pinned", {
					apiProvider: providerIdentifiers.anthropic,
					apiKey: "other-window-key",
				}),
		})

		await expect(
			api.setConfiguration({
				currentApiConfigName: "pinned",
				apiKey: "this-call-key",
				modeApiConfigs: { code: "code-config" },
			}),
		).rejects.toThrow("mode write failed")

		// The second window record survives: this call saved the profile once, wrote nothing back over it,
		// and deleted nothing.
		expect(store.entries.get("pinned")?.settings).toEqual(expect.objectContaining({ apiKey: "other-window-key" }))
		expect(store.saveConfig).toHaveBeenCalledTimes(1)
		expect(store.deleteConfig).not.toHaveBeenCalled()
		expect(outputChannel.appendLine).toHaveBeenCalledWith(
			expect.stringContaining("skipped restoring the profile record 'pinned'"),
		)
		// The other compensations still run: the mode mapping this call created, and the replay of the
		// settings keys this call wrote.
		expect(managerSetModeConfig).toHaveBeenCalledWith("code", undefined)
		expect(setValues).toHaveBeenCalledTimes(2)
	})

	it("restores the prior record when no other window touched it after the save", async () => {
		// The no-interference counterpart of the test above: with the store still holding what this call
		// wrote, the compare-and-set restore still puts the prior record back, so the new comparison is
		// not a way of skipping every rollback.
		const priorSettings = { apiProvider: providerIdentifiers.anthropic, apiKey: "prior-key" }
		const { api, store, managerSetModeConfig, outputChannel } = makeRollbackHarness({
			records: { pinned: { id: "pinned-id", settings: priorSettings } },
			profileEntries: [{ name: "pinned", id: "pinned-id" }],
			snapshot: { currentApiConfigName: "pinned", apiProvider: providerIdentifiers.anthropic },
		})

		await expect(
			api.setConfiguration({
				currentApiConfigName: "pinned",
				apiKey: "this-call-key",
				modeApiConfigs: { code: "code-config" },
			}),
		).rejects.toThrow("mode write failed")

		expect(store.saveConfig).toHaveBeenCalledTimes(2)
		expect(store.saveConfig).toHaveBeenLastCalledWith("pinned", expect.objectContaining({ apiKey: "prior-key" }))
		expect(store.entries.get("pinned")?.settings).toEqual(expect.objectContaining({ apiKey: "prior-key" }))
		expect(store.deleteConfig).not.toHaveBeenCalled()
		expect(outputChannel.appendLine).not.toHaveBeenCalledWith(
			expect.stringContaining("skipped restoring the profile record"),
		)
		expect(managerSetModeConfig).toHaveBeenCalledWith("code", undefined)
	})

	it("replays the surviving record to pinned siblings when another window overwrote it under the same id", async () => {
		// Finding 4604351756 together with the same-id overwrite case of 4604351737. This call created the
		// profile, so its rollback deletes the record and replays an empty overlay to the siblings pinned
		// to it. A second window saved the same profile in between, and saveConfig preserves the id, so
		// the id check passes while the values say otherwise: the delete must be skipped, and the overlay
		// replay must carry the settings the store actually holds rather than this call empty view of a
		// profile it created, which would strip the newer record credentials from every pinned sibling.
		const { api, store, managerSetModeConfig, refreshSpy, outputChannel } = makeRollbackHarness({
			records: { default: { id: "default-id", settings: { apiProvider: providerIdentifiers.anthropic } } },
			profileEntries: [{ name: "default", id: "default-id" }],
			snapshot: { currentApiConfigName: "new-profile", apiProvider: providerIdentifiers.anthropic },
			beforeFailingModeWrite: ({ otherWindowManager }) =>
				otherWindowManager.saveConfig("new-profile", {
					apiProvider: providerIdentifiers.anthropic,
					apiKey: "other-window-key",
				}),
		})

		await expect(
			api.setConfiguration({
				currentApiConfigName: "new-profile",
				apiKey: "this-call-key",
				modeApiConfigs: { code: "code-config" },
			}),
		).rejects.toThrow("mode write failed")

		expect(store.deleteConfig).not.toHaveBeenCalled()
		expect(store.entries.get("new-profile")?.settings).toEqual(
			expect.objectContaining({ apiKey: "other-window-key" }),
		)
		expect(store.saveConfig).toHaveBeenCalledTimes(1)
		// The pinned siblings end on the surviving record, not on the empty overlay this call would have
		// installed for a profile it created.
		expect(refreshSpy).toHaveBeenCalledTimes(1)
		expect(refreshSpy).toHaveBeenCalledWith("new-profile", expect.objectContaining({ apiKey: "other-window-key" }))
		expect(outputChannel.appendLine).toHaveBeenCalledWith(
			expect.stringContaining("skipped deleting the profile record 'new-profile'"),
		)
		expect(managerSetModeConfig).toHaveBeenCalledWith("code", undefined)
	})

	it("deletes a profile this call created and replays an empty overlay when no other window wrote it", async () => {
		// The no-interference counterpart of the test above: the delete and the empty-overlay replay are
		// both still the compensation when the store still holds what this call wrote.
		const { api, store, managerSetModeConfig, refreshSpy, outputChannel } = makeRollbackHarness({
			records: { default: { id: "default-id", settings: { apiProvider: providerIdentifiers.anthropic } } },
			profileEntries: [{ name: "default", id: "default-id" }],
			snapshot: { currentApiConfigName: "new-profile", apiProvider: providerIdentifiers.anthropic },
		})

		await expect(
			api.setConfiguration({
				currentApiConfigName: "new-profile",
				apiKey: "this-call-key",
				modeApiConfigs: { code: "code-config" },
			}),
		).rejects.toThrow("mode write failed")

		expect(store.saveConfig).toHaveBeenCalledTimes(1)
		expect(store.deleteConfig).toHaveBeenCalledWith("new-profile")
		expect(store.entries.has("new-profile")).toBe(false)
		expect(refreshSpy).toHaveBeenCalledTimes(1)
		expect(refreshSpy).toHaveBeenCalledWith("new-profile", {})
		expect(outputChannel.appendLine).not.toHaveBeenCalledWith(
			expect.stringContaining("skipped deleting the profile record"),
		)
		expect(managerSetModeConfig).toHaveBeenCalledWith("code", undefined)
	})

	it("leaves the record and its overlays alone when the compensation re-read fails", async () => {
		// Rule R3.4: a failed re-read means unconfirmed, not restore anyway. The write section reads the
		// record twice - the prior record, then the value this call wrote - and every read from the
		// compensation onward fails here. Nothing is written back over the record, nothing is replayed to
		// the siblings pinned to it, and the mode mapping still rolls back.
		//
		// The settings write goes through the production ClineProvider#setValues with only its persistence boundaries
		// mocked, because that setter drives a sibling refresh of its own whenever the payload names the profile it
		// saves - and a rollback replay names one. A no-op double hides the only route by which this rollback can
		// reach a sibling overlay at all, so an assertion about the overlays has to be made against the setter.
		const priorSettings = { apiProvider: providerIdentifiers.anthropic, apiKey: "prior-key" }
		const { api, store, managerSetModeConfig, refreshSpy, outputChannel } = makeRollbackHarness({
			records: { pinned: { id: "pinned-id", settings: priorSettings } },
			profileEntries: [{ name: "pinned", id: "pinned-id" }],
			snapshot: { currentApiConfigName: "pinned", apiProvider: providerIdentifiers.anthropic },
			productionSetValues: true,
			profileReader: ({ store: profileStore }) => {
				let reads = 0
				return async ({ name }: { name: string }) => {
					reads += 1
					if (reads >= 3) {
						throw new Error("store read failed")
					}
					return profileStore.getProfile({ name })
				}
			},
		})

		await expect(
			api.setConfiguration({
				currentApiConfigName: "pinned",
				apiKey: "this-call-key",
				modeApiConfigs: { code: "code-config" },
			}),
		).rejects.toThrow("mode write failed")

		// The record keeps what this call last wrote to it: no blind restore of the prior record, and no
		// blind delete either.
		expect(store.saveConfig).toHaveBeenCalledTimes(1)
		expect(store.deleteConfig).not.toHaveBeenCalled()
		expect(store.entries.get("pinned")?.settings).toEqual(expect.objectContaining({ apiKey: "this-call-key" }))
		// The forward write left the overlays pinned to this profile holding this call credentials, through the
		// refresh production setValues drives for a saved profile. The compensation adds no refresh of its own:
		// it could not confirm the record, so it neither replays the prior record nor lets the replay collapse
		// those overlays to an empty one.
		expect(refreshSpy).toHaveBeenCalledTimes(1)
		expect(refreshSpy).toHaveBeenCalledWith("pinned", expect.objectContaining({ apiKey: "this-call-key" }))
		expect(refreshSpy).not.toHaveBeenCalledWith("pinned", {})
		expect(outputChannel.appendLine).toHaveBeenCalledWith(
			expect.stringContaining("left the profile record 'pinned' unrestored"),
		)
		expect(managerSetModeConfig).toHaveBeenCalledWith("code", undefined)
	})
	it("replays what the store holds when the compensation restore itself fails", async () => {
		// The restore save is a write like the forward one, so its failure does not report which value the
		// record ended on. Assuming the prior record from the read taken before the write would replay that
		// guess to every sibling pinned to the profile, so the outcome is read from the store instead.
		const priorSettings = { apiProvider: providerIdentifiers.anthropic, apiKey: "prior-key" }
		const { api, store, refreshSpy, outputChannel } = makeRollbackHarness({
			records: { pinned: { id: "pinned-id", settings: priorSettings } },
			profileEntries: [{ name: "pinned", id: "pinned-id" }],
			snapshot: { currentApiConfigName: "pinned", apiProvider: providerIdentifiers.anthropic },
			compensationWrite: "save",
		})

		await expect(
			api.setConfiguration({
				currentApiConfigName: "pinned",
				apiKey: "this-call-key",
				modeApiConfigs: { code: "code-config" },
			}),
		).rejects.toThrow("mode write failed")

		expect(store.entries.get("pinned")?.settings).toEqual(expect.objectContaining({ apiKey: "this-call-key" }))
		expect(store.deleteConfig).not.toHaveBeenCalled()
		expect(refreshSpy).toHaveBeenCalledTimes(1)
		expect(refreshSpy).toHaveBeenCalledWith("pinned", expect.objectContaining({ apiKey: "this-call-key" }))
		expect(outputChannel.appendLine).toHaveBeenCalledWith(
			expect.stringContaining("failed to restore the profile record 'pinned'"),
		)
		expect(outputChannel.appendLine).toHaveBeenCalledWith(
			expect.stringContaining("refreshed from what the store holds now, not from the value the failed write"),
		)
	})
	it("replays the surviving record when the compensation delete fails", async () => {
		// A delete that rejects leaves the profile this call created in the store with this call settings.
		// Selecting an empty overlay because the delete was the write that ran would strip those credentials
		// from every sibling pinned to it, so the replay follows the record that survived instead.
		const { api, store, refreshSpy, outputChannel } = makeRollbackHarness({
			records: {},
			profileEntries: [{ name: "pinned", id: "created-id" }],
			snapshot: { currentApiConfigName: "pinned", apiProvider: providerIdentifiers.anthropic },
			compensationWrite: "delete",
		})

		await expect(
			api.setConfiguration({
				currentApiConfigName: "pinned",
				apiKey: "this-call-key",
				modeApiConfigs: { code: "code-config" },
			}),
		).rejects.toThrow("mode write failed")

		expect(store.entries.get("pinned")?.settings).toEqual(expect.objectContaining({ apiKey: "this-call-key" }))
		expect(refreshSpy).toHaveBeenCalledTimes(1)
		expect(refreshSpy).toHaveBeenCalledWith("pinned", expect.objectContaining({ apiKey: "this-call-key" }))
		expect(refreshSpy).not.toHaveBeenCalledWith("pinned", {})
		expect(outputChannel.appendLine).toHaveBeenCalledWith(
			expect.stringContaining("refreshed from what the store holds now, not from the value the failed write"),
		)
	})
	it("leaves the overlays alone when the compensation write and its confirmation read both fail", async () => {
		// The same rule one step further: a confirmation that cannot read leaves the outcome unconfirmed, and
		// an unconfirmed record gets no write - neither the restore the compensation wanted to make nor a
		// refresh of the overlays pinned to it. The mode mapping still rolls back.
		const priorSettings = { apiProvider: providerIdentifiers.anthropic, apiKey: "prior-key" }
		const { api, store, managerSetModeConfig, refreshSpy, outputChannel } = makeRollbackHarness({
			records: { pinned: { id: "pinned-id", settings: priorSettings } },
			profileEntries: [{ name: "pinned", id: "pinned-id" }],
			snapshot: { currentApiConfigName: "pinned", apiProvider: providerIdentifiers.anthropic },
			compensationWrite: "save",
			profileReader: ({ store: profileStore }) => {
				let reads = 0
				return async ({ name }: { name: string }) => {
					reads += 1
					if (reads >= 4) {
						throw new Error("confirmation read failed")
					}
					return profileStore.getProfile({ name })
				}
			},
		})

		await expect(
			api.setConfiguration({
				currentApiConfigName: "pinned",
				apiKey: "this-call-key",
				modeApiConfigs: { code: "code-config" },
			}),
		).rejects.toThrow("mode write failed")

		expect(store.entries.get("pinned")?.settings).toEqual(expect.objectContaining({ apiKey: "this-call-key" }))
		expect(refreshSpy).not.toHaveBeenCalled()
		expect(outputChannel.appendLine).toHaveBeenCalledWith(
			expect.stringContaining("the compensation write failed and the record could not be read afterwards"),
		)
		expect(outputChannel.appendLine).toHaveBeenCalledWith(
			expect.stringContaining("skipped refreshing the overlays pinned to 'pinned'"),
		)
		expect(managerSetModeConfig).toHaveBeenCalledWith("code", undefined)
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
				runExclusiveAcrossInstances: runManagerSectionInline,
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
			setModeConfig,
			// The window-local mode mapping ClineProvider keeps beside the store. The two
			// compensation seams delegate to the production methods instead of copying them.
			localModeConfigIds: new Map<string, string>(),
			getLocalModeConfigId(mode: Mode) {
				return ClineProvider.prototype.getLocalModeConfigId.call(this, mode)
			},
			restoreLocalModeConfig(mode: Mode, localId: string | undefined) {
				ClineProvider.prototype.restoreLocalModeConfig.call(this, mode, localId)
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

	it("names the profile the snapshot was on when the payload never carried the pin", async () => {
		// Which profile the views return to has to come from the snapshot the call captured. The
		// replay map only holds the keys this call wrote, so a payload that never carried
		// currentApiConfigName leaves the pin out of it: defaulting the name there refreshes the
		// overlays pinned to "default" with another profile settings and skips the credential
		// replay for the profile that was actually active.
		const store: Record<string, unknown> = {
			currentApiConfigName: "my-profile",
			apiProvider: providerIdentifiers.openrouter,
		}
		const setValues = vi.fn().mockResolvedValue(undefined)
		const profileStore = makeProfileStoreDouble({
			"my-profile": {
				id: "my-id",
				settings: { apiProvider: providerIdentifiers.openrouter, apiKey: "my-profile-key" },
			},
		})
		const setModeConfig = vi.fn().mockRejectedValue(new Error("mode write failed"))
		const refreshSpy = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const provider = {
			context: {},
			on: vi.fn(),
			log: vi.fn(),
			getProviderProfileEntries: vi.fn().mockReturnValue([{ name: "my-profile", id: "my-id" }]),
			// Live-backed so the snapshot is this view of the store at snapshot time.
			getValues: vi.fn(() => ({ ...store })),
			setValues,
			contextProxy: {
				getValue: vi.fn().mockReturnValue(undefined),
				setValues: vi.fn().mockResolvedValue(undefined),
				getProviderSettings: vi.fn().mockReturnValue({ apiProvider: providerIdentifiers.openrouter }),
				setProviderSettings: vi.fn().mockResolvedValue(undefined),
			},
			refreshViewLocalStateForUpdatedProfile: refreshSpy,
			providerSettingsManager: {
				runExclusiveAcrossInstances: runManagerSectionInline,
				hasConfig: profileStore.hasConfig,
				getProfile: profileStore.getProfile,
				saveConfig: profileStore.saveConfig,
				deleteConfig: profileStore.deleteConfig,
				setModeConfig,
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
			},
			setModeConfig,
			// The window-local mode mapping ClineProvider keeps beside the store. The two
			// compensation seams delegate to the production methods instead of copying them.
			localModeConfigIds: new Map<string, string>(),
			getLocalModeConfigId(mode: Mode) {
				return ClineProvider.prototype.getLocalModeConfigId.call(this, mode)
			},
			restoreLocalModeConfig(mode: Mode, localId: string | undefined) {
				ClineProvider.prototype.restoreLocalModeConfig.call(this, mode, localId)
			},
			postStateToWebview,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		// A payload that changes only a model setting: this call never touched the profile pin.
		await expect(
			api.setConfiguration({ apiModelId: "gpt-5-codex", modeApiConfigs: { code: "new-code-config" } }),
		).rejects.toThrow("mode write failed")

		// The saved profile falls back to "default" because the payload omitted the pin, but the
		// profile the overlays must be considered on again is the one the snapshot names, and that
		// profile overlays must be replayed from its own record.
		expect(setValues).toHaveBeenLastCalledWith(expect.any(Object), { savedProfileName: "my-profile" })
		expect(refreshSpy).toHaveBeenCalledWith("my-profile", expect.objectContaining({ apiKey: "my-profile-key" }))
		expect(postStateToWebview).not.toHaveBeenCalled()
	})

	describe("the display settings", () => {
		const setup = () => {
			const setValues = vi.fn().mockResolvedValue(undefined)
			const log = vi.fn()
			const profileStore = makeProfileStoreDouble()
			const provider = {
				context: {},
				on: vi.fn(),
				log,
				getValues: vi.fn().mockReturnValue({}),
				getProviderProfileEntries: vi.fn().mockReturnValue([]),
				// The settings write goes through the provider, which forwards to the shared store.
				setValues,
				contextProxy: {
					getValue: vi.fn().mockReturnValue(undefined),
					getProviderSettings: vi.fn().mockReturnValue({}),
					setValues,
				},
				providerSettingsManager: {
					// The store double answers the compensation re-read with the record this call saved,
					// which a static hasConfig mock cannot do: it answers "absent" on both readings.
					saveConfig: profileStore.saveConfig,
					deleteConfig: profileStore.deleteConfig,
					hasConfig: profileStore.hasConfig,
					getProfile: profileStore.getProfile,
					setModeConfig: vi.fn().mockResolvedValue(undefined),
					getModeConfigId: vi.fn().mockResolvedValue(undefined),
					runExclusiveAcrossInstances: runManagerSectionInline,
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

			// The settings write goes through the provider, which also carries the profile name the
			// sibling refresh has to agree with.
			expect(setValues).toHaveBeenCalledWith({ [key]: value }, { savedProfileName: "default" })
			expect(log).not.toHaveBeenCalled()
		})

		it("rejects when a setting cannot be stored, and writes nothing after the settings", async () => {
			const { api, setValues } = setup()
			setValues.mockRejectedValue(new Error("storage unavailable"))
			const provider = api["sidebarProvider"]

			await expect(api.setConfiguration({ timeFormat: "24h", currentApiConfigName: "default" })).rejects.toThrow(
				"storage unavailable",
			)

			// This unit persists the profile record before the settings - saveConfig validates first, so a
			// rejected save leaves every domain untouched - so the settings write is the one that fails
			// here. Nothing after it is reached, and the record the save already made is rolled back.
			expect(provider.providerSettingsManager.setModeConfig).not.toHaveBeenCalled()
			expect(provider.postStateToWebview).not.toHaveBeenCalled()
			expect(provider.providerSettingsManager.deleteConfig).toHaveBeenCalledWith("default")
		})

		it.each([
			["timeFormat", "13h"],
			["dateFormat", "dd/mm"],
			["showRelativeTimes", "yes"],
		])("ignores an invalid %s = %j, and keeps the other values", async (key, value) => {
			const { api, setValues, log } = setup()

			// A hand-written value that the typed signature does not allow.
			await api.setConfiguration({ [key]: value, soundEnabled: true } as unknown as RooCodeSettings)

			expect(setValues).toHaveBeenCalledWith({ soundEnabled: true }, { savedProfileName: "default" })
			expect(log).toHaveBeenCalledWith(`[setConfiguration] Ignored an invalid value for ${key}`)
		})
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

	it("strips legacy retired-provider credential fields from the flattened surface", () => {
		const getValues = vi.fn().mockReturnValue({
			mode: "code",
			currentApiConfigName: "retired-view-profile",
			apiConfiguration: {
				apiProvider: providerIdentifiers.anthropic,
				groqApiKey: "legacy-groq-secret",
				huggingFaceSecurityToken: "legacy-hf-secret",
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

		// Retired providers keep their legacy fields through passthrough; the
		// credential-shaped names must not reach the public API.
		expect(configuration).not.toHaveProperty("groqApiKey")
		expect(configuration).not.toHaveProperty("huggingFaceSecurityToken")
		expect(configuration.openRouterModelId).toBe("openai/gpt-4o")
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

	it("refuses a caller-supplied viewStates snapshot when writing configuration", async () => {
		const setValues = vi.fn().mockResolvedValue(undefined)
		const saveConfig = vi.fn().mockResolvedValue("default-id")
		const provider = {
			context: {},
			on: vi.fn(),
			log: vi.fn(),
			getProviderProfileEntries: vi.fn().mockReturnValue([]),
			// The settled setConfiguration reads the pre-write snapshot through
			// getConfiguration(), i.e. sidebarProvider.getValues(): the double hands it the same
			// host-owned map the caller tried to smuggle in, so the test proves both legs strip
			// the key - the payload the caller passed and the snapshot this call captured.
			getValues: vi.fn().mockReturnValue({
				currentApiConfigName: "default",
				apiProvider: providerIdentifiers.openai,
				viewStates: { "sidebar-1": { mode: "code", updatedAt: 1 } },
			}),
			setValues,
			contextProxy: {
				getValue: vi.fn().mockReturnValue(undefined),
				setValues,
				getProviderSettings: vi.fn().mockReturnValue({}),
			},
			providerSettingsManager: {
				runExclusiveAcrossInstances: runManagerSectionInline,
				saveConfig,
				hasConfig: vi.fn().mockResolvedValue(false),
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
			},
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
		// write nor the profile save may carry it back in. The second argument is the
		// sibling-refresh hint the settled write always passes.
		expect(setValues).toHaveBeenCalledWith(expect.not.objectContaining({ viewStates: expect.anything() }), {
			savedProfileName: "default",
		})
		expect(saveConfig).toHaveBeenCalledWith(
			"default",
			expect.not.objectContaining({ viewStates: expect.anything() }),
		)
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
})
