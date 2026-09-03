import { useCallback, useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Checkbox } from "vscrui"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import {
	type ProviderSettings,
	type OrganizationAllowList,
	type RouterModels,
	openRouterDefaultModelId,
	allRouterModelsProvider,
	providerIdentifiers,
	RouterModelsMessageType,
	type ExtensionMessage,
} from "@roo-code/types"
import type { RouterName } from "@roo/api"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { getOpenRouterAuthUrl } from "@src/oauth/urls"
import { VSCodeButtonLink } from "@src/components/common/VSCodeButtonLink"
import { vscode } from "@src/utils/vscode"
import { Button } from "@src/components/ui"

import { inputEventTransform } from "../transforms"

import { ModelPicker } from "../ModelPicker"
import { OpenRouterBalanceDisplay } from "./OpenRouterBalanceDisplay"

enum RefreshStatus {
	Idle = "idle",
	Loading = "loading",
	Success = "success",
	Error = "error",
}

type OpenRouterProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	routerModels?: RouterModels
	selectedModelId: string
	uriScheme: string | undefined
	simplifySettings?: boolean
	organizationAllowList: OrganizationAllowList
	modelValidationError?: string
}

export const OpenRouter = ({
	apiConfiguration,
	setApiConfigurationField,
	routerModels,
	uriScheme,
	simplifySettings,
	organizationAllowList,
	modelValidationError,
}: OpenRouterProps) => {
	const { t } = useAppTranslation()

	const [openRouterBaseUrlSelected, setOpenRouterBaseUrlSelected] = useState(!!apiConfiguration?.openRouterBaseUrl)

	const queryClient = useQueryClient()
	const [refreshStatus, setRefreshStatus] = useState<RefreshStatus>(RefreshStatus.Idle)
	const [refreshError, setRefreshError] = useState<string | undefined>()
	// Stryker disable next-line BooleanLiteral : initial value never read before reset in handleRefreshModels
	const errorJustReceived = useRef(false)

	useEffect(() => {
		const handleMessage = (event: MessageEvent<ExtensionMessage>) => {
			const message = event.data
			if (message.type === RouterModelsMessageType.singleRouterModelFetchResponse && !message.success) {
				const providerName = message.values?.provider as RouterName
				if (providerName === providerIdentifiers.openrouter && refreshStatus === RefreshStatus.Loading) {
					errorJustReceived.current = true
					setRefreshStatus(RefreshStatus.Error)
					setRefreshError(message.error)
				}
			} else if (message.type === RouterModelsMessageType.routerModels) {
				const providerName = message.values?.provider as RouterName | undefined
				// Scoped responses must match our provider; unscoped (legacy/global)
				// broadcasts are still accepted so Loading cannot hang.
				if (
					(providerName === undefined || providerName === providerIdentifiers.openrouter) &&
					refreshStatus === RefreshStatus.Loading &&
					!errorJustReceived.current
				) {
					setRefreshStatus(RefreshStatus.Success)
					void queryClient.invalidateQueries({
						queryKey: [RouterModelsMessageType.routerModels, providerIdentifiers.openrouter],
					})
					void queryClient.invalidateQueries({
						queryKey: [RouterModelsMessageType.routerModels, allRouterModelsProvider],
					})
				}
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [refreshStatus, queryClient])

	const handleRefreshModels = useCallback(() => {
		errorJustReceived.current = false
		setRefreshStatus(RefreshStatus.Loading)
		setRefreshError(undefined)

		vscode.postMessage({
			type: RouterModelsMessageType.requestRouterModels,
			values: {
				provider: providerIdentifiers.openrouter,
				refresh: true,
			},
		})
	}, [])

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
				value={apiConfiguration?.openRouterApiKey || ""}
				type="password"
				onInput={handleInputChange("openRouterApiKey")}
				placeholder={t("settings:placeholders.apiKey")}
				className="w-full">
				<div className="flex justify-between items-center mb-1">
					<label className="block font-medium">{t("settings:providers.openRouterApiKey")}</label>
					{apiConfiguration?.openRouterApiKey && (
						<OpenRouterBalanceDisplay
							apiKey={apiConfiguration.openRouterApiKey}
							baseUrl={apiConfiguration.openRouterBaseUrl}
						/>
					)}
				</div>
			</VSCodeTextField>
			<div className="text-sm text-vscode-descriptionForeground -mt-2">
				{t("settings:providers.apiKeyStorageNotice")}
			</div>
			{!apiConfiguration?.openRouterApiKey && (
				<VSCodeButtonLink href={getOpenRouterAuthUrl(uriScheme)} style={{ width: "100%" }} appearance="primary">
					{t("settings:providers.getOpenRouterApiKey")}
				</VSCodeButtonLink>
			)}
			{!simplifySettings && (
				<div>
					<Checkbox
						checked={openRouterBaseUrlSelected}
						onChange={(checked: boolean) => {
							setOpenRouterBaseUrlSelected(checked)

							if (!checked) {
								setApiConfigurationField("openRouterBaseUrl", "")
							}
						}}>
						{t("settings:providers.useCustomBaseUrl")}
					</Checkbox>
					{openRouterBaseUrlSelected && (
						<VSCodeTextField
							value={apiConfiguration?.openRouterBaseUrl || ""}
							type="url"
							onInput={handleInputChange("openRouterBaseUrl")}
							placeholder="Default: https://openrouter.ai/api/v1"
							className="w-full mt-1"
						/>
					)}
				</div>
			)}
			<Button
				variant="outline"
				onClick={handleRefreshModels}
				disabled={refreshStatus === RefreshStatus.Loading}
				className="w-full">
				<div className="flex items-center gap-2">
					{refreshStatus === RefreshStatus.Loading ? (
						<span className="codicon codicon-loading codicon-modifier-spin" />
					) : (
						<span className="codicon codicon-refresh" />
					)}
					{t("settings:providers.refreshModels.label")}
				</div>
			</Button>
			{refreshStatus === RefreshStatus.Loading && (
				<div className="text-sm text-vscode-descriptionForeground">
					{t("settings:providers.refreshModels.loading")}
				</div>
			)}
			{refreshStatus === RefreshStatus.Success && (
				<div className="text-sm text-vscode-foreground">{t("settings:providers.refreshModels.success")}</div>
			)}
			{refreshStatus === RefreshStatus.Error && (
				<div className="text-sm text-vscode-errorForeground">
					{refreshError || t("settings:providers.refreshModels.error")}
				</div>
			)}
			<ModelPicker
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				defaultModelId={openRouterDefaultModelId}
				models={routerModels?.openrouter ?? {}}
				modelIdKey="openRouterModelId"
				serviceName="OpenRouter"
				serviceUrl="https://openrouter.ai/models"
				organizationAllowList={organizationAllowList}
				errorMessage={modelValidationError}
				simplifySettings={simplifySettings}
			/>
		</>
	)
}
