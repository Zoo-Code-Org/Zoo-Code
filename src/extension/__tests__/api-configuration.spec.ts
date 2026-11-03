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
})
