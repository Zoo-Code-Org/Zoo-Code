import { Checkbox } from "vscrui"
import { DEFAULT_OPEN_AI_CODEX_USE_WEBSOCKET } from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"

interface OpenAICodexWebSocketToggleProps {
	value?: boolean
	onChange: (enabled: boolean) => void
}

export function OpenAICodexWebSocketToggle({ value, onChange }: OpenAICodexWebSocketToggleProps) {
	const { t } = useAppTranslation()
	return (
		<div className="flex flex-col gap-1" data-testid="openai-codex-websocket">
			<Checkbox
				checked={value ?? DEFAULT_OPEN_AI_CODEX_USE_WEBSOCKET}
				onChange={(checked) => onChange(checked === true)}>
				{t("settings:openAiCodexWebSocket.label")}
			</Checkbox>
			<p className="m-0 text-sm text-vscode-descriptionForeground">
				{t("settings:openAiCodexWebSocket.description")}
			</p>
		</div>
	)
}
