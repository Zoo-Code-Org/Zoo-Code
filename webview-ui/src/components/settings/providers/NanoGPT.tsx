import { useCallback, useEffect } from "react"
import { VSCodeLink, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import {
	type NanoGptRoutingPreference,
	type OrganizationAllowList,
	type ProviderSettings,
	type RouterModels,
	nanoGptDefaultModelId,
	nanoGptDefaultRoutingPreference,
	nanoGptRoutingPreferences,
} from "@roo-code/types"

import { VSCodeButtonLink } from "@src/components/common/VSCodeButtonLink"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@src/components/ui"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { vscode } from "@src/utils/vscode"

import { ModelPicker } from "../ModelPicker"
import { inputEventTransform } from "../transforms"

type NanoGPTProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: <K extends keyof ProviderSettings>(field: K, value: ProviderSettings[K]) => void
	routerModels?: RouterModels
	organizationAllowList: OrganizationAllowList
	modelValidationError?: string
	simplifySettings?: boolean
}

const routingOptionKeys: Record<NanoGptRoutingPreference, string> = {
	auto: "automatic",
	fast: "fastest",
	cheap: "cheapest",
	latency: "lowestLatency",
	throughput: "highestThroughput",
	tools: "toolCapable",
	caching: "cacheCapable",
}

export const NanoGPT = ({
	apiConfiguration,
	setApiConfigurationField,
	routerModels,
	organizationAllowList,
	modelValidationError,
	simplifySettings,
}: NanoGPTProps) => {
	const { t } = useAppTranslation()
	const routingPreference = apiConfiguration.nanoGptRoutingPreference ?? nanoGptDefaultRoutingPreference

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
			type: "requestRouterModels",
			values: {
				provider: "nanogpt",
				nanoGptApiKey: apiConfiguration.nanoGptApiKey,
			},
		})
	}, [apiConfiguration.nanoGptApiKey])

	return (
		<>
			<VSCodeTextField
				value={apiConfiguration.nanoGptApiKey || ""}
				type="password"
				onInput={handleInputChange("nanoGptApiKey")}
				placeholder={t("settings:placeholders.apiKey")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.nanoGpt.apiKey")}</label>
			</VSCodeTextField>
			<div className="text-sm text-vscode-descriptionForeground -mt-2">
				{t("settings:providers.apiKeyStorageNotice")}
			</div>
			{!apiConfiguration.nanoGptApiKey && (
				<VSCodeButtonLink href="https://nano-gpt.com/api" appearance="primary" className="w-full">
					{t("settings:providers.nanoGpt.getApiKey")}
				</VSCodeButtonLink>
			)}

			<ModelPicker
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				defaultModelId={nanoGptDefaultModelId}
				models={routerModels?.nanogpt ?? {}}
				modelIdKey="nanoGptModelId"
				serviceName={t("settings:providers.nanoGpt.provider")}
				serviceUrl="https://nano-gpt.com/api"
				label={t("settings:providers.nanoGpt.model")}
				organizationAllowList={organizationAllowList}
				errorMessage={modelValidationError}
				simplifySettings={simplifySettings}
			/>

			<div className="flex flex-col gap-1">
				<label className="block font-medium">{t("settings:providers.nanoGpt.routingPreference")}</label>
				<Select
					value={routingPreference}
					onValueChange={(value) =>
						setApiConfigurationField("nanoGptRoutingPreference", value as NanoGptRoutingPreference)
					}>
					<SelectTrigger className="w-full" data-testid="nanogpt-routing-preference">
						<SelectValue placeholder={t("settings:common.select")} />
					</SelectTrigger>
					<SelectContent>
						{nanoGptRoutingPreferences.map((preference) => (
							<SelectItem key={preference} value={preference}>
								{t(`settings:providers.nanoGpt.routingOptions.${routingOptionKeys[preference]}`)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<div className="text-sm text-vscode-descriptionForeground">
					{t("settings:providers.nanoGpt.automaticExplanation")}
				</div>
			</div>

			{routingPreference !== nanoGptDefaultRoutingPreference && (
				<div className="text-sm text-vscode-descriptionForeground">
					<p className="m-0">{t("settings:providers.nanoGpt.billingWarning")}</p>
					<VSCodeLink
						href="https://docs.nano-gpt.com/api-reference/miscellaneous/provider-selection"
						target="_blank">
						{t("settings:providers.nanoGpt.routingDocs")}
					</VSCodeLink>
				</div>
			)}
		</>
	)
}
