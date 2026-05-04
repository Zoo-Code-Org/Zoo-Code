import { useCallback } from "react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import type { ProviderSettings, OrganizationAllowList, RouterModels } from "@roo-code/types"
import { deepSeekDefaultModelId } from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { VSCodeButtonLink } from "@src/components/common/VSCodeButtonLink"

import { inputEventTransform } from "../transforms"
import { ModelPicker } from "../ModelPicker"

type DeepSeekProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	routerModels?: RouterModels
	simplifySettings?: boolean
	organizationAllowList: OrganizationAllowList
	modelValidationError?: string
}

export const DeepSeek = ({
	apiConfiguration,
	setApiConfigurationField,
	routerModels,
	simplifySettings,
	organizationAllowList,
	modelValidationError,
}: DeepSeekProps) => {
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
				value={apiConfiguration?.deepSeekApiKey || ""}
				type="password"
				onInput={handleInputChange("deepSeekApiKey")}
				placeholder={t("settings:placeholders.apiKey")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.deepSeekApiKey")}</label>
			</VSCodeTextField>
			<div className="text-sm text-vscode-descriptionForeground -mt-2">
				{t("settings:providers.apiKeyStorageNotice")}
			</div>
			{!apiConfiguration?.deepSeekApiKey && (
				<VSCodeButtonLink href="https://platform.deepseek.com/" appearance="secondary">
					{t("settings:providers.getDeepSeekApiKey")}
				</VSCodeButtonLink>
			)}
			<ModelPicker
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				defaultModelId={deepSeekDefaultModelId}
				models={routerModels?.deepseek ?? {}}
				modelIdKey="apiModelId"
				serviceName="DeepSeek"
				serviceUrl="https://platform.deepseek.com"
				organizationAllowList={organizationAllowList}
				errorMessage={modelValidationError}
				simplifySettings={simplifySettings}
			/>
		</>
	)
}
