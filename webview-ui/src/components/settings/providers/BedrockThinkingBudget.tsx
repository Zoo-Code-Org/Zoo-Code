import type { ProviderSettings, ModelInfo } from "@roo-code/types"

import { ThinkingBudget } from "../ThinkingBudget"
import { useBedrockMaxTokensProbeUi } from "./BedrockMaxTokensProbeButton"

interface BedrockThinkingBudgetProps {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: <K extends keyof ProviderSettings>(
		field: K,
		value: ProviderSettings[K],
		isUserAction?: boolean,
	) => void
	modelInfo?: ModelInfo
	modelId?: string
}

/**
 * Bedrock-specific wrapper around `ThinkingBudget`. Mounts the probe hook (must run
 * unconditionally on every render) and feeds its UI into the enhanced max-output-tokens
 * control. Other providers continue to use `ThinkingBudget` directly with the legacy
 * slider so we don't change their behaviour.
 */
export const BedrockThinkingBudget = ({
	apiConfiguration,
	setApiConfigurationField,
	modelInfo,
	modelId,
}: BedrockThinkingBudgetProps) => {
	const { buttonSlot, helperText } = useBedrockMaxTokensProbeUi({
		apiConfiguration,
		setApiConfigurationField,
		modelId,
	})

	return (
		<ThinkingBudget
			apiConfiguration={apiConfiguration}
			setApiConfigurationField={setApiConfigurationField}
			modelInfo={modelInfo}
			useEnhancedMaxOutputControl
			maxOutputTokensExtraSlot={buttonSlot}
			maxOutputTokensHelperText={helperText}
		/>
	)
}
