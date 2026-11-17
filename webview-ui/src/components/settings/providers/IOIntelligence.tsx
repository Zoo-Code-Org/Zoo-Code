import { useCallback } from "react"
import { useDebounce } from "react-use"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import {
	type OrganizationAllowList,
	type ProviderSettings,
	type RouterModels,
	ioIntelligenceDefaultModelId,
	providerIdentifiers,
	RouterModelsMessageType,
} from "@roo-code/types"

import { VSCodeButtonLink } from "@src/components/common/VSCodeButtonLink"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { vscode } from "@src/utils/vscode"

import { ModelPicker } from "../ModelPicker"
import { inputEventTransform } from "../transforms"

type IOIntelligenceProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: <K extends keyof ProviderSettings>(field: K, value: ProviderSettings[K]) => void
	routerModels?: RouterModels
	organizationAllowList: OrganizationAllowList
	modelValidationError?: string
	simplifySettings?: boolean
}

export const IOIntelligence = ({
	apiConfiguration,
	setApiConfigurationField,
	routerModels,
	organizationAllowList,
	modelValidationError,
	simplifySettings,
}: IOIntelligenceProps) => {
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

	// Debounced model refresh, only executed 250ms after the user stops
	// typing the key (same cadence as the provider refreshes in ApiOptions),
	// so each keystroke does not trigger a catalog request.
	useDebounce(
		() => {
			vscode.postMessage({
				type: RouterModelsMessageType.requestRouterModels,
				values: {
					provider: providerIdentifiers.ioIntelligence,
					ioIntelligenceApiKey: apiConfiguration.ioIntelligenceApiKey,
				},
			})
		},
		250,
		[apiConfiguration.ioIntelligenceApiKey],
	)

	return (
		<>
			<VSCodeTextField
				value={apiConfiguration.ioIntelligenceApiKey || ""}
				type="password"
				onInput={handleInputChange("ioIntelligenceApiKey")}
				placeholder={t("settings:placeholders.apiKey")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.ioIntelligence.apiKey")}</label>
			</VSCodeTextField>
			<div className="text-sm text-vscode-descriptionForeground -mt-2">
				{t("settings:providers.apiKeyStorageNotice")}
			</div>
			{!apiConfiguration.ioIntelligenceApiKey && (
				<VSCodeButtonLink href="https://ai.io.net/ai/api-keys" appearance="primary" className="w-full">
					{t("settings:providers.ioIntelligence.getApiKey")}
				</VSCodeButtonLink>
			)}

			<ModelPicker
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				defaultModelId={ioIntelligenceDefaultModelId}
				models={routerModels?.[providerIdentifiers.ioIntelligence] ?? {}}
				modelIdKey="ioIntelligenceModelId"
				serviceName={t("settings:providers.ioIntelligence.provider")}
				serviceUrl="https://io.net/intelligence"
				label={t("settings:providers.ioIntelligence.model")}
				organizationAllowList={organizationAllowList}
				errorMessage={modelValidationError}
				simplifySettings={simplifySettings}
			/>
		</>
	)
}
