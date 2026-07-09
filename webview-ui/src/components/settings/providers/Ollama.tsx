import { useState, useCallback, useMemo, useEffect } from "react"
import { useEvent } from "react-use"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { Checkbox } from "vscrui"

import { type ProviderSettings, type ExtensionMessage, type ModelRecord, ollamaDefaultModelInfo } from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useRouterModels } from "@src/components/ui/hooks/useRouterModels"
import { vscode } from "@src/utils/vscode"

import { inputEventTransform } from "../transforms"
import { ModelPicker } from "../ModelPicker"
import { ThinkingBudget } from "../ThinkingBudget"

type OllamaProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
}

export const Ollama = ({ apiConfiguration, setApiConfigurationField }: OllamaProps) => {
	const { t } = useAppTranslation()

	const [ollamaModels, setOllamaModels] = useState<ModelRecord>({})
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
			case "ollamaModels":
				{
					const newModels = message.ollamaModels ?? {}
					setOllamaModels(newModels)
				}
				break
		}
	}, [])

	useEvent("message", onMessage)

	// Refresh models on mount
	useEffect(() => {
		// Request fresh models - the handler now flushes cache automatically
		vscode.postMessage({ type: "requestOllamaModels" })
	}, [])

	// Check if the selected model exists in the fetched models
	const modelNotAvailableError = useMemo(() => {
		const selectedModel = apiConfiguration?.ollamaModelId
		if (!selectedModel) return undefined

		// Check if model exists in local ollama models
		if (Object.keys(ollamaModels).length > 0 && selectedModel in ollamaModels) {
			return undefined // Model is available locally
		}

		// Only validate against router models if they actually contain data (not just an empty placeholder)
		if (routerModels.data?.ollama && Object.keys(routerModels.data.ollama).length > 0) {
			const availableModels = Object.keys(routerModels.data.ollama)
			// Show warning if model is not in the list
			if (!availableModels.includes(selectedModel)) {
				return t("settings:validation.modelAvailability", { modelId: selectedModel })
			}
		}

		// If neither source has loaded yet, don't show warning
		return undefined
	}, [apiConfiguration?.ollamaModelId, routerModels.data, ollamaModels, t])

	return (
		<>
			<VSCodeTextField
				value={apiConfiguration?.ollamaBaseUrl || ""}
				type="url"
				onInput={handleInputChange("ollamaBaseUrl")}
				placeholder={t("settings:defaults.ollamaUrl")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.ollama.baseUrl")}</label>
			</VSCodeTextField>
			{apiConfiguration?.ollamaBaseUrl && (
				<VSCodeTextField
					value={apiConfiguration?.ollamaApiKey || ""}
					type="password"
					onInput={handleInputChange("ollamaApiKey")}
					placeholder={t("settings:placeholders.apiKey")}
					className="w-full">
					<label className="block font-medium mb-1">{t("settings:providers.ollama.apiKey")}</label>
					<div className="text-xs text-vscode-descriptionForeground mt-1">
						{t("settings:providers.ollama.apiKeyHelp")}
					</div>
				</VSCodeTextField>
			)}
			<ModelPicker
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				defaultModelId=""
				models={ollamaModels}
				modelIdKey="ollamaModelId"
				serviceName="Ollama"
				serviceUrl="https://ollama.ai"
				errorMessage={modelNotAvailableError}
				hidePricing
			/>
			<VSCodeTextField
				value={apiConfiguration?.ollamaNumCtx?.toString() || ""}
				onInput={(e) => {
					const value = (e.target as HTMLInputElement)?.value
					if (value === "") {
						setApiConfigurationField("ollamaNumCtx", undefined)
					} else {
						const numValue = parseInt(value, 10)
						if (!isNaN(numValue) && numValue >= 128) {
							setApiConfigurationField("ollamaNumCtx", numValue)
						}
					}
				}}
				placeholder="e.g., 4096"
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.ollama.numCtx")}</label>
				<div className="text-xs text-vscode-descriptionForeground mt-1">
					{t("settings:providers.ollama.numCtxHelp")}
				</div>
			</VSCodeTextField>
			<div className="flex flex-col gap-1">
				<Checkbox
					checked={apiConfiguration.enableReasoningEffort ?? false}
					onChange={(checked: boolean) => {
						setApiConfigurationField("enableReasoningEffort", checked)

						if (checked) {
							// Restore the last selected effort level if one was
							// previously chosen; otherwise default to "medium" so
							// the request actually enables Ollama's native think
							// parameter. Without a value, the ThinkingBudget Select
							// would show "None" (disable) and getOllamaThinkParam()
							// would return undefined, sending no think parameter
							// despite the checkbox being on. Preserving the prior
							// value avoids wiping the user's effort choice when
							// toggling the checkbox off and back on.
							setApiConfigurationField("reasoningEffort", apiConfiguration.reasoningEffort ?? "medium")
						}
						// When unchecked, leave reasoningEffort untouched so the
						// user's prior selection is preserved across toggles. The
						// handler gates on enableReasoningEffort === true, so a
						// stale reasoningEffort value will not emit a think param
						// while the checkbox is off.
					}}>
					{t("settings:providers.ollama.thinking")}
				</Checkbox>
				<div className="text-xs text-vscode-descriptionForeground mt-1">
					{t("settings:providers.ollama.thinkingHelp")}
				</div>
				{!!apiConfiguration.enableReasoningEffort && (
					<ThinkingBudget
						apiConfiguration={apiConfiguration}
						setApiConfigurationField={setApiConfigurationField}
						// Ollama models don't advertise reasoning capabilities, so
						// synthesize a model info that exposes the effort levels
						// Ollama's native `think` parameter supports (low/medium/high).
						modelInfo={{
							...ollamaDefaultModelInfo,
							supportsReasoningEffort: true,
						}}
					/>
				)}
			</div>
			<div className="text-sm text-vscode-descriptionForeground">
				{t("settings:providers.ollama.description")}
				<span className="text-vscode-errorForeground ml-1">{t("settings:providers.ollama.warning")}</span>
			</div>
		</>
	)
}
