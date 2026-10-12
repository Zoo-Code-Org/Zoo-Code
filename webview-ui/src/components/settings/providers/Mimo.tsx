import { useCallback, useState, useEffect, useRef } from "react"
import { VSCodeTextField, VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import { useQueryClient } from "@tanstack/react-query"

import {
	type ProviderSettings,
	type ExtensionMessage,
	providerIdentifiers,
	allRouterModelsProvider,
	RouterModelsMessageType,
} from "@roo-code/types"

import { RouterName } from "@roo/api"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { VSCodeButtonLink } from "@src/components/common/VSCodeButtonLink"
import { vscode } from "@src/utils/vscode"
import { Button } from "@src/components/ui"

import { inputEventTransform } from "../transforms"
import { cn } from "@/lib/utils"

type MimoProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
}

enum RefreshStatus {
	Idle = "idle",
	Loading = "loading",
	Success = "success",
	Error = "error",
}

export const Mimo = ({ apiConfiguration, setApiConfigurationField }: MimoProps) => {
	const { t } = useAppTranslation()
	const queryClient = useQueryClient()
	const [refreshStatus, setRefreshStatus] = useState(RefreshStatus.Idle)
	const [refreshError, setRefreshError] = useState<string | undefined>()
	const mimoErrorJustReceived = useRef(false)

	useEffect(() => {
		const handleMessage = (event: MessageEvent<ExtensionMessage>) => {
			const message = event.data
			if (message.type === RouterModelsMessageType.singleRouterModelFetchResponse && !message.success) {
				const providerName = message.values?.provider as RouterName
				if (providerName === providerIdentifiers.mimo && refreshStatus === RefreshStatus.Loading) {
					mimoErrorJustReceived.current = true
					setRefreshStatus(RefreshStatus.Error)
					setRefreshError(message.error)
				}
			} else if (message.type === RouterModelsMessageType.routerModels) {
				if (refreshStatus === RefreshStatus.Loading) {
					if (!mimoErrorJustReceived.current) {
						setRefreshStatus(RefreshStatus.Success)
						void queryClient.invalidateQueries({
							queryKey: [RouterModelsMessageType.routerModels, providerIdentifiers.mimo],
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
		mimoErrorJustReceived.current = false
		setRefreshStatus(RefreshStatus.Loading)
		setRefreshError(undefined)

		const key = apiConfiguration.mimoApiKey

		if (!key) {
			setRefreshStatus(RefreshStatus.Error)
			setRefreshError(t("settings:providers.refreshModels.missingConfig"))
			return
		}

		vscode.postMessage({
			type: RouterModelsMessageType.requestRouterModels,
			values: {
				provider: providerIdentifiers.mimo,
				mimoApiKey: key,
				mimoBaseUrl: apiConfiguration.mimoBaseUrl,
			},
		})
	}, [apiConfiguration, t])

	return (
		<>
			<div>
				<label className="block font-medium mb-1">{t("settings:providers.mimoBaseUrl")}</label>
				<VSCodeDropdown
					value={apiConfiguration.mimoBaseUrl}
					onChange={handleInputChange("mimoBaseUrl")}
					className={cn("w-full")}>
					<VSCodeOption value="https://token-plan-sgp.xiaomimimo.com/v1" className="p-2">
						{t("settings:providers.mimoBaseUrlSingapore")}
					</VSCodeOption>
					<VSCodeOption value="https://token-plan-cn.xiaomimimo.com/v1" className="p-2">
						{t("settings:providers.mimoBaseUrlChina")}
					</VSCodeOption>
					<VSCodeOption value="https://token-plan-ams.xiaomimimo.com/v1" className="p-2">
						{t("settings:providers.mimoBaseUrlEurope")}
					</VSCodeOption>
					<VSCodeOption value="https://api.xiaomimimo.com/v1" className="p-2">
						{t("settings:providers.mimoBaseUrlPayg")}
					</VSCodeOption>
				</VSCodeDropdown>
			</div>
			<div>
				<VSCodeTextField
					value={apiConfiguration?.mimoApiKey || ""}
					type="password"
					onInput={handleInputChange("mimoApiKey")}
					placeholder={t("settings:placeholders.apiKey")}
					className="w-full">
					<label className="block font-medium mb-1">{t("settings:providers.mimoApiKey")}</label>
				</VSCodeTextField>
				<div className="text-sm text-vscode-descriptionForeground">
					{t("settings:providers.apiKeyStorageNotice")}
				</div>
				{!apiConfiguration?.mimoApiKey && (
					<VSCodeButtonLink href="https://platform.xiaomimimo.com" appearance="secondary">
						{t("settings:providers.getMimoApiKey")}
					</VSCodeButtonLink>
				)}
			</div>
			<Button
				variant="outline"
				onClick={handleRefreshModels}
				disabled={refreshStatus === RefreshStatus.Loading || !apiConfiguration.mimoApiKey}>
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
		</>
	)
}
