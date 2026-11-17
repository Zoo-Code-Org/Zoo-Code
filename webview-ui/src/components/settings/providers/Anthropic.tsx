import { useCallback, useId, useState } from "react"
import { Checkbox } from "vscrui"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import type { ProviderSettings } from "@roo-code/types"
import { DEFAULT_PROMPT_CACHE_TTL } from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { VSCodeButtonLink } from "@src/components/common/VSCodeButtonLink"
import { useSelectedModel } from "@src/components/ui/hooks/useSelectedModel"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@src/components/ui"

import { inputEventTransform, noTransform } from "../transforms"

type AnthropicProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	simplifySettings?: boolean
}

export const Anthropic = ({ apiConfiguration, setApiConfigurationField }: AnthropicProps) => {
	const { t } = useAppTranslation()
	const selectedModel = useSelectedModel(apiConfiguration)

	const [anthropicBaseUrlSelected, setAnthropicBaseUrlSelected] = useState(!!apiConfiguration.anthropicBaseUrl)

	// Check if the current model supports 1M context beta
	const supports1MContextBeta =
		selectedModel?.id === "claude-sonnet-4-20250514" ||
		selectedModel?.id === "claude-sonnet-4-5" ||
		selectedModel?.id === "claude-sonnet-4-6" ||
		selectedModel?.id === "claude-opus-4-6"

	// The 1h cache TTL is only offered where the catalog advertises it, so the
	// control cannot produce a value the provider would reject. Absent capability
	// metadata means 5m only (ADR-0006 I2).
	const supportsPromptCacheTtl1h = selectedModel?.info?.promptCacheTtlSupport?.includes("1h") ?? false

	// Unset must stay absent so the request carries no ttl key at all (ADR-0006 I3),
	// which is exactly what the shared default says. The control still needs a
	// visible selection, so an unset knob renders as the vendor's own 5m default.
	const promptCacheTtl = apiConfiguration.promptCacheTtl ?? "5m"

	// The visible label must activate the trigger for pointer users, so it is
	// associated by id. The trigger keeps its aria-label for screen readers.
	const promptCacheTtlId = useId()

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
			<VSCodeTextField
				value={apiConfiguration.apiKey || ""}
				type="password"
				onInput={handleInputChange("apiKey")}
				placeholder={t("settings:placeholders.apiKey")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.anthropicApiKey")}</label>
			</VSCodeTextField>
			<div className="text-sm text-vscode-descriptionForeground -mt-2">
				{t("settings:providers.apiKeyStorageNotice")}
			</div>
			{!apiConfiguration.apiKey && (
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
							setApiConfigurationField("anthropicBaseUrl", "")
							setApiConfigurationField("anthropicUseAuthToken", false)
						}
					}}>
					{t("settings:providers.useCustomBaseUrl")}
				</Checkbox>
				{anthropicBaseUrlSelected && (
					<>
						<VSCodeTextField
							value={apiConfiguration.anthropicBaseUrl || ""}
							type="url"
							onInput={handleInputChange("anthropicBaseUrl")}
							placeholder="https://api.anthropic.com"
							className="w-full mt-1"
						/>
						<Checkbox
							checked={apiConfiguration.anthropicUseAuthToken ?? false}
							onChange={handleInputChange("anthropicUseAuthToken", noTransform)}
							className="w-full mt-1">
							{t("settings:providers.anthropicUseAuthToken")}
						</Checkbox>
					</>
				)}
			</div>
			{supports1MContextBeta && (
				<div>
					<Checkbox
						checked={apiConfiguration.anthropicBeta1MContext ?? false}
						onChange={(checked: boolean) => {
							setApiConfigurationField("anthropicBeta1MContext", checked)
						}}>
						{t("settings:providers.anthropic1MContextBetaLabel")}
					</Checkbox>
					<div className="text-sm text-vscode-descriptionForeground mt-1 ml-6">
						{t("settings:providers.anthropic1MContextBetaDescription")}
					</div>
				</div>
			)}
			{supportsPromptCacheTtl1h && (
				<div data-testid="prompt-cache-ttl">
					<label htmlFor={promptCacheTtlId} className="block font-medium mb-1">
						{t("settings:providers.promptCacheTtlLabel")}
					</label>
					<Select
						value={promptCacheTtl}
						onValueChange={(value) =>
							setApiConfigurationField(
								"promptCacheTtl",
								value === "5m"
									? DEFAULT_PROMPT_CACHE_TTL
									: (value as ProviderSettings["promptCacheTtl"]),
							)
						}>
						<SelectTrigger
							id={promptCacheTtlId}
							className="w-full"
							aria-label={t("settings:providers.promptCacheTtlLabel")}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="5m">{t("settings:providers.promptCacheTtl5m")}</SelectItem>
							<SelectItem value="1h">{t("settings:providers.promptCacheTtl1h")}</SelectItem>
						</SelectContent>
					</Select>
					<div className="text-sm text-vscode-descriptionForeground mt-1">
						{t("settings:providers.promptCacheTtlDescription")}
					</div>
				</div>
			)}
		</>
	)
}
