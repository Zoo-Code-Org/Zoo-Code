/*
Semantics for Reasoning Effort (ThinkingBudget)

Capability surface:
- modelInfo.supportsReasoningEffort: boolean | Array&lt;"disable" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"&gt;
  - true  → UI shows ["low","medium","high"]
  - array → UI shows exactly the provided values (e.g. GPT-5.5 includes "xhigh")

Selection behavior:
- "disable":
  - Label: t("settings:providers.reasoningEffort.none")
  - set enableReasoningEffort = false
  - persist reasoningEffort = "disable"
  - request builders omit any reasoning parameter/body sections
- "none":
  - Label: t("settings:providers.reasoningEffort.none")
  - set enableReasoningEffort = true
  - persist reasoningEffort = "none"
  - request builders include reasoning with value "none"
- "minimal" | "low" | "medium" | "high" | "xhigh" | "max":
  - set enableReasoningEffort = true
  - persist the selected value
  - request builders include reasoning with the selected effort

Required:
- If modelInfo.requiredReasoningEffort is true, do not synthesize a "None" choice. Only show values from the capability.
- On mount, if unset and a default exists, set enableReasoningEffort = true and use modelInfo.reasoningEffort.

Notes:
- Current selection is normalized to the capability: unsupported persisted values are not shown.
- Both "disable" and "none" display as the "None" label per UX, but are wired differently as above.
- "minimal" uses t("settings:providers.reasoningEffort.minimal").
*/

import { useEffect } from "react"
import { Checkbox } from "vscrui"

import { type ProviderSettings, type ModelInfo, type ReasoningEffortExtended, reasoningEfforts } from "@roo-code/types"

import {
	DEFAULT_HYBRID_REASONING_MODEL_MAX_TOKENS,
	DEFAULT_HYBRID_REASONING_MODEL_THINKING_TOKENS,
	GEMINI_25_PRO_MIN_THINKING_TOKENS,
	getModelMaxOutputTokens,
} from "@roo/api"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Slider, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@src/components/ui"
import { useSelectedModel } from "@src/components/ui/hooks/useSelectedModel"

interface ThinkingBudgetProps {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: <K extends keyof ProviderSettings>(
		field: K,
		value: ProviderSettings[K],
		isUserAction?: boolean,
	) => void
	modelInfo?: ModelInfo
}

