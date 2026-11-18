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
			getProviderProfileEntries: vi.fn().mockReturnValue([
				{
					name: "default",
					id: "default-id",
				},
			]),
			getValues: vi.fn().mockReturnValue({}),
			setValues: vi.fn().mockResolvedValue(undefined),
			contextProxy: {
				getValue: vi.fn().mockReturnValue(undefined),
				setValues: vi.fn().mockResolvedValue(undefined),
				getProviderSettings: vi.fn().mockReturnValue({}),
			},
			providerSettingsManager: {
				// A single view holds no other claim on the cross-instance section: run it inline.
				runExclusiveAcrossInstances: <T>(cb: () => Promise<T>): Promise<T> => cb(),
				saveConfig: vi.fn().mockResolvedValue("default-id"),
				// The accept path records whether the profile existed before saving; without it
				// the call throws and the test only passes through the catch fallback.
				hasConfig: vi.fn().mockResolvedValue(true),
				getProfile: vi.fn().mockResolvedValue({
					name: "default",
					id: "default-id",
					apiProvider: providerIdentifiers.bedrock,
				}),
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
		// The second argument carries the profile record that actually landed in the
		// cross-instance section - what the store reports after saving, here the
		// record minus its name/id pair - rather than a reconstruction from the payload.
		expect(provider.setValues).toHaveBeenCalledWith(configuration, {
			savedProfileName: "default",
			savedProfileSettings: { apiProvider: providerIdentifiers.bedrock },
		})
		expect(provider.contextProxy.setValues).not.toHaveBeenCalled()
		expect(provider.providerSettingsManager.saveConfig).toHaveBeenCalledTimes(1)
		expect(provider.providerSettingsManager.saveConfig).toHaveBeenCalledWith("default", configuration)
		expect(provider.providerSettingsManager.hasConfig).toHaveBeenCalledWith("default")
		expect(provider.postStateToWebview).toHaveBeenCalledTimes(1)
	})

	function setConfigurationHarness(
		overrides: {
			provider?: Record<string, unknown>
			manager?: Record<string, unknown>
			channel?: Record<string, unknown>
			enableLogging?: boolean
		} = {},
	) {
		const provider = Object.assign({} as ClineProvider, {
			context: {},
			on: vi.fn(),
			getProviderProfileEntries: vi.fn().mockReturnValue([{ name: "default", id: "default-id" }]),
			getValues: vi.fn().mockReturnValue({}),
			setValues: vi.fn().mockResolvedValue(undefined),
			contextProxy: {
				getValue: vi.fn().mockReturnValue(undefined),
				setValues: vi.fn().mockResolvedValue(undefined),
				setProviderSettings: vi.fn().mockResolvedValue(undefined),
				getProviderSettings: vi.fn().mockReturnValue({}),
			},
			providerSettingsManager: {
				runExclusiveAcrossInstances: <T>(cb: () => Promise<T>): Promise<T> => cb(),
				saveConfig: vi.fn().mockResolvedValue("default-id"),
				hasConfig: vi.fn().mockResolvedValue(true),
				getProfile: vi.fn().mockResolvedValue({
					name: "default",
					id: "default-id",
					apiProvider: providerIdentifiers.bedrock,
				}),
				deleteConfig: vi.fn().mockResolvedValue(undefined),
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
				setModeConfig: vi.fn().mockResolvedValue(undefined),
				...(overrides.manager ?? {}),
			},
			customModesManager: {
				getCustomModes: vi.fn().mockResolvedValue([]),
				updateCustomMode: vi.fn().mockResolvedValue(undefined),
				deleteCustomMode: vi.fn().mockResolvedValue(undefined),
			},
			refreshViewLocalStateForUpdatedProfile: vi.fn().mockResolvedValue(undefined),
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			...(overrides.provider ?? {}),
		})
		const channel = Object.assign({} as OutputChannel, { appendLine: vi.fn() }, overrides.channel ?? {})
		// Logging stays off unless a test asks for it: with it on, this.log reaches the channel,
		// which is the only way a test can see a restore-failure line.
		const api = new API(channel, provider, makeClineProviderFactory(), undefined, overrides.enableLogging ?? false)
		return { provider, api, channel }
	}

	const reviewerMode = {
		slug: "review-crew",
		name: "Review crew",
		roleDefinition: "Review the diff before it merges",
		groups: [],
	}

	it("registers a mode definition the payload carries before the call reports success", async () => {
		const order: string[] = []
		const { provider, api } = setConfigurationHarness({
			provider: {
				setValues: vi.fn().mockImplementation(async () => {
					order.push("settings")
				}),
				customModesManager: {
					getCustomModes: vi.fn().mockResolvedValue([]),
					updateCustomMode: vi.fn().mockImplementation(async () => {
						order.push("mode")
					}),
					deleteCustomMode: vi.fn().mockResolvedValue(undefined),
				},
				postStateToWebview: vi.fn().mockImplementation(async () => {
					order.push("post")
				}),
			},
		})

		await api.setConfiguration({
			apiProvider: providerIdentifiers.bedrock,
			currentApiConfigName: "default",
			mode: reviewerMode.slug,
			customModes: [reviewerMode],
		})

		// The definition reaches the modes manager, not just the slug: a task validated
		// against the store-backed list would otherwise reject the mode this call selected.
		expect(provider.customModesManager.updateCustomMode).toHaveBeenCalledTimes(1)
		expect(provider.customModesManager.updateCustomMode).toHaveBeenCalledWith(reviewerMode.slug, reviewerMode)
		expect(order).toEqual(["settings", "mode", "post"])
	})

	it("a rejected mode definition fails the call and removes the definition it added", async () => {
		const { provider, api } = setConfigurationHarness({
			provider: {
				customModesManager: {
					getCustomModes: vi.fn().mockResolvedValue([]),
					updateCustomMode: vi.fn().mockRejectedValue(new Error("Invalid mode configuration")),
					deleteCustomMode: vi.fn().mockResolvedValue(undefined),
				},
			},
			manager: {
				// Absent before the save, present when the rollback re-reads, so the rollback
				// deletes the record this call created instead of stopping at an early return.
				hasConfig: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
			},
		})

		await expect(
			api.setConfiguration({
				apiProvider: providerIdentifiers.bedrock,
				currentApiConfigName: "default",
				mode: reviewerMode.slug,
				customModes: [reviewerMode],
			}),
		).rejects.toThrow("Invalid mode configuration")

		expect(provider.customModesManager.deleteCustomMode).toHaveBeenCalledWith(reviewerMode.slug)
		expect(provider.providerSettingsManager.deleteConfig).toHaveBeenCalledWith("default")
		expect(provider.postStateToWebview).not.toHaveBeenCalled()
	})

	it("puts a prior mode definition back when a rejected call had overwritten it", async () => {
		const priorDefinition = {
			slug: reviewerMode.slug,
			name: "Review crew draft",
			roleDefinition: "Read the diff",
			groups: [],
		}
		const archivedDefinition = {
			slug: "archive-reader",
			name: "Archive reader",
			roleDefinition: "Summarise the archive",
			groups: [],
		}
		const restoreCalls: { name: string }[] = []
		const updateCustomMode = vi.fn().mockImplementation(async (_slug: string, definition: { name: string }) => {
			if (definition.name === reviewerMode.name) {
				throw new Error("Mode store rejected the write")
			}
			restoreCalls.push(definition)
		})
		const deleteCustomMode = vi.fn().mockResolvedValue(undefined)
		// An unrelated definition sits first in the store so the prior read has to match on slug.
		const storedDefinitions = [archivedDefinition, priorDefinition]
		const { provider, api } = setConfigurationHarness({
			provider: {
				customModesManager: {
					getCustomModes: vi.fn().mockResolvedValue(storedDefinitions),
					updateCustomMode,
					deleteCustomMode,
				},
			},
			manager: {
				hasConfig: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
			},
		})

		await expect(
			api.setConfiguration({
				apiProvider: providerIdentifiers.bedrock,
				currentApiConfigName: "default",
				mode: reviewerMode.slug,
				customModes: [reviewerMode],
			}),
		).rejects.toThrow("Mode store rejected the write")

		// The slug had a definition before this call, so the rollback restores that definition
		// rather than deleting the slug out from under the view that still lists it.
		expect(restoreCalls).toEqual([priorDefinition])
		expect(deleteCustomMode).not.toHaveBeenCalled()
		expect(provider.postStateToWebview).not.toHaveBeenCalled()
	})

	it("keeps the modes manager out of a call that carried no definitions", async () => {
		const { provider, api } = setConfigurationHarness()

		await api.setConfiguration({
			apiProvider: providerIdentifiers.bedrock,
			currentApiConfigName: "default",
		})

		// Nothing was supplied, so the prior read is skipped and nothing is registered:
		// a payload without definitions must not spend a store read or a store write.
		expect(provider.customModesManager.getCustomModes).not.toHaveBeenCalled()
		expect(provider.customModesManager.updateCustomMode).not.toHaveBeenCalled()
		expect(provider.customModesManager.deleteCustomMode).not.toHaveBeenCalled()
		expect(provider.postStateToWebview).toHaveBeenCalledTimes(1)
	})

	it("rolls back a failed call with no definitions without touching the modes manager", async () => {
		const { provider, api } = setConfigurationHarness({
			provider: {
				setValues: vi.fn().mockRejectedValue(new Error("Settings write refused")),
			},
		})

		await expect(
			api.setConfiguration({
				apiProvider: providerIdentifiers.bedrock,
				currentApiConfigName: "default",
			}),
		).rejects.toThrow("Settings write refused")

		expect(provider.customModesManager.updateCustomMode).not.toHaveBeenCalled()
		expect(provider.customModesManager.deleteCustomMode).not.toHaveBeenCalled()
		expect(provider.postStateToWebview).not.toHaveBeenCalled()
	})

	it("logs a mode restore that failed and still throws the error the caller caused", async () => {
		const appendLine = vi.fn()
		const { provider, api } = setConfigurationHarness({
			channel: { appendLine },
			enableLogging: true,
			provider: {
				customModesManager: {
					getCustomModes: vi.fn().mockResolvedValue([]),
					updateCustomMode: vi.fn().mockRejectedValue(new Error("Store refused the definition")),
					deleteCustomMode: vi.fn().mockRejectedValue(new Error("Store refused the undo")),
				},
			},
			manager: {
				// Absent before the save, present when the rollback re-reads, so the undo runs.
				hasConfig: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
			},
		})

		await expect(
			api.setConfiguration({
				apiProvider: providerIdentifiers.bedrock,
				currentApiConfigName: "default",
				mode: reviewerMode.slug,
				customModes: [reviewerMode],
			}),
		).rejects.toThrow("Store refused the definition")

		// The undo failed as well as the write, so the caller sees both halves: the original
		// error rethrows and the failed restore is logged like every other restore here.
		const logged = appendLine.mock.calls.map((call: unknown[]) => String(call[0]))
		const restoreLines = logged.filter((line: string) =>
			line.startsWith("[setConfiguration] failed to restore the mode definitions this call wrote: "),
		)
		expect(restoreLines).toHaveLength(1)
		expect(restoreLines[0]).toContain("Store refused the undo")
		expect(provider.customModesManager.deleteCustomMode).toHaveBeenCalledWith(reviewerMode.slug)
		expect(provider.postStateToWebview).not.toHaveBeenCalled()
	})

	it("forwards the settings that landed when the store derives a provider the payload omitted", async () => {
		const { provider, api } = setConfigurationHarness({
			manager: {
				// saveConfig normalizes before it stores. Given a model id and a key with no
				// provider, the record that lands names the provider it derived, and the read-back
				// inside the critical section reports exactly that record rather than the payload.
				getProfile: vi.fn().mockResolvedValue({
					name: "default",
					id: "default-id",
					apiProvider: providerIdentifiers.openai,
					apiModelId: "gpt-4.1",
					apiKey: "sk-test-key",
				}),
			},
		})

		await api.setConfiguration({
			apiModelId: "gpt-4.1",
			apiKey: "sk-test-key",
			currentApiConfigName: "default",
		})

		// The save still receives the payload: the store owns normalization, so this call
		// keeps handing it what the caller wrote.
		expect(provider.providerSettingsManager.saveConfig).toHaveBeenCalledWith("default", {
			apiModelId: "gpt-4.1",
			apiKey: "sk-test-key",
			currentApiConfigName: "default",
		})
		// The configuration write must name the provider the record carries. A copy of the
		// payload alone leaves the store on a pair with no provider while every reader that
		// goes through the record sees the one the store derived.
		expect(provider.setValues).toHaveBeenCalledWith(
			{
				apiProvider: providerIdentifiers.openai,
				apiModelId: "gpt-4.1",
				apiKey: "sk-test-key",
				currentApiConfigName: "default",
			},
			{
				savedProfileName: "default",
				savedProfileSettings: {
					apiProvider: providerIdentifiers.openai,
					apiModelId: "gpt-4.1",
					apiKey: "sk-test-key",
				},
			},
		)
		expect(provider.setValues).toHaveBeenCalledTimes(1)
	})
})
