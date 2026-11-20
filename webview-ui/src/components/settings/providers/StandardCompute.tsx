import { useCallback } from "react"
import { useDebounce } from "react-use"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import {
	type OrganizationAllowList,
	type ProviderSettings,
	type RouterModels,
	standardComputeDefaultModelId,
	providerIdentifiers,
	RouterModelsMessageType,
} from "@roo-code/types"

import { VSCodeButtonLink } from "@src/components/common/VSCodeButtonLink"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { vscode } from "@src/utils/vscode"

import { ModelPicker } from "../ModelPicker"
import { inputEventTransform } from "../transforms"

type StandardComputeProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: <K extends keyof ProviderSettings>(field: K, value: ProviderSettings[K]) => void
	routerModels?: RouterModels
	organizationAllowList: OrganizationAllowList
	modelValidationError?: string
	simplifySettings?: boolean
}

export const StandardCompute = ({
	apiConfiguration,
	setApiConfigurationField,
	routerModels,
	organizationAllowList,
	modelValidationError,
	simplifySettings,
}: StandardComputeProps) => {
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
					provider: providerIdentifiers.standardCompute,
					standardComputeApiKey: apiConfiguration.standardComputeApiKey,
				},
			})
		},
		250,
		[apiConfiguration.standardComputeApiKey],
	)

	return (
		<>
			<VSCodeTextField
				value={apiConfiguration.standardComputeApiKey || ""}
				type="password"
				onInput={handleInputChange("standardComputeApiKey")}
				placeholder={t("settings:placeholders.apiKey")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.standardCompute.apiKey")}</label>
			</VSCodeTextField>
			<div className="text-sm text-vscode-descriptionForeground -mt-2">
				{t("settings:providers.apiKeyStorageNotice")}
			</div>
			{!apiConfiguration.standardComputeApiKey && (
				<VSCodeButtonLink href="https://standardcompute.com/dashboard" appearance="primary" className="w-full">
					{t("settings:providers.standardCompute.getApiKey")}
				</VSCodeButtonLink>
			)}

			<ModelPicker
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				defaultModelId={standardComputeDefaultModelId}
				models={routerModels?.[providerIdentifiers.standardCompute] ?? {}}
				modelIdKey="standardComputeModelId"
				serviceName={t("settings:providers.standardCompute.provider")}
				serviceUrl="https://standardcompute.com"
				label={t("settings:providers.standardCompute.model")}
				organizationAllowList={organizationAllowList}
				errorMessage={modelValidationError}
				simplifySettings={simplifySettings}
			/>
		</>
	)
}
