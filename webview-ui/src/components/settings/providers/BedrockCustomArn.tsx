import { useMemo } from "react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import {
	type ProviderSettings,
	BEDROCK_CUSTOM_ARN_OTHER_BASE_MODEL,
	BEDROCK_DEFAULT_CONTEXT,
	BEDROCK_MAX_TOKENS,
	bedrockModels,
	isBedrockFoundationModelArn,
	resolveBedrockCustomArnBaseModelId,
} from "@roo-code/types"

import { validateBedrockArn } from "@src/utils/validate"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@src/components/ui"

const baseModelIds = Object.keys(bedrockModels).sort((a, b) => a.localeCompare(b))

const toPositiveInteger = (value: string): number | undefined => {
	const parsed = Number.parseInt(value, 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

type BedrockCustomArnProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
}

export const BedrockCustomArn = ({ apiConfiguration, setApiConfigurationField }: BedrockCustomArnProps) => {
	const { t } = useAppTranslation()

	const validation = useMemo(() => {
		const { awsCustomArn, awsRegion } = apiConfiguration
		return awsCustomArn ? validateBedrockArn(awsCustomArn, awsRegion) : { isValid: true, errorMessage: undefined }
	}, [apiConfiguration])

	const baseModelId =
		resolveBedrockCustomArnBaseModelId(apiConfiguration.awsCustomArn, apiConfiguration.awsCustomArnBaseModelId) ??
		BEDROCK_CUSTOM_ARN_OTHER_BASE_MODEL
	// A foundation-model ARN invokes the model it names, so the underlying model can't be changed.
	const isFoundationModelArn = isBedrockFoundationModelArn(apiConfiguration.awsCustomArn)

	// Different models have different output, thinking and context defaults.
	const resetModelSettings = () => {
		setApiConfigurationField("modelMaxTokens", undefined)
		setApiConfigurationField("modelMaxThinkingTokens", undefined)
		setApiConfigurationField("reasoningEffort", undefined)
		setApiConfigurationField("awsModelContextWindow", undefined)
	}

	const onBaseModelChange = (value: string) => {
		setApiConfigurationField("awsCustomArnBaseModelId", value)
		resetModelSettings()
	}

	// The underlying model and limits belong to one ARN, so a different ARN starts from detection again.
	const onArnInput = (value: string) => {
		if (value === (apiConfiguration.awsCustomArn ?? "")) {
			return
		}
		setApiConfigurationField("awsCustomArn", value)
		setApiConfigurationField("awsCustomArnBaseModelId", "")
		resetModelSettings()
	}

	return (
		<>
			<VSCodeTextField
				value={apiConfiguration?.awsCustomArn || ""}
				onInput={(e) => onArnInput((e.target as HTMLInputElement).value)}
				placeholder={t("settings:placeholders.customArn")}
				className="w-full"
				data-testid="custom-arn-input">
				<label className="block font-medium mb-1">{t("settings:labels.customArn")}</label>
			</VSCodeTextField>
			<div className="text-sm text-vscode-descriptionForeground -mt-2">
				{t("settings:providers.awsCustomArnUse")}
				<ul className="list-disc pl-5 mt-1">
					<li>
						arn:aws:bedrock:eu-west-1:123456789012:inference-profile/eu.anthropic.claude-3-7-sonnet-20250219-v1:0
					</li>
					<li>arn:aws:bedrock:us-west-2:123456789012:provisioned-model/my-provisioned-model</li>
					<li>arn:aws:bedrock:us-east-1:123456789012:default-prompt-router/anthropic.claude:1</li>
				</ul>
				{t("settings:providers.awsCustomArnDesc")}
			</div>
			{!validation.isValid ? (
				<div className="text-sm text-vscode-errorForeground mt-2">
					{validation.errorMessage || t("settings:providers.invalidArnFormat")}
				</div>
			) : (
				validation.errorMessage && (
					<div className="text-sm text-vscode-errorForeground mt-2">{validation.errorMessage}</div>
				)
			)}
			<div data-testid="custom-arn-base-model">
				<label className="block font-medium mb-1">{t("settings:providers.awsCustomArnBaseModel")}</label>
				<Select value={baseModelId} onValueChange={onBaseModelChange} disabled={isFoundationModelArn}>
					<SelectTrigger className="w-full">
						<SelectValue placeholder={t("settings:common.select")} />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={BEDROCK_CUSTOM_ARN_OTHER_BASE_MODEL}>
							{t("settings:providers.awsCustomArnBaseModelOther")}
						</SelectItem>
						{baseModelIds.map((id) => (
							<SelectItem key={id} value={id}>
								{id}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<div className="text-sm text-vscode-descriptionForeground mt-1">
					{t("settings:providers.awsCustomArnBaseModelDesc")}
				</div>
			</div>
			{baseModelId === BEDROCK_CUSTOM_ARN_OTHER_BASE_MODEL && (
				<>
					<VSCodeTextField
						value={apiConfiguration.awsModelContextWindow?.toString() ?? ""}
						onInput={(e) =>
							setApiConfigurationField(
								"awsModelContextWindow",
								toPositiveInteger((e.target as HTMLInputElement).value),
							)
						}
						placeholder={BEDROCK_DEFAULT_CONTEXT.toString()}
						className="w-full"
						data-testid="custom-arn-context-window">
						<label className="block font-medium mb-1">
							{t("settings:providers.awsCustomArnContextWindow")}
						</label>
					</VSCodeTextField>
					<VSCodeTextField
						value={apiConfiguration.modelMaxTokens?.toString() ?? ""}
						onInput={(e) =>
							setApiConfigurationField(
								"modelMaxTokens",
								toPositiveInteger((e.target as HTMLInputElement).value),
							)
						}
						placeholder={BEDROCK_MAX_TOKENS.toString()}
						className="w-full"
						data-testid="custom-arn-max-tokens">
						<label className="block font-medium mb-1">
							{t("settings:providers.awsCustomArnMaxTokens")}
						</label>
					</VSCodeTextField>
				</>
			)}
		</>
	)
}
