import type { ProviderSettings } from "@roo-code/types"

import { DEFAULT_COMMIT_MESSAGE_TIMEOUT_SECONDS, getCommitMessageSettings } from "../config"
import type { ClineProvider } from "../../../core/webview/ClineProvider"

describe("getCommitMessageSettings", () => {
	const apiConfiguration: ProviderSettings = { apiProvider: "openai", apiKey: "key", apiModelId: "gpt-4" }

	const listApiConfigMeta = [
		{ id: "config1", name: "Config 1" },
		{ id: "config2", name: "Config 2" },
	]

	const commitProfile = {
		name: "Commit Config",
		apiProvider: "anthropic" as const,
		apiKey: "commit-key",
		apiModelId: "claude-3",
	}

	let getProfile: ReturnType<typeof vi.fn>

	// `ClineProvider` is a large concrete class, and constructing one would drag in the extension
	// host. This reads the two members the function actually touches, so the double assertion is
	// the narrowest way to stand in for it - widening to `unknown` first because the stub is not
	// structurally assignable to the full class.
	const makeProvider = (commitMessageApiConfigId?: string, commitMessageTimeout?: number) =>
		({
			getState: vi.fn().mockResolvedValue({
				apiConfiguration,
				listApiConfigMeta,
				customSupportPrompts: { COMMIT_MESSAGE: "custom" },
				commitMessageApiConfigId,
				commitMessageTimeout,
			}),
			providerSettingsManager: { getProfile },
		}) as unknown as ClineProvider

	beforeEach(() => {
		vi.clearAllMocks()
		getProfile = vi.fn().mockResolvedValue(commitProfile)
	})

	it("uses the active configuration when no dedicated profile is chosen", async () => {
		const settings = await getCommitMessageSettings(makeProvider())

		expect(settings.apiConfiguration).toBe(apiConfiguration)
		expect(getProfile).not.toHaveBeenCalled()
	})

	it("uses the dedicated profile when one is configured", async () => {
		const settings = await getCommitMessageSettings(makeProvider("config2"))

		expect(getProfile).toHaveBeenCalledWith({ id: "config2" })
		expect(settings.apiConfiguration).toEqual({
			apiProvider: "anthropic",
			apiKey: "commit-key",
			apiModelId: "claude-3",
		})
	})

	it("carries the customized prompt through", async () => {
		const settings = await getCommitMessageSettings(makeProvider())

		expect(settings.customSupportPrompts).toEqual({ COMMIT_MESSAGE: "custom" })
	})

	describe("timeout", () => {
		it("defaults when the setting is unset", async () => {
			const settings = await getCommitMessageSettings(makeProvider())

			expect(settings.timeoutMs).toBe(DEFAULT_COMMIT_MESSAGE_TIMEOUT_SECONDS * 1000)
		})

		it("uses the configured value, in milliseconds", async () => {
			const settings = await getCommitMessageSettings(makeProvider(undefined, 120))

			expect(settings.timeoutMs).toBe(120_000)
		})

		// The timeout is what bounds a stalled provider, so it has to survive the paths that fall
		// back to the active configuration rather than being lost with the profile lookup.
		it("survives a profile that no longer exists", async () => {
			getProfile = vi.fn().mockRejectedValue(new Error("Profile not found"))

			const settings = await getCommitMessageSettings(makeProvider("config2", 90))

			expect(settings.timeoutMs).toBe(90_000)
		})
	})

	it("falls back when the saved id is not in the known profiles", async () => {
		const settings = await getCommitMessageSettings(makeProvider("deleted-config"))

		expect(getProfile).not.toHaveBeenCalled()
		expect(settings.apiConfiguration).toBe(apiConfiguration)
	})

	// The metadata check is not enough on its own: a profile can be deleted between reading the
	// state and looking it up, and stale metadata points at profiles that are already gone.
	it("falls back when the profile disappears between the state read and the lookup", async () => {
		getProfile = vi.fn().mockRejectedValue(new Error("Profile not found"))

		const settings = await getCommitMessageSettings(makeProvider("config2"))

		expect(getProfile).toHaveBeenCalledWith({ id: "config2" })
		expect(settings.apiConfiguration).toBe(apiConfiguration)
	})

	it("falls back when the saved profile has no provider configured", async () => {
		getProfile = vi.fn().mockResolvedValue({ name: "Empty Config" })

		const settings = await getCommitMessageSettings(makeProvider("config2"))

		expect(settings.apiConfiguration).toBe(apiConfiguration)
	})
})
