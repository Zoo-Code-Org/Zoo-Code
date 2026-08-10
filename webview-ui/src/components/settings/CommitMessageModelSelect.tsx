import type { ProviderSettingsEntry } from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@src/components/ui"

import { SearchableSetting } from "./SearchableSetting"
import { SetCachedStateField } from "./types"

// Sentinel for "no dedicated profile" - Select cannot hold an empty string as a value.
const USE_CURRENT_CONFIG = "-"

interface CommitMessageModelSelectProps {
	listApiConfigMeta: ProviderSettingsEntry[]
	commitMessageApiConfigId?: string
	setCachedStateField: SetCachedStateField<"commitMessageApiConfigId">
}

/**
 * Picks the API configuration profile used to generate Git commit messages from the Source Control
 * panel. Leaving it unset uses whichever profile is currently active.
 */
export const CommitMessageModelSelect = ({
	listApiConfigMeta,
	commitMessageApiConfigId,
	setCachedStateField,
}: CommitMessageModelSelectProps) => {
	const { t } = useAppTranslation()

	return (
		<SearchableSetting
			settingId="commit-message-model"
			section="providers"
			label={t("settings:providers.commitMessageModel.label")}
			className="mt-4">
			<label className="block font-medium mb-1">{t("settings:providers.commitMessageModel.label")}</label>
			<Select
				value={commitMessageApiConfigId || USE_CURRENT_CONFIG}
				onValueChange={(value) =>
					setCachedStateField("commitMessageApiConfigId", value === USE_CURRENT_CONFIG ? "" : value)
				}>
				<SelectTrigger data-testid="commit-message-model-select" className="w-full">
					<SelectValue placeholder={t("settings:providers.commitMessageModel.useCurrentConfig")} />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={USE_CURRENT_CONFIG}>
						{t("settings:providers.commitMessageModel.useCurrentConfig")}
					</SelectItem>
					{listApiConfigMeta.map((config) => (
						<SelectItem key={config.id} value={config.id} data-testid={`${config.id}-option`}>
							{config.name}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<div className="text-sm text-vscode-descriptionForeground mt-1">
				{t("settings:providers.commitMessageModel.description")}
			</div>
		</SearchableSetting>
	)
}
