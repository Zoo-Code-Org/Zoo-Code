import { useCallback, useState } from "react"
import { Checkbox } from "vscrui"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import { OpenAiServiceTier, type ModelInfo, type ProviderSettings } from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { VSCodeButtonLink } from "@src/components/common/VSCodeButtonLink"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, StandardTooltip } from "@src/components/ui"

import { inputEventTransform } from "../transforms"

type OpenAIProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	selectedModelInfo?: ModelInfo
	simplifySettings?: boolean
}

// The checkbox follows a saved value that changes from outside, such as a profile switch.
// The component adjusts state during render, as the React docs advise. Own writes do not move the checkbox.
// Spec: docs/architecture/tla/OpenAiDeploymentNameUi.tla
const useOptionalField = (
	field: "openAiNativeBaseUrl" | "openAiNativeDeploymentName",
	value: string | undefined,
	setField: OpenAIProps["setApiConfigurationField"],
) => {
	const current = value ?? ""
	const [selected, setSelected] = useState(!!current)
	const [seen, setSeen] = useState(current)
	const [written, setWritten] = useState(current)

	if (current !== seen) {
		setSeen(current)
		setWritten(current)
		if (current !== written) setSelected(!!current)
	}

	const write = (next: string) => {
		setWritten(next)
		setField(field, next)
	}

	return {
		selected,
		write,
		toggle: (checked: boolean) => {
			setSelected(checked)
			if (!checked) write("")
		},
	}
}

export const OpenAI = ({ apiConfiguration, setApiConfigurationField, selectedModelInfo }: OpenAIProps) => {
	const { t } = useAppTranslation()

	const baseUrl = useOptionalField(
		"openAiNativeBaseUrl",
		apiConfiguration.openAiNativeBaseUrl,
		setApiConfigurationField,
	)
	const deploymentName = useOptionalField(
		"openAiNativeDeploymentName",
		apiConfiguration.openAiNativeDeploymentName,
		setApiConfigurationField,
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

	return (
		<>
			<Checkbox checked={baseUrl.selected} onChange={baseUrl.toggle}>
				{t("settings:providers.useCustomBaseUrl")}
			</Checkbox>
			{baseUrl.selected && (
				<>
					<VSCodeTextField
						value={apiConfiguration.openAiNativeBaseUrl || ""}
						type="url"
						onInput={(event: unknown) => baseUrl.write(inputEventTransform(event))}
						placeholder="https://api.openai.com/v1"
						className="w-full mt-1"
					/>
				</>
			)}
			<Checkbox checked={deploymentName.selected} onChange={deploymentName.toggle}>
				{t("settings:providers.useCustomDeploymentName")}
			</Checkbox>
			{deploymentName.selected && (
				<>
					<VSCodeTextField
						value={apiConfiguration.openAiNativeDeploymentName || ""}
						type="text"
						data-testid="openai-native-deployment-name-input"
						onInput={(event: unknown) => deploymentName.write(inputEventTransform(event))}
						placeholder={t("settings:providers.openAiNativeDeploymentNamePlaceholder")}
						className="w-full mt-1">
						<label className="block font-medium mb-1">
							{t("settings:providers.openAiNativeDeploymentName")}
						</label>
					</VSCodeTextField>
					<div className="text-sm text-vscode-descriptionForeground -mt-2">
						{t("settings:providers.openAiNativeDeploymentNameDescription")}
					</div>
				</>
			)}
			<VSCodeTextField
				value={apiConfiguration.openAiNativeApiKey || ""}
				type="password"
				onInput={handleInputChange("openAiNativeApiKey")}
				placeholder={t("settings:placeholders.apiKey")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.openAiApiKey")}</label>
			</VSCodeTextField>
			<div className="text-sm text-vscode-descriptionForeground -mt-2">
				{t("settings:providers.apiKeyStorageNotice")}
			</div>
			{!apiConfiguration.openAiNativeApiKey && (
				<VSCodeButtonLink href="https://platform.openai.com/api-keys" appearance="secondary">
					{t("settings:providers.getOpenAiApiKey")}
				</VSCodeButtonLink>
			)}

			{(() => {
				const allowedTiers = (selectedModelInfo?.tiers?.map((t) => t.name).filter(Boolean) || []).filter(
					(t) => t === OpenAiServiceTier.Flex || t === OpenAiServiceTier.Priority,
				)
				if (allowedTiers.length === 0) return null

				return (
					<div className="flex flex-col gap-1 mt-2" data-testid="openai-service-tier">
						<div className="flex items-center gap-1">
							<label className="block font-medium mb-1">{t("settings:serviceTier.label")}</label>
							<StandardTooltip content={t("settings:serviceTier.tooltip")}>
								<i className="codicon codicon-info text-vscode-descriptionForeground text-xs" />
							</StandardTooltip>
						</div>

						<Select
							value={apiConfiguration.openAiNativeServiceTier || OpenAiServiceTier.Default}
							onValueChange={(value) =>
								setApiConfigurationField(
									"openAiNativeServiceTier",
									value as ProviderSettings["openAiNativeServiceTier"],
								)
							}>
							<SelectTrigger className="w-full">
								<SelectValue placeholder={t("settings:common.select")} />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={OpenAiServiceTier.Default}>
									{t("settings:serviceTier.standard")}
								</SelectItem>
								{allowedTiers.includes(OpenAiServiceTier.Flex) && (
									<SelectItem value={OpenAiServiceTier.Flex}>
										{t("settings:serviceTier.flex")}
									</SelectItem>
								)}
								{allowedTiers.includes(OpenAiServiceTier.Priority) && (
									<SelectItem value={OpenAiServiceTier.Priority}>
										{t("settings:serviceTier.priority")}
									</SelectItem>
								)}
							</SelectContent>
						</Select>
					</div>
				)
			})()}
		</>
	)
}
