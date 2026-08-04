import React from "react"

import {
	OpenAiCodexServiceTier,
	type OpenAiCodexServiceTier as OpenAiCodexServiceTierValue,
} from "@roo-code/types/model"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, StandardTooltip } from "@src/components/ui"

interface OpenAICodexSpeedSelectorProps {
	value?: OpenAiCodexServiceTierValue
	onValueChange: (value: OpenAiCodexServiceTierValue) => void
}

export const OpenAICodexSpeedSelector: React.FC<OpenAICodexSpeedSelectorProps> = ({ value, onValueChange }) => {
	const { t } = useAppTranslation()
	const selectId = React.useId()

	return (
		<div className="flex flex-col gap-1" data-testid="openai-codex-service-tier">
			<div className="flex items-center gap-1">
				<label htmlFor={selectId} className="block font-medium">
					{t("settings:openAiCodexSpeed.label")}
				</label>
				<StandardTooltip content={t("settings:openAiCodexSpeed.tooltip")}>
					<i className="codicon codicon-info text-vscode-descriptionForeground text-xs" />
				</StandardTooltip>
			</div>
			<Select value={value ?? OpenAiCodexServiceTier.Default} onValueChange={onValueChange}>
				<SelectTrigger id={selectId} className="w-full">
					<SelectValue placeholder={t("settings:common.select")} />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={OpenAiCodexServiceTier.Default}>
						{t("settings:openAiCodexSpeed.standard")}
					</SelectItem>
					<SelectItem value={OpenAiCodexServiceTier.Priority}>
						{t("settings:openAiCodexSpeed.fast")}
					</SelectItem>
				</SelectContent>
			</Select>
		</div>
	)
}
