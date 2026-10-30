import { describe, expect, it, vi } from "vitest"
import type * as vscode from "vscode"

import { providerIdentifiers, type RooCodeSettings } from "@roo-code/types"

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

	it("excludes mimoApiKey from getConfiguration while keeping non-secret MiMo settings", () => {
		const provider = {
			context: {},
			on: vi.fn(),
			getValues: () => ({
				apiProvider: providerIdentifiers.mimo,
				mimoApiKey: "mimo-secret-key",
				mimoBaseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
				apiModelId: "mimo-v2.6-pro",
			}),
			// Double assertion: this filter-focused spec only needs the two members
			// the API surface touches; a full ClineProvider test double is out of
			// scope (the upstream siblings above use the same pattern).
		} as unknown as ClineProvider
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider, makeClineProviderFactory())

		const configuration = api.getConfiguration()

		expect(configuration).not.toHaveProperty("mimoApiKey")
		expect(configuration.mimoBaseUrl).toBe("https://token-plan-sgp.xiaomimimo.com/v1")
		expect(configuration.apiModelId).toBe("mimo-v2.6-pro")
	})

	describe("mimoBaseUrl allowlist at the public API boundary", () => {
		// setConfiguration writes straight to ContextProxy, which fails open on a
		// schema rejection, so this was the one write path where an off-list
		// mimoBaseUrl could newly enter storage. Both persistence calls are
		// asserted: the proxy write and the saved profile.
		const makeApi = () => {
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

			return { api: new API(outputChannel, provider, makeClineProviderFactory()), setValues, saveConfig }
		}

		// The declared type is the four-literal union, so an off-list value needs
		// the same widening the guard itself documents: callers of this public API
		// are not the schema.
		const offListConfiguration = (mimoBaseUrl: string): RooCodeSettings =>
			({ currentApiConfigName: "default", mimoBaseUrl }) as unknown as RooCodeSettings

		it("drops an off-list mimoBaseUrl instead of persisting it", async () => {
			const { api, setValues, saveConfig } = makeApi()

			await api.setConfiguration(offListConfiguration("https://attacker.example/v1"))

			expect(setValues).toHaveBeenCalledWith(expect.not.objectContaining({ mimoBaseUrl: expect.anything() }))
			expect(saveConfig).toHaveBeenCalledWith(
				"default",
				expect.not.objectContaining({ mimoBaseUrl: expect.anything() }),
			)
			expect(setValues.mock.calls[0][0]).not.toHaveProperty("mimoBaseUrl")
			expect(saveConfig.mock.calls[0][1]).not.toHaveProperty("mimoBaseUrl")
		})

		it.each([
			"https://api.xiaomimimo.com/v1",
			"https://token-plan-cn.xiaomimimo.com/v1",
			"https://token-plan-sgp.xiaomimimo.com/v1",
			"https://token-plan-ams.xiaomimimo.com/v1",
		])("persists the allowlisted endpoint %s", async (mimoBaseUrl) => {
			const { api, setValues, saveConfig } = makeApi()

			await api.setConfiguration(offListConfiguration(mimoBaseUrl))

			expect(setValues).toHaveBeenCalledWith(expect.objectContaining({ mimoBaseUrl }))
			expect(saveConfig).toHaveBeenCalledWith("default", expect.objectContaining({ mimoBaseUrl }))
		})

		it("persists a trailing-slash variant of an allowlisted endpoint", async () => {
			const { api, setValues } = makeApi()

			await api.setConfiguration(offListConfiguration("https://token-plan-sgp.xiaomimimo.com/v1/"))

			expect(setValues).toHaveBeenCalledWith(
				expect.objectContaining({ mimoBaseUrl: "https://token-plan-sgp.xiaomimimo.com/v1/" }),
			)
		})

		it("keeps an empty mimoBaseUrl so 'unset' still means the default cluster", async () => {
			const { api, setValues } = makeApi()

			await api.setConfiguration(offListConfiguration(""))

			expect(setValues).toHaveBeenCalledWith(expect.objectContaining({ mimoBaseUrl: "" }))
		})

		it("leaves configurations without mimoBaseUrl untouched", async () => {
			const { api, setValues } = makeApi()

			await api.setConfiguration({ currentApiConfigName: "default", apiModelId: "mimo-v2.6-pro" })

			expect(setValues).toHaveBeenCalledWith({
				currentApiConfigName: "default",
				apiModelId: "mimo-v2.6-pro",
			})
		})
	})
})
