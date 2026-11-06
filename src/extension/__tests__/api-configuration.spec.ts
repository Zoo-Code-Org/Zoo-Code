import { describe, expect, it, vi } from "vitest"
import type * as vscode from "vscode"

import type { RooCodeSettings } from "@roo-code/types"

import { API } from "../api"
import { SettingsWriteError } from "../../core/config/ContextProxy"
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

	it("writes an appearance value through the per-key write chain, and the rest through setValues", async () => {
		const stored = new Map<string, unknown>([["terminalFontSize", 12]])
		const setValues = vi.fn().mockResolvedValue(undefined)
		const setValue = vi.fn(async (key: string, value: unknown) => {
			stored.set(key, value)
		})
		const provider = {
			context: {},
			on: vi.fn(),
			contextProxy: { getValue: (key: string) => stored.get(key), setValue, setValues },
			providerSettingsManager: { saveConfig: vi.fn().mockResolvedValue("id"), setModeConfig: vi.fn() },
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		await api.setConfiguration({ terminalFontSize: 14, mode: "code" })

		expect(setValue).toHaveBeenCalledExactlyOnceWith("terminalFontSize", 14)
		expect(setValues).toHaveBeenCalledExactlyOnceWith({ mode: "code" })
	})

	it.each([[999], [7], [12.5], ["12"]])(
		"rejects an out-of-range appearance value (%j) and stores nothing",
		async (value) => {
			const setValue = vi.fn()
			const setValues = vi.fn()
			const provider = {
				context: {},
				on: vi.fn(),
				contextProxy: { getValue: vi.fn(), setValue, setValues },
				providerSettingsManager: { saveConfig: vi.fn(), setModeConfig: vi.fn() },
				postStateToWebview: vi.fn(),
			} as unknown as ClineProvider
			const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
			const api = new API(outputChannel, provider, makeClineProviderFactory())

			await expect(
				api.setConfiguration({ terminalFontSize: value, mode: "code" } as unknown as RooCodeSettings),
			).rejects.toThrow("Invalid value for terminalFontSize")

			expect(setValue).not.toHaveBeenCalled()
			expect(setValues).not.toHaveBeenCalled()
			expect(provider.providerSettingsManager.saveConfig).not.toHaveBeenCalled()
		},
	)

	it("shows what is stored when a timed-out write has been rolled back", async () => {
		const chain = await import("../../core/config/appearanceSettingWrites")
		const spy = vi
			.spyOn(chain, "writeValuesThroughWriteChain")
			.mockResolvedValue({ stored: ["terminalFontSize"], notStored: [] })
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const provider = {
			context: {},
			on: vi.fn(),
			contextProxy: {},
			providerSettingsManager: { saveConfig: vi.fn().mockResolvedValue("id"), setModeConfig: vi.fn() },
			postStateToWebview,
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		await api.setConfiguration({ terminalFontSize: 14 })
		expect(postStateToWebview).toHaveBeenCalledTimes(1) // the one after the write
		spy.mock.calls[0][2]?.onDeferredSettled?.() // the rollback of a timed-out write is over

		expect(postStateToWebview).toHaveBeenCalledTimes(2)
		spy.mockRestore()
	})

	it("puts an appearance value back when its write fails, and rejects", async () => {
		const stored = new Map<string, unknown>([["terminalFontSize", 12]])
		const provider = {
			context: {},
			on: vi.fn(),
			contextProxy: {
				getValue: (key: string) => stored.get(key),
				setValue: async (key: string, value: unknown) => {
					stored.set(key, value)
					if (value === 14) throw new Error("failed after storing")
				},
				setValues: vi.fn().mockResolvedValue(undefined),
			},
			providerSettingsManager: { saveConfig: vi.fn(), setModeConfig: vi.fn() },
			postStateToWebview: vi.fn(),
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		await expect(api.setConfiguration({ terminalFontSize: 14 })).rejects.toThrow("failed after storing")

		expect(stored.get("terminalFontSize")).toBe(12)
	})

	describe("when a setting cannot be stored", () => {
		const setup = (postStateToWebview = vi.fn().mockResolvedValue(undefined)) => {
			const stored = new Map<string, unknown>([["terminalFontSize", 12]])
			const failure = new Error("storage unavailable")
			const provider = {
				context: {},
				on: vi.fn(),
				log: vi.fn(),
				contextProxy: {
					getValue: (key: string) => stored.get(key),
					setValue: async (key: string, value: unknown) => void stored.set(key, value),
					setValues: vi.fn().mockRejectedValue(failure), // the other settings fail
				},
				providerSettingsManager: { saveConfig: vi.fn(), setModeConfig: vi.fn() },
				postStateToWebview,
			} as unknown as ClineProvider
			const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
			return {
				api: new API(outputChannel, provider, makeClineProviderFactory()),
				provider,
				failure,
				postStateToWebview,
			}
		}

		it("shows the webview what is stored, and rejects with an error that names what was stored and what was not", async () => {
			const { api, provider, failure, postStateToWebview } = setup()

			await expect(api.setConfiguration({ terminalFontSize: 14, soundEnabled: true })).rejects.toMatchObject({
				name: "PartialSettingsWriteError",
				message: "storage unavailable (not stored: the other settings; stored: terminalFontSize)",
				stored: ["terminalFontSize"],
				notStored: ["the other settings"],
				cause: failure, // the failure itself is kept
			})

			expect(postStateToWebview).toHaveBeenCalledTimes(1)
			expect(provider.providerSettingsManager.saveConfig).not.toHaveBeenCalled() // nothing after the settings
		})

		it("names the other settings that were stored and those that were not, when the store says which", async () => {
			const { api, provider } = setup()
			const cause = new Error("secret storage unavailable")
			vi.mocked(provider.contextProxy.setValues).mockRejectedValue(
				new SettingsWriteError(["mode"], ["soundEnabled"], cause),
			)

			await expect(api.setConfiguration({ mode: "code", soundEnabled: true })).rejects.toMatchObject({
				name: "PartialSettingsWriteError",
				message: "secret storage unavailable (not stored: soundEnabled; stored: mode)",
				stored: ["mode"],
				notStored: ["soundEnabled"],
				cause,
			})
		})

		it("rejects with the original error when a write failed on its own and nothing else was stored", async () => {
			const { api, provider } = setup()
			const failure = new SettingsWriteError([], ["soundEnabled"], new Error("secret storage unavailable"))
			vi.mocked(provider.contextProxy.setValues).mockRejectedValue(failure)

			await expect(api.setConfiguration({ soundEnabled: true })).rejects.toBe(failure)
		})

		it("does not let a failed refresh hide the original error", async () => {
			const { api, failure, postStateToWebview } = setup(vi.fn().mockRejectedValue(new Error("webview gone")))

			await expect(api.setConfiguration({ soundEnabled: true })).rejects.toBe(failure)

			expect(postStateToWebview).toHaveBeenCalledTimes(1)
		})

		it("does not refresh anything when all the settings are stored, other than the one refresh after the profiles", async () => {
			const { api, provider, postStateToWebview } = setup()
			vi.mocked(provider.contextProxy.setValues).mockResolvedValue(undefined)

			await api.setConfiguration({ soundEnabled: true })

			expect(postStateToWebview).toHaveBeenCalledTimes(1) // the existing refresh at the end
		})
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
			// The webview is shown what is stored, though: some of the settings may have been.
			expect(provider.postStateToWebview).toHaveBeenCalledTimes(1)
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
