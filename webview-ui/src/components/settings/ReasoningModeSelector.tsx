/*
Top-level Reasoning Mode selector.

Surfaces the reasoning-effort dropdown at the top of the Providers section (beside
the API configuration profile picker) so users can choose a model's reasoning mode
without digging into the provider-specific settings. It mirrors the effort-selector
semantics of ThinkingBudget and stays in sync with it because both write to the same
`reasoningEffort` / `enableReasoningEffort` fields.

Capability surface (identical to ThinkingBudget):
- modelInfo.supportsReasoningEffort: boolean | Array<"disable"|"none"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max">
  - true  → options ["disable","low","medium","high"]
  - array → options are exactly the provided values
- When the model does not support reasoning effort, this component renders nothing.
*/

import { useEffect } from "react"

import { type ProviderSettings, type ModelInfo, type ReasoningEffortExtended } from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@src/components/ui"
import {
	getReasoningEffortSelection,
	getReasoningEffortTranslationKey,
	type ReasoningEffortOption,
} from "@src/utils/reasoning-effort"

interface ReasoningModeSelectorProps {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: <K extends keyof ProviderSettings>(
		field: K,
		value: ProviderSettings[K],
		isUserAction?: boolean,
	) => void
	modelInfo?: ModelInfo
}

export const ReasoningModeSelector = ({
	apiConfiguration,
	setApiConfigurationField,
	modelInfo,
}: ReasoningModeSelectorProps) => {
	const { t } = useAppTranslation()

	// Option computation is shared with ThinkingBudget and the chat input bar
	// selector so every control agrees on the option set and clamped value.
	// "disable" turns off reasoning entirely; "none" is a valid reasoning level.
	// Both display as "None" in the UI but behave differently.
	const { isReasoningEffortSupported, availableOptions, currentReasoningEffort, storedReasoningEffort } =
		getReasoningEffortSelection(apiConfiguration, modelInfo)

	// Set default reasoning effort when model supports it and no value is set.
	useEffect(() => {
		if (
			isReasoningEffortSupported &&
			modelInfo?.requiredReasoningEffort &&
			storedReasoningEffort !== currentReasoningEffort &&
			currentReasoningEffort !== "disable"
		) {
			setApiConfigurationField("reasoningEffort", currentReasoningEffort as ReasoningEffortExtended, false)
		}
	}, [
		isReasoningEffortSupported,
		storedReasoningEffort,
		currentReasoningEffort,
		modelInfo?.requiredReasoningEffort,
		setApiConfigurationField,
	])

	// Sync enableReasoningEffort based on selection. "disable" turns off reasoning;
	// "none" is a valid level (reasoning enabled).
	useEffect(() => {
		if (!isReasoningEffortSupported) return
		const shouldEnable = modelInfo?.requiredReasoningEffort || currentReasoningEffort !== "disable"
		if (shouldEnable && apiConfiguration.enableReasoningEffort !== true) {
			setApiConfigurationField("enableReasoningEffort", true, false)
		}
	}, [
		isReasoningEffortSupported,
		modelInfo?.requiredReasoningEffort,
		currentReasoningEffort,
		apiConfiguration.enableReasoningEffort,
		setApiConfigurationField,
	])

	if (!isReasoningEffortSupported) {
		return null
	}

	return (
		<div className="flex flex-col gap-1" data-testid="reasoning-effort">
			<label className="block font-medium mb-1">{t("settings:providers.reasoningEffort.label")}</label>
			<Select
				value={currentReasoningEffort}
				onValueChange={(value: ReasoningEffortOption) => {
					// "disable" turns off reasoning entirely; "none" is a valid reasoning level
					if (value === "disable") {
						setApiConfigurationField("enableReasoningEffort", false)
						setApiConfigurationField("reasoningEffort", "disable")
					} else {
						setApiConfigurationField("enableReasoningEffort", true)
						setApiConfigurationField("reasoningEffort", value as ReasoningEffortExtended)
					}
				}}>
				<SelectTrigger className="w-full">
					<SelectValue
						placeholder={
							currentReasoningEffort
								? t(getReasoningEffortTranslationKey(currentReasoningEffort))
								: t("settings:common.select")
						}
					/>
				</SelectTrigger>
				<SelectContent>
					{availableOptions.map((value) => (
						<SelectItem key={value} value={value}>
							{t(getReasoningEffortTranslationKey(value))}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	)
}
