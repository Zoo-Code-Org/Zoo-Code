import { useEffect, useRef, useState } from "react"
import { Brain, Check } from "lucide-react"
import {
	type ExtensionMessage,
	type ModelInfo,
	type ProviderSettings,
	type ReasoningEffortExtended,
	OpenAiModelsMessageType,
	isDynamicProvider,
	isRetiredProvider,
	openAiModelInfoSaneDefaults,
	providerIdentifiers,
	reasoningEfforts,
} from "@roo-code/types"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useSelectedModel } from "@src/components/ui/hooks/useSelectedModel"
import { useRouterModels } from "@src/components/ui/hooks/useRouterModels"
import { getProviderModelConfig, getStaticModelsForProvider } from "@src/components/settings/utils/providerModelConfig"
import { filterModels } from "@src/components/settings/utils/organizationFilters"
import { vscode } from "@src/utils/vscode"
import { cn } from "@src/lib/utils"
import { PickerSearchField } from "./PickerSearchField"
import { useAppTranslation } from "@src/i18n/TranslationContext"

type EffortOption = ReasoningEffortExtended | "disable"

export function ProfileQuickSettings({
	disabled = false,
	onModelSelected,
}: {
	disabled?: boolean
	onModelSelected?: () => void
}) {
	const { t } = useAppTranslation()
	const { apiConfiguration, currentApiConfigName, setApiConfiguration, organizationAllowList } = useExtensionState()
	const { id: modelId, info } = useSelectedModel(apiConfiguration)
	const provider = apiConfiguration?.apiProvider
	const { data: routerModels } = useRouterModels({ provider, enabled: !!provider && isDynamicProvider(provider) })
	const [search, setSearch] = useState("")
	const [openAiModels, setOpenAiModels] = useState<Record<string, ModelInfo>>({})
	const latestConfiguration = useRef(apiConfiguration)
	useEffect(() => {
		latestConfiguration.current = apiConfiguration
	}, [apiConfiguration])

	useEffect(() => {
		if (provider !== providerIdentifiers.openai) return
		const onMessage = (event: MessageEvent<ExtensionMessage>) => {
			if (event.data.type === OpenAiModelsMessageType.openAiModels) {
				setOpenAiModels(
					Object.fromEntries((event.data.openAiModels ?? []).map((id) => [id, openAiModelInfoSaneDefaults])),
				)
			}
		}
		window.addEventListener("message", onMessage)
		vscode.postMessage({
			type: OpenAiModelsMessageType.requestOpenAiModels,
			values: {
				baseUrl: apiConfiguration.openAiBaseUrl,
				apiKey: apiConfiguration.openAiApiKey,
				customHeaders: {},
				openAiHeaders: apiConfiguration.openAiHeaders ?? {},
			},
		})
		return () => window.removeEventListener("message", onMessage)
	}, [provider, apiConfiguration.openAiBaseUrl, apiConfiguration.openAiApiKey, apiConfiguration.openAiHeaders])

	if (!provider || isRetiredProvider(provider) || !currentApiConfigName) return null
	const modelConfig = getProviderModelConfig(provider, apiConfiguration)
	const models =
		filterModels(
			provider === providerIdentifiers.openai
				? openAiModels
				: {
						...getStaticModelsForProvider(provider, undefined, apiConfiguration),
						...(isDynamicProvider(provider) ? routerModels?.[provider] : {}),
					},
			provider,
			organizationAllowList,
		) ?? {}
	const modelIds = Object.keys(models)
		.filter((id) => id !== "custom-arn" && (!models[id].deprecated || id === modelId))
		.filter((id) => id.toLowerCase().includes(search.toLowerCase()))
		.sort((a, b) => a.localeCompare(b))
	const supports =
		provider === providerIdentifiers.openai
			? (["disable", "low", "medium", "high", "xhigh", "max"] as const)
			: info?.supportsReasoningEffort
	const effortOptions: readonly EffortOption[] =
		supports === true ? reasoningEfforts : Array.isArray(supports) ? supports : []
	const availableEfforts = info?.requiredReasoningEffort
		? effortOptions.filter((effort) => effort !== "disable")
		: supports === true
			? ["disable" as const, ...effortOptions]
			: effortOptions
	const storedEffort =
		provider === providerIdentifiers.openai
			? apiConfiguration.openAiCustomModelInfo?.reasoningEffort
			: apiConfiguration.reasoningEffort
	const defaultEffort = info?.reasoningEffort ?? (info?.requiredReasoningEffort ? "medium" : "disable")
	const rawEffort =
		!info?.requiredReasoningEffort && apiConfiguration.enableReasoningEffort === false
			? "disable"
			: (storedEffort ?? defaultEffort)
	const currentEffort = availableEfforts.includes(rawEffort)
		? rawEffort
		: availableEfforts.includes(defaultEffort)
			? defaultEffort
			: availableEfforts[0]

	// This menu is deliberately immediate-save, unlike the buffered SettingsView form.
	const save = (patch: Partial<ProviderSettings>) => {
		if (disabled) return
		const next = { ...latestConfiguration.current, ...patch }
		latestConfiguration.current = next
		setApiConfiguration(next)
		vscode.postMessage({ type: "upsertApiConfiguration", text: currentApiConfigName, apiConfiguration: next })
	}
	const selectModel = (id: string) => {
		if (!modelConfig || disabled) return
		save({
			[modelConfig.field]: id,
			reasoningEffort: undefined,
			enableReasoningEffort: undefined,
			modelMaxTokens: undefined,
			modelMaxThinkingTokens: undefined,
			...(provider === providerIdentifiers.bedrock ? { awsCustomArn: "" } : {}),
			...(provider === providerIdentifiers.openai
				? {
						openAiCustomModelInfo: {
							...(latestConfiguration.current.openAiCustomModelInfo ?? openAiModelInfoSaneDefaults),
							reasoningEffort: undefined,
						},
					}
				: {}),
		})
		setSearch("")
		onModelSelected?.()
	}
	const selectEffort = (effort: EffortOption) => {
		save({
			reasoningEffort: effort,
			enableReasoningEffort: effort !== "disable",
			...(provider === providerIdentifiers.openai
				? {
						openAiCustomModelInfo: {
							...(latestConfiguration.current.openAiCustomModelInfo ?? openAiModelInfoSaneDefaults),
							reasoningEffort: effort === "disable" ? undefined : effort,
						},
					}
				: {}),
		})
	}

	return (
		<div className="flex flex-col">
			{modelConfig ? (
				<div className="flex flex-col">
					<PickerSearchField
						label={t("chat:modelPicker.searchModels")}
						value={search}
						onChange={setSearch}
						disabled={disabled}
					/>
					<div
						role="group"
						aria-label={t("chat:modelPicker.providerModels")}
						className="max-h-[300px] overflow-y-auto py-1">
						{modelIds.map((id) => (
							<button
								key={id}
								type="button"
								disabled={disabled}
								aria-pressed={id === modelId}
								onClick={() => selectModel(id)}
								className={cn(
									"flex w-full cursor-pointer items-center gap-2 border-none px-3 py-1.5 text-left text-sm text-vscode-foreground hover:bg-vscode-list-hoverBackground disabled:opacity-50",
									id === modelId
										? "bg-vscode-list-activeSelectionBackground text-vscode-list-activeSelectionForeground"
										: "bg-transparent",
								)}>
								<span className="min-w-0 flex-1 truncate" title={id}>
									{id}
								</span>
								{id === modelId && (
									<span className="flex size-5 shrink-0 items-center justify-center">
										<Check aria-hidden="true" className="size-3" />
									</span>
								)}
							</button>
						))}
						{modelIds.length === 0 && (
							<div className="px-3 py-2 text-xs text-vscode-descriptionForeground">
								{t("common:ui.no_results")}
							</div>
						)}
					</div>
				</div>
			) : (
				<div className="text-xs text-vscode-descriptionForeground">
					{t("chat:modelPicker.modelSettingsHint")}
				</div>
			)}
			{availableEfforts.length > 0 && (
				<div className="flex flex-col gap-1.5 border-t border-vscode-dropdown-border p-3">
					<div className="flex items-center gap-1.5 text-xs text-vscode-descriptionForeground">
						<Brain aria-hidden="true" className="size-3" />
						{t("chat:modelPicker.reasoningEffort")}
					</div>
					<div
						role="group"
						aria-label={t("chat:modelPicker.reasoningEffort")}
						className="flex flex-wrap gap-1">
						{availableEfforts.map((effort) => (
							<button
								key={effort}
								type="button"
								disabled={disabled}
								aria-pressed={currentEffort === effort}
								onClick={() => selectEffort(effort)}
								className={cn(
									"cursor-pointer rounded border border-vscode-input-border px-2 py-1 text-[11px] disabled:opacity-50",
									currentEffort === effort
										? "bg-vscode-button-background text-vscode-button-foreground"
										: "bg-transparent text-vscode-foreground hover:bg-vscode-list-hoverBackground",
								)}>
								{effort === "disable"
									? t("chat:modelPicker.off")
									: t(`chat:modelPicker.effort.${effort}`)}
							</button>
						))}
					</div>
				</div>
			)}
		</div>
	)
}
