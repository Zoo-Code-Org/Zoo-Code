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
		const updateGlobalState = vi.fn().mockResolvedValue(undefined)
		const provider = {
			context: {},
			on: vi.fn(),
			contextProxy: { setValues, updateGlobalState },
			providerSettingsManager: { saveConfig, setModeConfig },
			postStateToWebview,
			getValue: vi.fn(),
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
		const updateGlobalState = vi.fn().mockResolvedValue(undefined)
		const provider = {
			context: {},
			on: vi.fn(),
			contextProxy: { setValues, updateGlobalState },
			providerSettingsManager: { saveConfig, setModeConfig },
			postStateToWebview,
			getValue: vi.fn(),
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
		// schema rejection, so this is one of the write paths where an off-list
		// mimoBaseUrl could newly enter storage. Both persistence calls are
		// asserted: the proxy write and the saved profile.
		// `storedBaseUrl` is deliberately `unknown`: storage is not schema-validated
		// on read, so the corrupted-value cases below need to inject a non-string.
		const makeApi = (storedBaseUrl?: unknown) => {
			const setValues = vi.fn().mockResolvedValue(undefined)
			const saveConfig = vi.fn().mockResolvedValue("default-id")
			const setModeConfig = vi.fn().mockResolvedValue(undefined)
			const postStateToWebview = vi.fn().mockResolvedValue(undefined)
			const updateGlobalState = vi.fn().mockResolvedValue(undefined)
			const provider = {
				context: {},
				on: vi.fn(),
				contextProxy: { setValues, updateGlobalState },
				providerSettingsManager: { saveConfig, setModeConfig },
				postStateToWebview,
				// The stored-value read goes through the provider-facing accessor, the
				// same one every other consumer uses, so the double only needs that.
				getValue: vi.fn((key: string) => (key === "mimoBaseUrl" ? storedBaseUrl : undefined)),
			} as unknown as ClineProvider
			const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel

			return {
				api: new API(outputChannel, provider, makeClineProviderFactory()),
				setValues,
				saveConfig,
				updateGlobalState,
			}
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

		it("purges a stored off-list mimoBaseUrl that a partial update would otherwise leave behind", async () => {
			// The stored value was written by an older build or another extension, so
			// the sanitizer never saw it. A partial update that omits mimoBaseUrl does
			// not overwrite it, so without an explicit purge the off-list endpoint
			// survives the call and keeps steering requests.
			const { api, setValues, updateGlobalState } = makeApi("https://attacker.example/v1")

			await api.setConfiguration({ currentApiConfigName: "default", apiModelId: "mimo-v2.6-pro" })

			expect(updateGlobalState).toHaveBeenCalledWith("mimoBaseUrl", undefined)
			expect(setValues).toHaveBeenCalledWith({
				currentApiConfigName: "default",
				apiModelId: "mimo-v2.6-pro",
			})
		})

		it("preserves a valid stored mimoBaseUrl during a partial update with rejected input", async () => {
			// The rejected input must not take the stored cluster down with it: only
			// the incoming value is dropped, and the stored allowlisted endpoint stays.
			const { api, setValues, updateGlobalState } = makeApi("https://token-plan-ams.xiaomimimo.com/v1")

			await api.setConfiguration(offListConfiguration("https://attacker.example/v1"))

			expect(updateGlobalState).not.toHaveBeenCalledWith("mimoBaseUrl", undefined)
			expect(setValues).toHaveBeenCalledWith(expect.not.objectContaining({ mimoBaseUrl: expect.anything() }))
		})

		it("does not purge a stored allowlisted mimoBaseUrl on a partial update", async () => {
			const { api, updateGlobalState } = makeApi("https://api.xiaomimimo.com/v1")

			await api.setConfiguration({ currentApiConfigName: "default", apiModelId: "mimo-v2.6-pro" })

			expect(updateGlobalState).not.toHaveBeenCalledWith("mimoBaseUrl", undefined)
		})

		it("does not purge a stored allowlisted mimoBaseUrl that carries a trailing slash", async () => {
			// setConfiguration persists a trailing-slash variant verbatim (see the
			// incoming-value case above), so this exact stored shape is reachable
			// through this very API. Only the slash-less literal is on the allowlist,
			// so a stored-value check that skipped stripTrailingSlashes would purge
			// every such cluster and silently drop the user to the default SGP one.
			const { api, updateGlobalState } = makeApi("https://token-plan-ams.xiaomimimo.com/v1/")

			await api.setConfiguration({ currentApiConfigName: "default", apiModelId: "mimo-v2.6-pro" })

			expect(updateGlobalState).not.toHaveBeenCalledWith("mimoBaseUrl", undefined)
		})

		it.each([[42], [{ nested: "https://attacker.example/v1" }], [true]])(
			"treats a non-string stored mimoBaseUrl (%s) as off-list instead of throwing",
			async (storedBaseUrl) => {
				// The stored read is typed `string | undefined`, but that is compile-time
				// only: ContextProxy hands back whatever the cache holds, and this helper
				// exists precisely because storage can carry values no schema ever saw.
				// stripTrailingSlashes calls .endsWith, so without a typeof guard a
				// corrupted value throws TypeError and rejects the whole configuration
				// write - a new failure mode in the scenario the helper targets.
				const { api, setValues, updateGlobalState } = makeApi(storedBaseUrl)

				await expect(
					api.setConfiguration({ currentApiConfigName: "default", apiModelId: "mimo-v2.6-pro" }),
				).resolves.toBeUndefined()

				expect(updateGlobalState).toHaveBeenCalledWith("mimoBaseUrl", undefined)
				expect(setValues).toHaveBeenCalledWith({
					currentApiConfigName: "default",
					apiModelId: "mimo-v2.6-pro",
				})
			},
		)
	})
})
