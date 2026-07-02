import { useCallback } from "react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import type { ProviderSettings } from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { VSCodeButtonLink } from "@src/components/common/VSCodeButtonLink"

import { inputEventTransform } from "../transforms"

type NovitaProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
}

export const Novita = ({ apiConfiguration, setApiConfigurationField }: NovitaProps) => {
	const { t } = useAppTranslation()

	const handleInputChange = useCallback(
		<K extends keyof ProviderSettings, E>(
			field: K,
			transform: (event: E) => ProviderSettings[K] = inputEventTransform,
		) =>
			(event: E | Event) => {
				setApiConfigurationField(field, transform(event as E))
			},
		[setApiConfigurationField],
	)

	return (
		<>
			<div>
				<VSCodeTextField
					value={apiConfiguration?.novitaBaseUrl || "https://api.novita.ai/openai"}
					type="url"
					onInput={handleInputChange("novitaBaseUrl")}
					placeholder="https://api.novita.ai/openai"
					className="w-full">
					<label className="block font-medium mb-1">{t("settings:providers.novitaBaseUrl")}</label>
				</VSCodeTextField>
			</div>
			<div>
				<VSCodeTextField
					value={apiConfiguration?.novitaApiKey || ""}
					type="password"
					onInput={handleInputChange("novitaApiKey")}
					placeholder={t("settings:placeholders.apiKey")}
					className="w-full">
					<label className="block font-medium mb-1">{t("settings:providers.novitaApiKey")}</label>
				</VSCodeTextField>
				<div className="text-sm text-vscode-descriptionForeground">
					{t("settings:providers.apiKeyStorageNotice")}
				</div>
				{!apiConfiguration?.novitaApiKey && (
					<VSCodeButtonLink href="https://novita.ai/settings/key-management" appearance="secondary">
						{t("settings:providers.getNovitaApiKey")}
					</VSCodeButtonLink>
				)}
			</div>
		</>
	)
}
