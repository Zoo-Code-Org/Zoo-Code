import { useCallback, useEffect } from "react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import {
	type OrganizationAllowList,
	type ProviderSettings,
	type RouterModels,
	orcaRouterDefaultModelId,
	providerIdentifiers,
	RouterModelsMessageType,
} from "@roo-code/types"

import { VSCodeButtonLink } from "@src/components/common/VSCodeButtonLink"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { vscode } from "@src/utils/vscode"

import { ModelPicker } from "../ModelPicker"
import { inputEventTransform } from "../transforms"

type OrcaRouterProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: <K extends keyof ProviderSettings>(field: K, value: ProviderSettings[K]) => void
	routerModels?: RouterModels
	organizationAllowList: OrganizationAllowList
	modelValidationError?: string
	simplifySettings?: boolean
}

export const OrcaRouter = ({
	apiConfiguration,
	setApiConfigurationField,
	routerModels,
	organizationAllowList,
	modelValidationError,
	simplifySettings,
}: OrcaRouterProps) => {
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

	useEffect(() => {
		vscode.postMessage({
			type: RouterModelsMessageType.requestRouterModels,
			values: {
				provider: providerIdentifiers.orcaRouter,
				orcaRouterApiKey: apiConfiguration.orcaRouterApiKey,
			},
		})
	}, [apiConfiguration.orcaRouterApiKey])

	return (
		<>
			<VSCodeTextField
				value={apiConfiguration.orcaRouterApiKey || ""}
				type="password"
				onInput={handleInputChange("orcaRouterApiKey")}
				placeholder={t("settings:placeholders.apiKey")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.orcaRouter.apiKey")}</label>
			</VSCodeTextField>
			<div className="text-sm text-vscode-descriptionForeground -mt-2">
				{t("settings:providers.apiKeyStorageNotice")}
			</div>
			{!apiConfiguration.orcaRouterApiKey && (
				<VSCodeButtonLink href="https://www.orcarouter.ai" appearance="primary" className="w-full">
					{t("settings:providers.orcaRouter.getApiKey")}
				</VSCodeButtonLink>
			)}

			<ModelPicker
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				defaultModelId={orcaRouterDefaultModelId}
				models={routerModels?.[providerIdentifiers.orcaRouter] ?? {}}
				modelIdKey="orcaRouterModelId"
				serviceName={t("settings:providers.orcaRouter.provider")}
				serviceUrl="https://www.orcarouter.ai"
				label={t("settings:providers.orcaRouter.model")}
				organizationAllowList={organizationAllowList}
				errorMessage={modelValidationError}
				simplifySettings={simplifySettings}
			/>
		</>
	)
}
