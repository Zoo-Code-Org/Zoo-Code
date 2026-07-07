import { useCallback, useState, useEffect, useRef } from "react"
import { VSCodeTextField, VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import { useQueryClient } from "@tanstack/react-query"

import type { ProviderSettings, ExtensionMessage } from "@roo-code/types"
import { moonshotDefaultModelId } from "@roo-code/types"

import { RouterName } from "@roo/api"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { VSCodeButtonLink } from "@src/components/common/VSCodeButtonLink"
import { vscode } from "@src/utils/vscode"
import { Button } from "@src/components/ui"
import { ModelPicker } from "../ModelPicker"
import { handleModelChangeSideEffects } from "../utils/providerModelConfig"
import type { ProviderName } from "@roo-code/types"

import { inputEventTransform } from "../transforms"

type MoonshotProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	simplifySettings?: boolean
}

export const Moonshot = ({ apiConfiguration, setApiConfigurationField, simplifySettings }: MoonshotProps) => {
	const { t } = useAppTranslation()
	const { routerModels } = useExtensionState()
	const queryClient = useQueryClient()
	const [refreshStatus, setRefreshStatus] = useState<"idle" | "loading" | "success" | "error">("idle")
	const [refreshError, setRefreshError] = useState<string | undefined>()
	const moonshotErrorJustReceived = useRef(false)

	useEffect(() => {
		const handleMessage = (event: MessageEvent<ExtensionMessage>) => {
			const message = event.data
			if (message.type === "singleRouterModelFetchResponse" && !message.success) {
				const providerName = message.values?.provider as RouterName
				if (providerName === "moonshot" && refreshStatus === "loading") {
					moonshotErrorJustReceived.current = true
					setRefreshStatus("error")
					setRefreshError(message.error)
				}
			} else if (message.type === "routerModels") {
				if (refreshStatus === "loading") {
					if (!moonshotErrorJustReceived.current) {
						setRefreshStatus("success")
						queryClient.invalidateQueries({ queryKey: ["routerModels"] })
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
		moonshotErrorJustReceived.current = false
		setRefreshStatus("loading")
		setRefreshError(undefined)

		const key = apiConfiguration.moonshotApiKey

		if (!key) {
			setRefreshStatus("error")
			setRefreshError(t("settings:providers.refreshModels.missingConfig"))
			return
		}

		vscode.postMessage({
			type: "requestRouterModels",
			values: { moonshotApiKey: key, moonshotBaseUrl: apiConfiguration.moonshotBaseUrl },
		})
	}, [apiConfiguration, t])

	return (
		<>
			<div>
				<label className="block font-medium mb-1">{t("settings:providers.moonshotBaseUrl")}</label>
				<VSCodeDropdown
					value={apiConfiguration.moonshotBaseUrl}
					onChange={handleInputChange("moonshotBaseUrl")}
					className="w-full">
					<VSCodeOption value="https://api.moonshot.ai/v1" className="p-2">
						api.moonshot.ai
					</VSCodeOption>
					<VSCodeOption value="https://api.moonshot.cn/v1" className="p-2">
						api.moonshot.cn
					</VSCodeOption>
				</VSCodeDropdown>
			</div>
			<div>
				<VSCodeTextField
					value={apiConfiguration?.moonshotApiKey || ""}
					type="password"
					onInput={handleInputChange("moonshotApiKey")}
					placeholder={t("settings:placeholders.apiKey")}
					className="w-full">
					<label className="block font-medium mb-1">{t("settings:providers.moonshotApiKey")}</label>
				</VSCodeTextField>
				<div className="text-sm text-vscode-descriptionForeground">
					{t("settings:providers.apiKeyStorageNotice")}
				</div>
				{!apiConfiguration?.moonshotApiKey && (
					<VSCodeButtonLink
						href={
							apiConfiguration.moonshotBaseUrl === "https://api.moonshot.cn/v1"
								? "https://platform.moonshot.cn/console/api-keys"
								: "https://platform.moonshot.ai/console/api-keys"
						}
						appearance="secondary">
						{t("settings:providers.getMoonshotApiKey")}
					</VSCodeButtonLink>
				)}
			</div>
			<ModelPicker
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				defaultModelId={moonshotDefaultModelId}
				models={routerModels?.moonshot ?? {}}
				modelIdKey="apiModelId"
				serviceName="Moonshot"
				serviceUrl="https://platform.moonshot.ai"
				simplifySettings={simplifySettings}
				onModelChange={(modelId) =>
					handleModelChangeSideEffects("moonshot" as ProviderName, modelId, setApiConfigurationField)
				}
			/>
			<Button
				variant="outline"
				onClick={handleRefreshModels}
				disabled={refreshStatus === "loading" || !apiConfiguration.moonshotApiKey}>
				<div className="flex items-center gap-2">
					{refreshStatus === "loading" ? (
						<span className="codicon codicon-loading codicon-modifier-spin" />
					) : (
						<span className="codicon codicon-refresh" />
					)}
					{t("settings:providers.refreshModels.label")}
				</div>
			</Button>
			{refreshStatus === "loading" && (
				<div className="text-sm text-vscode-descriptionForeground">
					{t("settings:providers.refreshModels.loading")}
				</div>
			)}
			{refreshStatus === "success" && (
				<div className="text-sm text-vscode-foreground">{t("settings:providers.refreshModels.success")}</div>
			)}
			{refreshStatus === "error" && (
				<div className="text-sm text-vscode-errorForeground">
					{refreshError || t("settings:providers.refreshModels.error")}
				</div>
			)}
		</>
	)
}
