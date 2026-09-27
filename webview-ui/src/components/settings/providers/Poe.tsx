import { useCallback, useState, useEffect, useRef } from "react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useQueryClient } from "@tanstack/react-query"

import {
	type ProviderSettings,
	type OrganizationAllowList,
	type ExtensionMessage,
	poeDefaultModelId,
	providerIdentifiers,
	allRouterModelsProvider,
	RouterModelsMessageType,
} from "@roo-code/types"

import { RouterName } from "@roo/api"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { VSCodeButtonLink } from "@src/components/common/VSCodeButtonLink"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"
import { Button } from "@src/components/ui"

import { inputEventTransform } from "../transforms"
import { ModelPicker } from "../ModelPicker"
import { handleModelChangeSideEffects } from "../utils/providerModelConfig"

type PoeProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	organizationAllowList: OrganizationAllowList
	modelValidationError?: string
	simplifySettings?: boolean
}

enum RefreshStatus {
	Idle = "idle",
	Loading = "loading",
	Success = "success",
	Error = "error",
}

export const Poe = ({
	apiConfiguration,
	setApiConfigurationField,
	organizationAllowList,
	modelValidationError,
	simplifySettings,
}: PoeProps) => {
	const { t } = useAppTranslation()
	const queryClient = useQueryClient()
	const { routerModels } = useExtensionState()
	const [refreshStatus, setRefreshStatus] = useState(RefreshStatus.Idle)
	const [refreshError, setRefreshError] = useState<string | undefined>()
	const poeErrorJustReceived = useRef(false)

	useEffect(() => {
		const handleMessage = (event: MessageEvent<ExtensionMessage>) => {
			const message = event.data
			if (message.type === RouterModelsMessageType.singleRouterModelFetchResponse && !message.success) {
				const providerName = message.values?.provider as RouterName
				if (providerName === providerIdentifiers.poe) {
					poeErrorJustReceived.current = true
					setRefreshStatus(RefreshStatus.Error)
					setRefreshError(message.error)
				}
			} else if (message.type === RouterModelsMessageType.routerModels) {
				if (refreshStatus === RefreshStatus.Loading) {
					if (!poeErrorJustReceived.current) {
						setRefreshStatus(RefreshStatus.Success)
						// Refresh the provider-scoped cache used by useSelectedModel and the shared cache used by
						// ApiOptions without invalidating every other provider's query.
						void queryClient.invalidateQueries({
							queryKey: [RouterModelsMessageType.routerModels, providerIdentifiers.poe],
						})
						void queryClient.invalidateQueries({
							queryKey: [RouterModelsMessageType.routerModels, allRouterModelsProvider],
						})
					}
				}
			}
		}

		window.addEventListener("message", handleMessage)
		return () => {
			window.removeEventListener("message", handleMessage)
		}
	}, [refreshStatus, queryClient])

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

	const handleRefreshModels = useCallback(() => {
		poeErrorJustReceived.current = false
		setRefreshStatus(RefreshStatus.Loading)
		setRefreshError(undefined)

		const key = apiConfiguration.poeApiKey

		if (!key) {
			setRefreshStatus(RefreshStatus.Error)
			setRefreshError(t("settings:providers.refreshModels.missingConfig"))
			return
		}

		vscode.postMessage({
			type: RouterModelsMessageType.requestRouterModels,
			values: { provider: providerIdentifiers.poe, poeApiKey: key, poeBaseUrl: apiConfiguration.poeBaseUrl },
		})
	}, [apiConfiguration, t])

	return (
		<>
			<VSCodeTextField
				value={apiConfiguration?.poeApiKey || ""}
				type="password"
				onInput={handleInputChange("poeApiKey")}
				placeholder={t("settings:placeholders.apiKey")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.poeApiKey")}</label>
			</VSCodeTextField>
			<div className="text-sm text-vscode-descriptionForeground -mt-2">
				{t("settings:providers.apiKeyStorageNotice")}
			</div>
			{!apiConfiguration?.poeApiKey && (
				<VSCodeButtonLink href="https://poe.com/api_key" appearance="secondary">
					{t("settings:providers.getPoeApiKey")}
				</VSCodeButtonLink>
			)}
			<Button
				variant="outline"
				onClick={handleRefreshModels}
				disabled={refreshStatus === RefreshStatus.Loading || !apiConfiguration.poeApiKey}>
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
				defaultModelId={poeDefaultModelId}
				models={routerModels?.poe ?? {}}
				modelIdKey="apiModelId"
				serviceName="Poe"
				serviceUrl="https://poe.com"
				organizationAllowList={organizationAllowList}
				errorMessage={modelValidationError}
				simplifySettings={simplifySettings}
				onModelChange={(modelId) =>
					handleModelChangeSideEffects(providerIdentifiers.poe, modelId, setApiConfigurationField)
				}
			/>
		</>
	)
}
