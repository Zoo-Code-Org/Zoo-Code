import type { ProviderSettings } from "@roo-code/types"

import type { ClineProvider } from "../../core/webview/ClineProvider"
import type { CustomSupportPrompts } from "./generator"

export interface CommitMessageSettings {
	apiConfiguration: ProviderSettings
	customSupportPrompts?: CustomSupportPrompts
}

/**
 * Reads the settings a commit message is generated with: the profile chosen in
 * Settings → Providers → Commit Message Model, and the prompt the user may have customized.
 *
 * The chosen profile is only a preference. A saved id can outlive the profile it points at, and
 * the profile can be deleted between reading the state and looking it up, so every failure here
 * falls back to the active configuration rather than stopping generation.
 */
export async function getCommitMessageSettings(provider: ClineProvider): Promise<CommitMessageSettings> {
	const { apiConfiguration, listApiConfigMeta, customSupportPrompts, commitMessageApiConfigId } =
		await provider.getState()

	if (!commitMessageApiConfigId || !listApiConfigMeta?.some(({ id }) => id === commitMessageApiConfigId)) {
		return { apiConfiguration, customSupportPrompts }
	}

	try {
		const { name: _name, ...providerSettings } = await provider.providerSettingsManager.getProfile({
			id: commitMessageApiConfigId,
		})

		return {
			apiConfiguration: providerSettings.apiProvider ? providerSettings : apiConfiguration,
			customSupportPrompts,
		}
	} catch {
		return { apiConfiguration, customSupportPrompts }
	}
}
