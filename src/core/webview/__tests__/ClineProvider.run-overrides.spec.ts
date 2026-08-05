import { describe, expect, it, vi } from "vitest"

import type { ProviderSettings } from "@roo-code/types"

import { ClineProvider } from "../ClineProvider"

describe("ClineProvider run overrides", () => {
	function createResolverHost(profile: ProviderSettings = { apiProvider: "anthropic", apiModelId: "profile-model" }) {
		return {
			providerSettingsManager: {
				getProfile: vi.fn().mockResolvedValue(profile),
				activateProfile: vi.fn(),
				saveConfig: vi.fn(),
			},
			customModesManager: { getCustomModes: vi.fn().mockResolvedValue([]) },
			setValues: vi.fn(),
			setMode: vi.fn(),
		}
	}

	it("resolves provider, model, mode, reasoning, and approval without persistence", async () => {
		const host = createResolverHost()
		const result = await ClineProvider.prototype["resolveRunOverrides"].call(
			// The resolver touches only the explicit read-only collaborators above.
			host as unknown as ClineProvider,
			{ provider: "openrouter", model: "openai/model", mode: "code", reasoningEffort: "high", approval: "safe" },
			{ apiProvider: "anthropic", apiModelId: "persisted-model" },
		)
		expect(result).toMatchObject({
			mode: "code",
			apiConfiguration: {
				apiProvider: "openrouter",
				openRouterModelId: "openai/model",
				enableReasoningEffort: true,
				reasoningEffort: "high",
			},
		})
		expect(host.setValues).not.toHaveBeenCalled()
		expect(host.setMode).not.toHaveBeenCalled()
		expect(host.providerSettingsManager.activateProfile).not.toHaveBeenCalled()
		expect(host.providerSettingsManager.saveConfig).not.toHaveBeenCalled()
	})

	it("loads a profile read-only and rejects provider/profile ambiguity", async () => {
		const host = createResolverHost({ apiProvider: "openrouter", openRouterModelId: "profile-model" })
		const result = await ClineProvider.prototype["resolveRunOverrides"].call(
			host as unknown as ClineProvider,
			{ profile: "ci", model: "override-model", mode: "code" },
			{ apiProvider: "anthropic" },
		)
		expect(host.providerSettingsManager.getProfile).toHaveBeenCalledWith({ name: "ci" })
		expect(result.profile).toBe("ci")
		expect(result.apiConfiguration.openRouterModelId).toBe("override-model")
		await expect(
			ClineProvider.prototype["resolveRunOverrides"].call(
				host as unknown as ClineProvider,
				{ profile: "ci", provider: "anthropic" },
				{ apiProvider: "anthropic" },
			),
		).rejects.toThrow("mutually exclusive")
	})

	it("covers generic models, disabled reasoning, and invalid override values", async () => {
		const host = createResolverHost()
		const baseline = { apiProvider: "openai", apiModelId: "baseline" } as ProviderSettings
		const result = await ClineProvider.prototype["resolveRunOverrides"].call(
			host as unknown as ClineProvider,
			{ model: "generic", mode: "code", reasoningEffort: "disabled" },
			baseline,
		)
		expect(result.apiConfiguration).toMatchObject({
			apiModelId: "generic",
			enableReasoningEffort: false,
			reasoningEffort: undefined,
		})

		await expect(
			ClineProvider.prototype["resolveRunOverrides"].call(
				host as unknown as ClineProvider,
				{ provider: "missing-provider", mode: "code" },
				baseline,
			),
		).rejects.toThrow("Unknown provider override")
		await expect(
			ClineProvider.prototype["resolveRunOverrides"].call(
				host as unknown as ClineProvider,
				{ mode: "missing-mode" },
				baseline,
			),
		).rejects.toThrow("Unknown mode override")
	})

	it("rejects combining persistent configuration with run overrides", async () => {
		await expect(
			ClineProvider.prototype.createTask.call(
				createResolverHost() as unknown as ClineProvider,
				"task",
				undefined,
				undefined,
				{},
				{ allowedCommands: ["echo"] },
				{ mode: "code" },
			),
		).rejects.toThrow("Persistent configuration and run overrides cannot be combined")
	})
})
