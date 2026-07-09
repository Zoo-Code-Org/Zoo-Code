import { useCallback, useEffect, useState } from "react"
import { Checkbox } from "vscrui"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import {
	type ProviderSettings,
	type OrganizationAllowList,
	anthropicModels,
	openAiModelInfoSaneDefaults,
} from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Button, StandardTooltip } from "@src/components/ui"
import { VSCodeButtonLink } from "@src/components/common/VSCodeButtonLink"

import { inputEventTransform } from "../transforms"
import { ModelPicker } from "../ModelPicker"

type AnthropicCustomProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: <K extends keyof ProviderSettings>(
		field: K,
		value: ProviderSettings[K],
		isUserAction?: boolean,
	) => void
	organizationAllowList: OrganizationAllowList
	modelValidationError?: string
	simplifySettings?: boolean
}

const anthropicCustomDefaultModelId = "claude-sonnet-4-5"

export const AnthropicCustom = ({
	apiConfiguration,
	setApiConfigurationField,
	organizationAllowList,
	modelValidationError,
	simplifySettings,
}: AnthropicCustomProps) => {
	const { t } = useAppTranslation()

	const [anthropicBaseUrlSelected, setAnthropicBaseUrlSelected] = useState(!!apiConfiguration?.anthropicCustomBaseUrl)

	useEffect(() => {
		if (!apiConfiguration.anthropicCustomModelInfo) {
			setApiConfigurationField(
				"anthropicCustomModelInfo",
				{
					...openAiModelInfoSaneDefaults,
					...(anthropicModels[anthropicCustomDefaultModelId] || {}),
				},
				false,
			)
		}
	}, [apiConfiguration.anthropicCustomModelInfo, setApiConfigurationField])

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

	const getCustomModelInfo = () => apiConfiguration?.anthropicCustomModelInfo || openAiModelInfoSaneDefaults

	return (
		<>
			<VSCodeTextField
				value={apiConfiguration?.anthropicCustomApiKey || ""}
				type="password"
				onInput={handleInputChange("anthropicCustomApiKey")}
				placeholder={t("settings:placeholders.apiKey")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.anthropicApiKey")}</label>
			</VSCodeTextField>
			<div className="text-sm text-vscode-descriptionForeground -mt-2">
				{t("settings:providers.apiKeyStorageNotice")}
			</div>
			{!apiConfiguration?.anthropicCustomApiKey && (
				<VSCodeButtonLink href="https://console.anthropic.com/settings/keys" appearance="secondary">
					{t("settings:providers.getAnthropicApiKey")}
				</VSCodeButtonLink>
			)}
			<div>
				<Checkbox
					checked={anthropicBaseUrlSelected}
					onChange={(checked: boolean) => {
						setAnthropicBaseUrlSelected(checked)

						if (!checked) {
							setApiConfigurationField("anthropicCustomBaseUrl", "")
						}
					}}>
					{t("settings:providers.useCustomBaseUrl")}
				</Checkbox>
				{anthropicBaseUrlSelected && (
					<VSCodeTextField
						value={apiConfiguration?.anthropicCustomBaseUrl || ""}
						type="url"
						onInput={handleInputChange("anthropicCustomBaseUrl")}
						placeholder="https://api.anthropic.com"
						className="w-full mt-1">
						<label className="block font-medium mb-1">Base URL</label>
					</VSCodeTextField>
				)}
			</div>
			<ModelPicker
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={(field, value, isUserAction) => {
					setApiConfigurationField(field, value, isUserAction)

					if (field === "anthropicCustomModelId") {
						setApiConfigurationField(
							"anthropicCustomModelInfo",
							{
								...openAiModelInfoSaneDefaults,
								...(anthropicModels[value as keyof typeof anthropicModels] || {}),
							},
							false,
						)
					}
				}}
				defaultModelId={anthropicCustomDefaultModelId}
				models={anthropicModels}
				modelIdKey="anthropicCustomModelId"
				serviceName="Anthropic"
				serviceUrl="https://docs.anthropic.com"
				organizationAllowList={organizationAllowList}
				errorMessage={modelValidationError}
				simplifySettings={simplifySettings}
			/>

			<div className="flex flex-col gap-3">
				<div className="text-sm text-vscode-descriptionForeground whitespace-pre-line">
					{t("settings:providers.customModel.capabilities")}
				</div>

				<div>
					<VSCodeTextField
						value={getCustomModelInfo().maxTokens?.toString() || ""}
						type="text"
						onInput={handleInputChange("anthropicCustomModelInfo", (e) => {
							const value = parseInt((e.target as HTMLInputElement).value)

							return {
								...getCustomModelInfo(),
								maxTokens: isNaN(value) ? undefined : value,
							}
						})}
						placeholder={t("settings:placeholders.numbers.maxTokens")}
						className="w-full">
						<label className="block font-medium mb-1">
							{t("settings:providers.customModel.maxTokens.label")}
						</label>
					</VSCodeTextField>
					<div className="text-sm text-vscode-descriptionForeground">
						{t("settings:providers.customModel.maxTokens.description")}
					</div>
				</div>

				<div>
					<VSCodeTextField
						value={getCustomModelInfo().contextWindow?.toString() || ""}
						type="text"
						onInput={handleInputChange("anthropicCustomModelInfo", (e) => {
							const value = parseInt((e.target as HTMLInputElement).value)

							return {
								...getCustomModelInfo(),
								contextWindow: isNaN(value) ? openAiModelInfoSaneDefaults.contextWindow : value,
							}
						})}
						placeholder={t("settings:placeholders.numbers.contextWindow")}
						className="w-full">
						<label className="block font-medium mb-1">
							{t("settings:providers.customModel.contextWindow.label")}
						</label>
					</VSCodeTextField>
					<div className="text-sm text-vscode-descriptionForeground">
						{t("settings:providers.customModel.contextWindow.description")}
					</div>
				</div>

				<div>
					<div className="flex items-center gap-1">
						<Checkbox
							checked={getCustomModelInfo().supportsImages ?? false}
							onChange={handleInputChange("anthropicCustomModelInfo", (checked) => ({
								...getCustomModelInfo(),
								supportsImages: checked,
							}))}>
							<span className="font-medium">
								{t("settings:providers.customModel.imageSupport.label")}
							</span>
						</Checkbox>
						<StandardTooltip content={t("settings:providers.customModel.imageSupport.description")}>
							<i
								className="codicon codicon-info text-vscode-descriptionForeground"
								style={{ fontSize: "12px" }}
							/>
						</StandardTooltip>
					</div>
				</div>

				<div>
					<div className="flex items-center gap-1">
						<Checkbox
							checked={getCustomModelInfo().supportsPromptCache ?? false}
							onChange={handleInputChange("anthropicCustomModelInfo", (checked) => ({
								...getCustomModelInfo(),
								supportsPromptCache: checked,
							}))}>
							<span className="font-medium">{t("settings:providers.customModel.promptCache.label")}</span>
						</Checkbox>
						<StandardTooltip content={t("settings:providers.customModel.promptCache.description")}>
							<i
								className="codicon codicon-info text-vscode-descriptionForeground"
								style={{ fontSize: "12px" }}
							/>
						</StandardTooltip>
					</div>
				</div>

				<div>
					<VSCodeTextField
						value={getCustomModelInfo().inputPrice?.toString() ?? ""}
						type="text"
						onChange={handleInputChange("anthropicCustomModelInfo", (e) => {
							const parsed = parseFloat((e.target as HTMLInputElement).value)

							return {
								...getCustomModelInfo(),
								inputPrice: isNaN(parsed) ? openAiModelInfoSaneDefaults.inputPrice : parsed,
							}
						})}
						placeholder={t("settings:placeholders.numbers.inputPrice")}
						className="w-full">
						<div className="flex items-center gap-1">
							<label className="block font-medium mb-1">
								{t("settings:providers.customModel.pricing.input.label")}
							</label>
							<StandardTooltip content={t("settings:providers.customModel.pricing.input.description")}>
								<i
									className="codicon codicon-info text-vscode-descriptionForeground"
									style={{ fontSize: "12px" }}
								/>
							</StandardTooltip>
						</div>
					</VSCodeTextField>
				</div>

				<div>
					<VSCodeTextField
						value={getCustomModelInfo().outputPrice?.toString() ?? ""}
						type="text"
						onChange={handleInputChange("anthropicCustomModelInfo", (e) => {
							const parsed = parseFloat((e.target as HTMLInputElement).value)

							return {
								...getCustomModelInfo(),
								outputPrice: isNaN(parsed) ? openAiModelInfoSaneDefaults.outputPrice : parsed,
							}
						})}
						placeholder={t("settings:placeholders.numbers.outputPrice")}
						className="w-full">
						<div className="flex items-center gap-1">
							<label className="block font-medium mb-1">
								{t("settings:providers.customModel.pricing.output.label")}
							</label>
							<StandardTooltip content={t("settings:providers.customModel.pricing.output.description")}>
								<i
									className="codicon codicon-info text-vscode-descriptionForeground"
									style={{ fontSize: "12px" }}
								/>
							</StandardTooltip>
						</div>
					</VSCodeTextField>
				</div>

				{getCustomModelInfo().supportsPromptCache && (
					<>
						<div>
							<VSCodeTextField
								value={getCustomModelInfo().cacheReadsPrice?.toString() ?? "0"}
								type="text"
								onChange={handleInputChange("anthropicCustomModelInfo", (e) => {
									const parsed = parseFloat((e.target as HTMLInputElement).value)

									return {
										...getCustomModelInfo(),
										cacheReadsPrice: isNaN(parsed) ? 0 : parsed,
									}
								})}
								placeholder={t("settings:placeholders.numbers.inputPrice")}
								className="w-full">
								<span className="font-medium">
									{t("settings:providers.customModel.pricing.cacheReads.label")}
								</span>
							</VSCodeTextField>
						</div>
						<div>
							<VSCodeTextField
								value={getCustomModelInfo().cacheWritesPrice?.toString() ?? "0"}
								type="text"
								onChange={handleInputChange("anthropicCustomModelInfo", (e) => {
									const parsed = parseFloat((e.target as HTMLInputElement).value)

									return {
										...getCustomModelInfo(),
										cacheWritesPrice: isNaN(parsed) ? 0 : parsed,
									}
								})}
								placeholder={t("settings:placeholders.numbers.cacheWritePrice")}
								className="w-full">
								<label className="block font-medium mb-1">
									{t("settings:providers.customModel.pricing.cacheWrites.label")}
								</label>
							</VSCodeTextField>
						</div>
					</>
				)}

				<Button
					variant="secondary"
					onClick={() =>
						setApiConfigurationField("anthropicCustomModelInfo", {
							...openAiModelInfoSaneDefaults,
							...(anthropicModels[
								apiConfiguration.anthropicCustomModelId as keyof typeof anthropicModels
							] || {}),
						})
					}>
					{t("settings:providers.customModel.resetDefaults")}
				</Button>
			</div>
		</>
	)
}
