import { useCallback } from "react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import type { ProviderSettings } from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { VSCodeButtonLink } from "@src/components/common/VSCodeButtonLink"

import { inputEventTransform } from "../transforms"

type NeuronPoolProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
}

export const NeuronPool = ({ apiConfiguration, setApiConfigurationField }: NeuronPoolProps) => {
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
			<VSCodeTextField
				value={apiConfiguration?.neuronpoolApiKey || ""}
				type="password"
				onInput={handleInputChange("neuronpoolApiKey")}
				placeholder={t("settings:placeholders.apiKey")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.apiKey")}</label>
			</VSCodeTextField>
			<div className="text-sm text-vscode-descriptionForeground -mt-2">
				{t("settings:providers.apiKeyStorageNotice")}
			</div>
			<VSCodeTextField
				value={apiConfiguration?.neuronpoolBaseUrl || ""}
				type="url"
				onInput={handleInputChange("neuronpoolBaseUrl")}
				placeholder="https://neuronpool.damnknee.workers.dev/v1"
				className="w-full">
				<label className="block font-medium mb-1">Base URL</label>
			</VSCodeTextField>
			{!apiConfiguration?.neuronpoolApiKey && (
				<VSCodeButtonLink href="https://neuronpool.damnknee.workers.dev/dashboard" appearance="secondary">
					Get NeuronPool API Key
				</VSCodeButtonLink>
			)}
		</>
	)
}
