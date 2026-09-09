import { useCallback, useState, useEffect, useRef } from "react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import {
	type ProviderSettings,
	type OrganizationAllowList,
	type RouterModels,
	type ExtensionMessage,
	opencodeGoDefaultModelId,
	providerIdentifiers,
	RouterModelsMessageType,
} from "@roo-code/types"

import type { RouterName } from "@roo/api"

import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { VSCodeButtonLink } from "@src/components/common/VSCodeButtonLink"
import { Button } from "@src/components/ui"

import { inputEventTransform } from "../transforms"
import { ModelPicker } from "../ModelPicker"

type OpenCodeGoProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	routerModels?: RouterModels
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

export const OpenCodeGo = ({
	apiConfiguration,
	setApiConfigurationField,
	routerModels,
	organizationAllowList,
	modelValidationError,
	simplifySettings,
}: OpenCodeGoProps) => {
	const { t } = useAppTranslation()
	const [refreshStatus, setRefreshStatus] = useState(RefreshStatus.Idle)
	const [refreshError, setRefreshError] = useState<string | undefined>()
	const errorJustReceived = useRef(false)

	useEffect(() => {
		const handleMessage = (event: MessageEvent<ExtensionMessage>) => {
			const message = event.data
			if (message.type === RouterModelsMessageType.singleRouterModelFetchResponse && !message.success) {
				const providerName = message.values?.provider as RouterName
				if (providerName === providerIdentifiers.opencodeGo) {
					errorJustReceived.current = true
					setRefreshStatus(RefreshStatus.Error)
					setRefreshError(message.error)
				}
			} else if (message.type === RouterModelsMessageType.routerModels) {
				if (refreshStatus === RefreshStatus.Loading) {
					if (!errorJustReceived.current) {
						setRefreshStatus(RefreshStatus.Success)
					}
				}
			}
		}

		window.addEventListener("message", handleMessage)
		return () => {
			window.removeEventListener("message", handleMessage)
		}
	}, [refreshStatus])

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
		errorJustReceived.current = false
		setRefreshStatus(RefreshStatus.Loading)
		setRefreshError(undefined)
		vscode.postMessage({
			type: RouterModelsMessageType.requestRouterModels,
			values: {
				provider: providerIdentifiers.opencodeGo,
				refresh: true,
				opencodeGoApiKey: apiConfiguration.opencodeGoApiKey,
			},
		})
	}, [apiConfiguration.opencodeGoApiKey])

	return (
		<>
			<VSCodeTextField
				value={apiConfiguration?.opencodeGoApiKey || ""}
				type="password"
				onInput={handleInputChange("opencodeGoApiKey")}
				placeholder={t("settings:placeholders.apiKey")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.opencodeGoApiKey")}</label>
			</VSCodeTextField>
			<div className="text-sm text-vscode-descriptionForeground -mt-2">
				{t("settings:providers.apiKeyStorageNotice")}
			</div>
			{!apiConfiguration?.opencodeGoApiKey && (
				<VSCodeButtonLink href="https://opencode.ai/docs/go/" appearance="primary" style={{ width: "100%" }}>
					{t("settings:providers.getOpencodeGoApiKey")}
				</VSCodeButtonLink>
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
				defaultModelId={opencodeGoDefaultModelId}
				models={routerModels?.[providerIdentifiers.opencodeGo] ?? {}}
				modelIdKey="opencodeGoModelId"
				serviceName="Opencode Go"
				serviceUrl="https://opencode.ai/docs/go/"
				organizationAllowList={organizationAllowList}
				errorMessage={modelValidationError}
				simplifySettings={simplifySettings}
			/>
		</>
	)
}
