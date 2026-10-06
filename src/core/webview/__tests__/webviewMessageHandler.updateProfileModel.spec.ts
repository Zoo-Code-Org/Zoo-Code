// npx vitest run core/webview/__tests__/webviewMessageHandler.updateProfileModel.spec.ts

import * as vscode from "vscode"

vi.mock("vscode", () => ({ window: { showErrorMessage: vi.fn() } }))

import { providerIdentifiers } from "@roo-code/types"

import { webviewMessageHandler } from "../webviewMessageHandler"
import type { ClineProvider } from "../ClineProvider"

describe("webviewMessageHandler - updateProfileModel", () => {
	let mockProvider: {
		log: ReturnType<typeof vi.fn>
		upsertProviderProfile: ReturnType<typeof vi.fn>
		providerSettingsManager: { getProfile: ReturnType<typeof vi.fn> }
	}

	const storedProfile = {
		name: "default",
		id: "profile-1",
		apiProvider: providerIdentifiers.anthropic,
		apiModelId: "claude-sonnet-4-5",
		apiKey: "stored-key",
		reasoningEffort: "high",
		modelMaxTokens: 4096,
	}

	const send = (values: Record<string, unknown>, text: string = "default") =>
		webviewMessageHandler(mockProvider as unknown as ClineProvider, { type: "updateProfileModel", text, values })

	beforeEach(() => {
		vi.clearAllMocks()
		mockProvider = {
			log: vi.fn(),
			upsertProviderProfile: vi.fn().mockResolvedValue("profile-1"),
			providerSettingsManager: { getProfile: vi.fn().mockResolvedValue(storedProfile) },
		}
	})

	it("merges the patch onto the stored profile, clearing null fields", async () => {
		await send({
			expectedProvider: providerIdentifiers.anthropic,
			patch: { apiModelId: "claude-3-5-haiku", reasoningEffort: null, modelMaxTokens: null },
		})

		expect(mockProvider.providerSettingsManager.getProfile).toHaveBeenCalledWith({ name: "default" })
		expect(mockProvider.upsertProviderProfile).toHaveBeenCalledTimes(1)
		expect(mockProvider.upsertProviderProfile).toHaveBeenCalledWith("default", {
			id: "profile-1",
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "claude-3-5-haiku",
			apiKey: "stored-key",
			reasoningEffort: undefined,
			modelMaxTokens: undefined,
		})
	})

	it("rejects the update when the stored provider differs from the expected provider", async () => {
		await send({ expectedProvider: providerIdentifiers.openrouter, patch: { openRouterModelId: "x/y" } })

		expect(mockProvider.upsertProviderProfile).not.toHaveBeenCalled()
		expect(mockProvider.log).toHaveBeenCalledWith(
			expect.stringContaining(`expected '${providerIdentifiers.openrouter}'`),
		)
	})

	it("ignores non-setting keys, apiProvider, own __proto__ keys and non-primitive values", async () => {
		const patch = JSON.parse(
			'{"apiModelId":"claude-3-5-haiku","notASetting":"evil","apiProvider":"openrouter","__proto__":{"polluted":true},"apiKey":{"nested":1}}',
		)

		await send({ expectedProvider: providerIdentifiers.anthropic, patch })

		const saved = mockProvider.upsertProviderProfile.mock.calls[0][1]
		expect(saved).not.toHaveProperty("notASetting")
		expect(saved).not.toHaveProperty("polluted")
		expect(Object.getPrototypeOf(saved)).toBe(Object.prototype)
		expect(saved.apiProvider).toBe(providerIdentifiers.anthropic)
		expect(saved.apiKey).toBe("stored-key")
		expect(saved.apiModelId).toBe("claude-3-5-haiku")
	})

	it("treats a profile without apiProvider as OpenRouter", async () => {
		const { apiProvider: _apiProvider, ...withoutProvider } = storedProfile
		mockProvider.providerSettingsManager.getProfile.mockResolvedValue(withoutProvider)

		await send({ expectedProvider: providerIdentifiers.openrouter, patch: { openRouterModelId: "x/y" } })

		expect(mockProvider.upsertProviderProfile).toHaveBeenCalledWith(
			"default",
			expect.objectContaining({ openRouterModelId: "x/y" }),
		)
	})

	it.each([
		["missing profile name", { expectedProvider: providerIdentifiers.anthropic, patch: {} }, ""],
		["missing expectedProvider", { patch: { apiModelId: "x" } }, "default"],
		["missing patch", { expectedProvider: providerIdentifiers.anthropic }, "default"],
		["null patch", { expectedProvider: providerIdentifiers.anthropic, patch: null }, "default"],
	])("does nothing for %s", async (_label, values, text) => {
		await send(values, text)

		expect(mockProvider.providerSettingsManager.getProfile).not.toHaveBeenCalled()
		expect(mockProvider.upsertProviderProfile).not.toHaveBeenCalled()
	})

	it("reports an error without saving when the profile cannot be loaded", async () => {
		mockProvider.providerSettingsManager.getProfile.mockRejectedValue(new Error("not found"))

		await send({ expectedProvider: providerIdentifiers.anthropic, patch: { apiModelId: "x" } })

		expect(mockProvider.upsertProviderProfile).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalled()
	})
})
