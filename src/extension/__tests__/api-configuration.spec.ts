import { describe, expect, it, vi } from "vitest"
import type * as vscode from "vscode"

import type { RooCodeSettings } from "@roo-code/types"

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
			log: vi.fn(),
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

	it("drops a caller-supplied viewStates map so the registered map stays host-written", async () => {
		const setValues = vi.fn().mockResolvedValue(undefined)
		const saveConfig = vi.fn().mockResolvedValue("default-id")
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const log = vi.fn()
		const provider = {
			context: {},
			on: vi.fn(),
			log,
			contextProxy: { setValues },
			providerSettingsManager: { saveConfig, setModeConfig: vi.fn().mockResolvedValue(undefined) },
			postStateToWebview,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		// The registered map is written by the extension host from a full read of storage, so a map handed in by
		// an API caller replaces every other view's durable entry in globalState and in the profile file written
		// from the same object. An explicit unset is the same hazard, since ContextProxy reads undefined as a
		// delete. The rest of the settings object is the caller's to set.
		await api.setConfiguration({
			viewStates: { "crafted-view": { mode: "ask", currentApiConfigName: "crafted" } },
			soundEnabled: true,
		} as unknown as RooCodeSettings)

		expect(setValues).toHaveBeenCalledWith({ soundEnabled: true })
		expect(saveConfig).toHaveBeenCalledWith("default", { soundEnabled: true })
		expect(log).toHaveBeenCalledWith(
			"[setConfiguration] Ignored a caller-supplied viewStates map; the registered map is written by the extension host.",
		)
	})

	// An explicit unset is the same hazard as a crafted map, because ContextProxy reads an undefined value as a
	// delete (the repo relies on update(key, undefined) at ContextProxy.ts:173, :280-282, :305 and :346), and
	// withoutInvalidDisplaySettings cannot catch it either - it filters by Object.entries, so a key holding
	// undefined survives it. toHaveBeenCalledWith compares the way toEqual does and ignores undefined-valued
	// keys, so the loose assertions alone could not tell a dropped key from a forwarded undefined; the strict
	// assertions on the captured arguments are what carry the teeth here.
	it("drops an explicitly unset viewStates value before either write", async () => {
		const setValues = vi.fn().mockResolvedValue(undefined)
		const saveConfig = vi.fn().mockResolvedValue("default-id")
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const log = vi.fn()
		const provider = {
			context: {},
			on: vi.fn(),
			log,
			contextProxy: { setValues },
			providerSettingsManager: { saveConfig, setModeConfig: vi.fn().mockResolvedValue(undefined) },
			postStateToWebview,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		await api.setConfiguration({ viewStates: undefined, soundEnabled: true } as unknown as RooCodeSettings)

		const [valuesArgument] = setValues.mock.calls[0] as [RooCodeSettings]
		const [savedName, savedArgument] = saveConfig.mock.calls[0] as [string, RooCodeSettings]
		expect(savedName).toBe("default")
		expect(valuesArgument).toStrictEqual({ soundEnabled: true })
		expect(savedArgument).toStrictEqual({ soundEnabled: true })
		expect(setValues).toHaveBeenCalledWith({ soundEnabled: true })
		expect(saveConfig).toHaveBeenCalledWith("default", { soundEnabled: true })
		expect(log).toHaveBeenCalledWith(
			"[setConfiguration] Ignored a caller-supplied viewStates map; the registered map is written by the extension host.",
		)
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