export const ThinkingBudget = ({ apiConfiguration, setApiConfigurationField, modelInfo }: ThinkingBudgetProps) => {
	const { t } = useAppTranslation()
	const { id: selectedModelId } = useSelectedModel(apiConfiguration)

	// Check if this is a Gemini 2.5 Pro model
	const isGemini25Pro = selectedModelId && selectedModelId.includes("gemini-2.5-pro")
	const minThinkingTokens = isGemini25Pro ? GEMINI_25_PRO_MIN_THINKING_TOKENS : 1024

	// Check model capabilities
	const isReasoningSupported = !!modelInfo && modelInfo.supportsReasoningBinary
	const isReasoningBudgetSupported = !!modelInfo && modelInfo.supportsReasoningBudget
	const isReasoningBudgetRequired = !!modelInfo && modelInfo.requiredReasoningBudget
	const isReasoningEffortSupported = !!modelInfo && modelInfo.supportsReasoningEffort
	// Models that advertise a user-configurable max output budget (e.g. Z.ai GLM) but do not
	// use the reasoning-budget slider. The reasoning-budget branch already renders its own
	// max-tokens control, so only surface this standalone slider when that branch is inactive.
	const isMaxTokensConfigurable = !!modelInfo && modelInfo.supportsMaxTokens && !isReasoningBudgetSupported

	// "disable" turns off reasoning entirely; "none" is a valid reasoning level.
	// Both display as "None" in the UI but behave differently.
	// Arrays from supportsReasoningEffort may include "disable" (e.g. Z.ai GLM), so type the
	// full option set as ReasoningEffortExtended | "disable" from the start to avoid casts.
	type ReasoningEffortOption = ReasoningEffortExtended | "disable"
	const supports = modelInfo?.supportsReasoningEffort
	const baseAvailableOptions: ReadonlyArray<ReasoningEffortOption> =
		supports === true
			? (reasoningEfforts as readonly ReasoningEffortOption[])
			: Array.isArray(supports)
				? (supports as ReadonlyArray<ReasoningEffortOption>)
				: (reasoningEfforts as readonly ReasoningEffortOption[])

	// Add "disable" option only when:
	// 1. requiredReasoningEffort is not true, AND
	// 2. supportsReasoningEffort is boolean true (not an explicit array)
	// When the model provides an explicit array, respect those exact values.
	const shouldAutoAddDisable =
		!modelInfo?.requiredReasoningEffort && supports === true && !baseAvailableOptions.includes("disable")
	const availableOptions: ReadonlyArray<ReasoningEffortOption> = shouldAutoAddDisable
		? ["disable", ...baseAvailableOptions]
		: baseAvailableOptions

	// Default reasoning effort - use model's default if available
	// GPT-5 models have "medium" as their default in the model configuration
	const modelDefaultReasoningEffort = modelInfo?.reasoningEffort as ReasoningEffortExtended | undefined
	const defaultReasoningEffort: ReasoningEffortOption = modelInfo?.requiredReasoningEffort
		? modelDefaultReasoningEffort || "medium"
		: "disable"
	// Current reasoning effort from settings, or fall back to default.
	// Clamp to availableOptions so the Select trigger always renders a valid option.
	const storedReasoningEffort = apiConfiguration.reasoningEffort as ReasoningEffortOption | undefined
	const rawReasoningEffort: ReasoningEffortOption = storedReasoningEffort || defaultReasoningEffort
	const currentReasoningEffort: ReasoningEffortOption = availableOptions.includes(rawReasoningEffort)
		? rawReasoningEffort
		: (availableOptions[0] ?? rawReasoningEffort)

	// Set default reasoning effort when model supports it and no value is set
	useEffect(() => {
		if (isReasoningEffortSupported && !apiConfiguration.reasoningEffort) {
			// Only set a default if reasoning is required, otherwise leave as undefined (which maps to "disable")
			if (modelInfo?.requiredReasoningEffort && defaultReasoningEffort !== "disable") {
				setApiConfigurationField("reasoningEffort", defaultReasoningEffort as ReasoningEffortExtended, false)
			}
		}
	}, [
		isReasoningEffortSupported,
		apiConfiguration.reasoningEffort,
		defaultReasoningEffort,
		modelInfo?.requiredReasoningEffort,
		setApiConfigurationField,
	])

	// Sync enableReasoningEffort based on selection
	// "disable" turns off reasoning; "none" is a valid level (reasoning enabled)
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

	const enableReasoningEffort = apiConfiguration.enableReasoningEffort
	const customMaxOutputTokens = apiConfiguration.modelMaxTokens || DEFAULT_HYBRID_REASONING_MODEL_MAX_TOKENS
	const customMaxThinkingTokens =
		apiConfiguration.modelMaxThinkingTokens || DEFAULT_HYBRID_REASONING_MODEL_THINKING_TOKENS

	// Dynamically expand or shrink the max thinking budget based on the custom
	// max output tokens so that there's always a 20% buffer.
	const modelMaxThinkingTokens = modelInfo?.maxThinkingTokens
		? Math.min(modelInfo.maxThinkingTokens, Math.floor(0.8 * customMaxOutputTokens))
		: Math.floor(0.8 * customMaxOutputTokens)

	// If the custom max thinking tokens are going to exceed it's limit due
	// to the custom max output tokens being reduced then we need to shrink it
	// appropriately.
	useEffect(() => {
		if (isReasoningBudgetSupported && customMaxThinkingTokens > modelMaxThinkingTokens) {
			setApiConfigurationField("modelMaxThinkingTokens", modelMaxThinkingTokens, false)
		}
	}, [isReasoningBudgetSupported, customMaxThinkingTokens, modelMaxThinkingTokens, setApiConfigurationField])

	// Default max output budget for models that expose a standalone max-tokens slider.
	// When the user hasn't set an explicit `modelMaxTokens`, fall back to the same value
	// the runtime would use (the default output clamp) so behavior is unchanged.
	const defaultMaxOutputTokens =
		(isMaxTokensConfigurable && selectedModelId && modelInfo
			? getModelMaxOutputTokens({ modelId: selectedModelId, model: modelInfo, settings: apiConfiguration })
			: undefined) ??
		modelInfo?.maxTokens ??
		DEFAULT_HYBRID_REASONING_MODEL_MAX_TOKENS
	const standaloneMaxOutputTokens = apiConfiguration.modelMaxTokens ?? defaultMaxOutputTokens

	if (!modelInfo) {
		return null
	}

	// Shared markup for the "Max Output Tokens" slider, reused by the standalone control
	// (supportsMaxTokens models) and the reasoning-budget branch below.
	const renderMaxTokensSlider = (min: number, max: number, value: number, testId?: string) => (
		<div className="flex flex-col gap-1" {...(testId ? { "data-testid": testId } : {})}>
			<div className="font-medium">{t("settings:thinkingBudget.maxTokens")}</div>
			<div className="flex items-center gap-1">
				<Slider
					min={min}
					max={max}
					step={1024}
					value={[value]}
					onValueChange={([newValue]) => setApiConfigurationField("modelMaxTokens", newValue)}
				/>
				<div className="w-12 text-sm text-center">{value}</div>
			</div>
		</div>
	)

	// Standalone max output tokens slider for models that advertise `supportsMaxTokens`
	// (e.g. Z.ai GLM) but do not surface the reasoning-budget control.
	const maxOutputTokensControl =
		isMaxTokensConfigurable && modelInfo.maxTokens
			? renderMaxTokensSlider(1024, modelInfo.maxTokens, standaloneMaxOutputTokens, "max-output-tokens")
			: null

	// Models with supportsReasoningBinary (binary reasoning) show a simple on/off toggle.
	// A binary-reasoning model can still advertise `supportsMaxTokens`, so surface the
	// standalone max-output slider alongside the toggle when it applies.
	if (isReasoningSupported) {
		return (
			<>
				{maxOutputTokensControl}
				<div className="flex flex-col gap-1">
					<Checkbox
						checked={enableReasoningEffort}
						onChange={(checked: boolean) =>
							setApiConfigurationField("enableReasoningEffort", checked === true)
						}>
						{t("settings:providers.useReasoning")}
					</Checkbox>
				</div>
			</>
		)
	}

	return isReasoningBudgetSupported && !!modelInfo.maxTokens ? (
		<>
			{!isReasoningBudgetRequired && (
				<div className="flex flex-col gap-1">
					<Checkbox
						checked={enableReasoningEffort}
						onChange={(checked: boolean) =>
							setApiConfigurationField("enableReasoningEffort", checked === true)
						}>
						{t("settings:providers.useReasoning")}
					</Checkbox>
				</div>
			)}
			{(isReasoningBudgetRequired || enableReasoningEffort) && (
				<>
					{renderMaxTokensSlider(
						8192,
						Math.max(
							modelInfo.maxTokens || 8192,
							customMaxOutputTokens,
							DEFAULT_HYBRID_REASONING_MODEL_MAX_TOKENS,
						),
						customMaxOutputTokens,
					)}
					<div className="flex flex-col gap-1">
						<div className="font-medium">{t("settings:thinkingBudget.maxThinkingTokens")}</div>
						<div className="flex items-center gap-1" data-testid="reasoning-budget">
							<Slider
								min={minThinkingTokens}
								max={modelMaxThinkingTokens}
								step={minThinkingTokens === 128 ? 128 : 1024}
								value={[customMaxThinkingTokens]}
								onValueChange={([value]) => setApiConfigurationField("modelMaxThinkingTokens", value)}
							/>
							<div className="w-12 text-sm text-center">{customMaxThinkingTokens}</div>
						</div>
					</div>
				</>
			)}
		</>
	) : isReasoningEffortSupported ? (
		<>
			{maxOutputTokensControl}
			<div className="flex flex-col gap-1" data-testid="reasoning-effort">
				<div className="flex justify-between items-center">
					<label className="block font-medium mb-1">{t("settings:providers.reasoningEffort.label")}</label>
				</div>
				<Select
					value={currentReasoningEffort}
					onValueChange={(value: ReasoningEffortOption) => {
						// "disable" turns off reasoning entirely; "none" is a valid reasoning level
						if (value === "disable") {
							setApiConfigurationField("enableReasoningEffort", false)
							setApiConfigurationField("reasoningEffort", "disable")
						} else {
							// "none", "minimal", "low", "medium", "high" all enable reasoning
							setApiConfigurationField("enableReasoningEffort", true)
							setApiConfigurationField("reasoningEffort", value as ReasoningEffortExtended)
						}
					}}>
					<SelectTrigger className="w-full">
						<SelectValue
							placeholder={
								currentReasoningEffort
									? currentReasoningEffort === "none" || currentReasoningEffort === "disable"
										? t("settings:providers.reasoningEffort.none")
										: t(`settings:providers.reasoningEffort.${currentReasoningEffort}`)
									: t("settings:common.select")
							}
						/>
					</SelectTrigger>
					<SelectContent>
						{availableOptions.map((value) => (
							<SelectItem key={value} value={value}>
								{value === "none" || value === "disable"
									? t("settings:providers.reasoningEffort.none")
									: t(`settings:providers.reasoningEffort.${value}`)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
		</>
	) : (
		maxOutputTokensControl
	)
}
