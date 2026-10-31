import { useCallback, useState, useEffect, useRef } from "react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useQueryClient } from "@tanstack/react-query"
import { useDebounce } from "react-use"

import {
	type OrganizationAllowList,
	type ProviderSettings,
	type ExtensionMessage,
	type RouterModels,
	fireworksDefaultModelId,
	providerIdentifiers,
	allRouterModelsProvider,
	RouterModelsMessageType,
} from "@roo-code/types"

import { RouterName } from "@roo/api"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { VSCodeButtonLink } from "@src/components/common/VSCodeButtonLink"
import { vscode } from "@src/utils/vscode"
import { Button } from "@src/components/ui"
import { ModelPicker } from "../ModelPicker"
import { handleModelChangeSideEffects } from "../utils/providerModelConfig"

import { inputEventTransform } from "../transforms"

type FireworksProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	organizationAllowList?: OrganizationAllowList
	modelValidationError?: string
	simplifySettings?: boolean
}

enum RefreshStatus {
	Idle = "idle",
	Loading = "loading",
	Success = "success",
	Error = "error",
}

export const Fireworks = ({
	apiConfiguration,
	setApiConfigurationField,
	organizationAllowList,
	modelValidationError,
	simplifySettings,
}: FireworksProps) => {
	const { t } = useAppTranslation()
	const { routerModels } = useExtensionState()
	const queryClient = useQueryClient()
	const [refreshStatus, setRefreshStatus] = useState(RefreshStatus.Idle)
	const [refreshError, setRefreshError] = useState<string | undefined>()
	const fireworksErrorJustReceived = useRef(false)

	useEffect(() => {
		const handleMessage = (event: MessageEvent<ExtensionMessage>) => {
			const message = event.data
			if (message.type === RouterModelsMessageType.singleRouterModelFetchResponse && !message.success) {
				const providerName = message.values?.provider as RouterName
				if (providerName === providerIdentifiers.fireworks && refreshStatus === RefreshStatus.Loading) {
					fireworksErrorJustReceived.current = true
					setRefreshStatus(RefreshStatus.Error)
					setRefreshError(message.error)
				}
			} else if (message.type === RouterModelsMessageType.routerModels) {
				// Aggregate responses carry no provider and may belong to an unrelated
				// request, so only a Fireworks-scoped response can complete this refresh.
				if ((message.values?.provider as RouterName | undefined) !== providerIdentifiers.fireworks) {
					return
				}

				const incoming = message.routerModels

				if (incoming) {
					// Write the explicit-key catalog straight into the query cache. Invalidating
					// these keys would refetch with the saved key and could replace the catalog
					// of the account the user just refreshed.
					queryClient.setQueryData<RouterModels>(
						[RouterModelsMessageType.routerModels, providerIdentifiers.fireworks],
						(current) => (current ? { ...current, ...incoming } : incoming),
					)
					// The aggregate entry holds every provider, so only merge into an existing
					// one: creating it from this partial payload would hide the other providers.
					queryClient.setQueryData<RouterModels>(
						[RouterModelsMessageType.routerModels, allRouterModelsProvider],
						(current) => (current ? { ...current, ...incoming } : undefined),
					)
				}

				if (refreshStatus === RefreshStatus.Loading && !fireworksErrorJustReceived.current) {
					setRefreshStatus(RefreshStatus.Success)
				}
			}
		}

		window.addEventListener("message", handleMessage)
		return () => {
			window.removeEventListener("message", handleMessage)
		}
	}, [refreshStatus, queryClient])

	// A profile switch leaves the previous key's catalog in extension state. Request the
	// catalog with the new key so the picker cannot show or persist models that key cannot
	// use. The initial mount is skipped: the shared router-model query already loads the
	// saved key's catalog, and re-requesting here would flush that cache on every mount.
	// Debounced so typing a key does not fire one request per keystroke.
	const fireworksApiKey = apiConfiguration.fireworksApiKey
	const previousApiKey = useRef(fireworksApiKey)

	useDebounce(
		() => {
			const keyChanged = previousApiKey.current !== fireworksApiKey
			previousApiKey.current = fireworksApiKey

			if (!keyChanged || !fireworksApiKey) {
				return
			}

			vscode.postMessage({
				type: RouterModelsMessageType.requestRouterModels,
				values: { provider: providerIdentifiers.fireworks, fireworksApiKey },
			})
		},
		250,
		[fireworksApiKey],
	)

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
		fireworksErrorJustReceived.current = false
		setRefreshStatus(RefreshStatus.Loading)
		setRefreshError(undefined)

		const key = apiConfiguration.fireworksApiKey

		if (!key) {
			setRefreshStatus(RefreshStatus.Error)
			setRefreshError(t("settings:providers.refreshModels.missingConfig"))
			return
		}

		vscode.postMessage({
			type: RouterModelsMessageType.requestRouterModels,
			values: {
				provider: providerIdentifiers.fireworks,
				fireworksApiKey: key,
			},
		})
	}, [apiConfiguration, t])

	return (
		<>
			<VSCodeTextField
				value={apiConfiguration.fireworksApiKey || ""}
				type="password"
				onInput={handleInputChange("fireworksApiKey")}
				placeholder={t("settings:placeholders.apiKey")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.fireworksApiKey")}</label>
			</VSCodeTextField>
			<div className="text-sm text-vscode-descriptionForeground -mt-2">
				{t("settings:providers.apiKeyStorageNotice")}
			</div>
			{!apiConfiguration.fireworksApiKey && (
				<VSCodeButtonLink href="https://fireworks.ai/" appearance="secondary">
					{t("settings:providers.getFireworksApiKey")}
				</VSCodeButtonLink>
			)}
			<ModelPicker
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				defaultModelId={fireworksDefaultModelId}
				models={routerModels?.[providerIdentifiers.fireworks] ?? {}}
				modelIdKey="apiModelId"
				serviceName="Fireworks AI"
				serviceUrl="https://fireworks.ai/models"
				organizationAllowList={organizationAllowList}
				errorMessage={modelValidationError}
				simplifySettings={simplifySettings}
				onModelChange={(modelId) =>
					handleModelChangeSideEffects(providerIdentifiers.fireworks, modelId, setApiConfigurationField)
				}
			/>
			<Button
				variant="outline"
				onClick={handleRefreshModels}
				disabled={refreshStatus === RefreshStatus.Loading || !apiConfiguration.fireworksApiKey}>
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
