import { useMemo, useState, useCallback, useEffect, useRef } from "react"
import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { Trans } from "react-i18next"
import { ChevronsUpDown, Info } from "lucide-react"

import {
	type ProviderSettings,
	type ModelInfo,
	type OrganizationAllowList,
	isRetiredProvider,
	providerIdentifiers,
} from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useSelectedModel } from "@/components/ui/hooks/useSelectedModel"
import { cn } from "@src/lib/utils"
import { Button } from "@src/components/ui"
import { ModelSelect } from "@/components/ui/model-select/ModelSelect"

import { ModelInfoView } from "./ModelInfoView"
import { ApiErrorMessage } from "./ApiErrorMessage"

type ModelIdKey = keyof Pick<
	ProviderSettings,
	| "openRouterModelId"
	| "requestyModelId"
	| "unboundModelId"
	| "openAiModelId"
	| "litellmModelId"
	| "vercelAiGatewayModelId"
	| "opencodeGoModelId"
	| "kenariModelId"
	| "nanoGptModelId"
	| "zooGatewayModelId"
	| "apiModelId"
	| "ollamaModelId"
	| "lmStudioModelId"
	| "lmStudioDraftModelId"
	| "vsCodeLmModelSelector"
>

interface ModelPickerProps {
	defaultModelId: string
	models: Record<string, ModelInfo> | null
	modelIdKey: ModelIdKey
	serviceName: string
	serviceUrl: string
	apiConfiguration: ProviderSettings
	setApiConfigurationField: <K extends keyof ProviderSettings>(
		field: K,
		value: ProviderSettings[K],
		isUserAction?: boolean,
	) => void
	organizationAllowList?: OrganizationAllowList
	errorMessage?: string
	simplifySettings?: boolean
	hidePricing?: boolean
	/** Label for the model picker field - defaults to "Model" */
	label?: string
	/** Transform model ID string to the value stored in configuration (for compound types like VSCodeLM selector) */
	valueTransform?: (modelId: string) => unknown
	/** Transform stored configuration value back to display string */
	displayTransform?: (value: unknown) => string
	/** Callback when model changes - useful for side effects like clearing related fields */
	onModelChange?: (modelId: string) => void
}

export const ModelPicker = ({
	defaultModelId,
	models,
	modelIdKey,
	serviceName,
	serviceUrl,
	apiConfiguration,
	setApiConfigurationField,
	organizationAllowList,
	errorMessage,
	simplifySettings,
	hidePricing,
	label,
	valueTransform,
	displayTransform,
	onModelChange,
}: ModelPickerProps) => {
	const { t } = useAppTranslation()

	const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(false)
	const isInitialized = useRef(false)

	const { id: selectedModelId, info: selectedModelInfo } = useSelectedModel(apiConfiguration)

	// Derive the display value for the current selection. If displayTransform
	// is provided, convert the stored value to a display string; otherwise
	// use the resolved selected model id from useSelectedModel.
	const displayValue = useMemo(() => {
		if (displayTransform) {
			const storedValue = apiConfiguration[modelIdKey]
			return storedValue ? displayTransform(storedValue) : ""
		}
		return selectedModelId ?? ""
	}, [displayTransform, apiConfiguration, modelIdKey, selectedModelId])

	const activeProvider =
		apiConfiguration.apiProvider && isRetiredProvider(apiConfiguration.apiProvider)
			? undefined
			: apiConfiguration.apiProvider

	const onSelect = useCallback(
		(modelId: string) => {
			if (!modelId) return
			const valueToStore = valueTransform ? valueTransform(modelId) : modelId
			setApiConfigurationField(modelIdKey, valueToStore as ProviderSettings[ModelIdKey])
			onModelChange?.(modelId)
		},
		[modelIdKey, setApiConfigurationField, valueTransform, onModelChange],
	)

	// Auto-initialize a default model when none is selected yet. This runs
	// only once and only for the settings picker (the chat selector never
	// auto-writes configuration).
	useEffect(() => {
		if (isInitialized.current) return
		if (!selectedModelId) {
			const initialValue = selectedModelId === defaultModelId ? selectedModelId : defaultModelId
			setApiConfigurationField(modelIdKey, initialValue, false) // false = automatic initialization
		}
		isInitialized.current = true
	}, [selectedModelId, defaultModelId, modelIdKey, setApiConfigurationField])

	return (
		<>
			<div>
				<label className="block font-medium mb-1">{label ?? t("settings:modelPicker.label")}</label>
				<ModelSelect
					models={models}
					value={displayValue}
					onChange={onSelect}
					activeProvider={activeProvider}
					organizationAllowList={organizationAllowList}
					contentClassName="w-[var(--radix-popover-trigger-width)]"
					renderTrigger={({ displayValue: value, placeholder }) => (
						<Button
							variant="combobox"
							role="combobox"
							className={cn("w-full justify-between")}
							data-testid="model-picker-button">
							<div className="truncate">{value || placeholder}</div>
							<ChevronsUpDown className="opacity-50" />
						</Button>
					)}
				/>
			</div>
			{errorMessage && <ApiErrorMessage errorMessage={errorMessage} />}
			{selectedModelInfo?.deprecated && (
				<ApiErrorMessage errorMessage={t("settings:validation.modelDeprecated")} />
			)}

			{simplifySettings ? (
				<p className="text-xs text-vscode-descriptionForeground m-0">
					<Info className="size-3 inline mr-1" />
					{t("settings:modelPicker.simplifiedExplanation")}
				</p>
			) : (
				<div>
					{selectedModelId && selectedModelInfo && !selectedModelInfo.deprecated && (
						<ModelInfoView
							apiProvider={apiConfiguration.apiProvider}
							selectedModelId={selectedModelId}
							modelInfo={selectedModelInfo}
							isDescriptionExpanded={isDescriptionExpanded}
							setIsDescriptionExpanded={setIsDescriptionExpanded}
							hidePricing={hidePricing}
						/>
					)}
					{!hidePricing && apiConfiguration.apiProvider !== providerIdentifiers.mimo && (
						<div className="text-sm text-vscode-descriptionForeground" data-testid="automatic-fetch-hint">
							<Trans
								i18nKey="settings:modelPicker.automaticFetch"
								components={{
									serviceLink: <VSCodeLink href={serviceUrl} className="text-sm" />,
									defaultModelLink: (
										<VSCodeLink onClick={() => onSelect(defaultModelId)} className="text-sm" />
									),
								}}
								values={{ serviceName, defaultModelId }}
							/>
						</div>
					)}
				</div>
			)}
		</>
	)
}
