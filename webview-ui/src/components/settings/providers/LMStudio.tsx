import { useCallback, useState, useMemo, useEffect, useRef } from "react"
import { useEvent } from "react-use"
import { Trans } from "react-i18next"
import { Checkbox } from "vscrui"
import { VSCodeLink, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import {
	type ProviderSettings,
	type ExtensionMessage,
	type ModelRecord,
	LmStudioModelsMessageType,
} from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { requestLmStudioModels } from "@src/components/ui/hooks/useLmStudioModels"
import { useRouterModels } from "@src/components/ui/hooks/useRouterModels"
import { Button } from "@src/components/ui"

import { inputEventTransform } from "../transforms"
import { ModelPicker } from "../ModelPicker"

type LMStudioProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
}

enum RefreshStatus {
	Idle = "idle",
	Loading = "loading",
	Success = "success",
	Error = "error",
}

export const LMStudio = ({ apiConfiguration, setApiConfigurationField }: LMStudioProps) => {
	const { t } = useAppTranslation()

	const [lmStudioModels, setLmStudioModels] = useState<ModelRecord>({})
	const [refreshStatus, setRefreshStatus] = useState(RefreshStatus.Idle)
	const [refreshError, setRefreshError] = useState<string | undefined>()
	const refreshStatusRef = useRef(refreshStatus)
	const routerModels = useRouterModels()

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

	const onMessage = useCallback((event: MessageEvent) => {
		const message: ExtensionMessage = event.data

		switch (message.type) {
			case LmStudioModelsMessageType.lmStudioModels:
				{
					if (!message.error) {
						const newModels = message.lmStudioModels ?? {}
						setLmStudioModels(newModels)
					}

					if (refreshStatusRef.current === RefreshStatus.Loading) {
						const nextStatus = message.error ? RefreshStatus.Error : RefreshStatus.Success
						refreshStatusRef.current = nextStatus
						setRefreshStatus(nextStatus)
						setRefreshError(message.error)
					}
				}
				break
		}
	}, [])

	useEvent("message", onMessage)

	const handleRefreshModels = useCallback(() => {
		refreshStatusRef.current = RefreshStatus.Loading
		setRefreshStatus(RefreshStatus.Loading)
		setRefreshError(undefined)
		requestLmStudioModels(apiConfiguration?.lmStudioBaseUrl, apiConfiguration?.lmStudioApiKey)
	}, [apiConfiguration?.lmStudioBaseUrl, apiConfiguration?.lmStudioApiKey])

	// Refresh models on mount
	useEffect(() => {
		// Request fresh models - the handler now flushes cache automatically
		requestLmStudioModels(apiConfiguration?.lmStudioBaseUrl, apiConfiguration?.lmStudioApiKey)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// Check if the selected model exists in the fetched models
	const modelNotAvailableError = useMemo(() => {
		const selectedModel = apiConfiguration?.lmStudioModelId
		if (!selectedModel) return undefined

		// Check if model exists in local LM Studio models
		if (Object.keys(lmStudioModels).length > 0 && selectedModel in lmStudioModels) {
			return undefined // Model is available locally
		}

		// If we have router models data for LM Studio
		if (routerModels.data?.lmstudio) {
			const availableModels = Object.keys(routerModels.data.lmstudio)
			// Show warning if model is not in the list (regardless of how many models there are)
			if (!availableModels.includes(selectedModel)) {
				return t("settings:validation.modelAvailability", { modelId: selectedModel })
			}
		}

		// If neither source has loaded yet, don't show warning
		return undefined
	}, [apiConfiguration?.lmStudioModelId, routerModels.data, lmStudioModels, t])

	// Check if the draft model exists
	const draftModelNotAvailableError = useMemo(() => {
		const draftModel = apiConfiguration?.lmStudioDraftModelId
		if (!draftModel) return undefined

		// Check if model exists in local LM Studio models
		if (Object.keys(lmStudioModels).length > 0 && draftModel in lmStudioModels) {
			return undefined // Model is available locally
		}

		// If we have router models data for LM Studio
		if (routerModels.data?.lmstudio) {
			const availableModels = Object.keys(routerModels.data.lmstudio)
			// Show warning if model is not in the list (regardless of how many models there are)
			if (!availableModels.includes(draftModel)) {
				return t("settings:validation.modelAvailability", { modelId: draftModel })
			}
		}

		// If neither source has loaded yet, don't show warning
		return undefined
	}, [apiConfiguration?.lmStudioDraftModelId, routerModels.data, lmStudioModels, t])

	return (
		<>
			<VSCodeTextField
				value={apiConfiguration?.lmStudioBaseUrl || ""}
				type="url"
				onInput={handleInputChange("lmStudioBaseUrl")}
				placeholder={t("settings:defaults.lmStudioUrl")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.lmStudio.baseUrl")}</label>
			</VSCodeTextField>
			<VSCodeTextField
				value={apiConfiguration?.lmStudioApiKey || ""}
				type="password"
				onInput={handleInputChange("lmStudioApiKey")}
				placeholder={t("settings:placeholders.apiKey")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.lmStudio.apiKey")}</label>
			</VSCodeTextField>
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
				defaultModelId=""
				models={lmStudioModels}
				modelIdKey="lmStudioModelId"
				serviceName="LM Studio"
				serviceUrl="https://lmstudio.ai/docs"
				errorMessage={modelNotAvailableError}
				hidePricing
			/>
			<Checkbox
				checked={apiConfiguration?.lmStudioSpeculativeDecodingEnabled === true}
				onChange={(checked) => {
					setApiConfigurationField("lmStudioSpeculativeDecodingEnabled", checked)
				}}>
				{t("settings:providers.lmStudio.speculativeDecoding")}
			</Checkbox>
			{apiConfiguration?.lmStudioSpeculativeDecodingEnabled && (
				<>
					<ModelPicker
						apiConfiguration={apiConfiguration}
						setApiConfigurationField={setApiConfigurationField}
						defaultModelId=""
						models={lmStudioModels}
						modelIdKey="lmStudioDraftModelId"
						serviceName="LM Studio"
						serviceUrl="https://lmstudio.ai/docs"
						label={t("settings:providers.lmStudio.draftModelId")}
						errorMessage={draftModelNotAvailableError}
						hidePricing
					/>
					<div className="text-sm text-vscode-descriptionForeground">
						{t("settings:providers.lmStudio.draftModelDesc")}
					</div>
				</>
			)}
			<div className="text-sm text-vscode-descriptionForeground">
				<Trans
					i18nKey="settings:providers.lmStudio.description"
					components={{
						a: <VSCodeLink href="https://lmstudio.ai/docs" />,
						b: <VSCodeLink href="https://lmstudio.ai/docs/basics/server" />,
						span: (
							<span className="text-vscode-errorForeground ml-1">
								<span className="font-medium">Note:</span>
							</span>
						),
					}}
				/>
			</div>
		</>
	)
}
