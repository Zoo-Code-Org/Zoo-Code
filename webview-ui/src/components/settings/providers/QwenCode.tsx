import React from "react"
import { VSCodeTextField, VSCodeLink } from "@vscode/webview-ui-toolkit/react"

import { type ProviderSettings } from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"

interface QwenCodeProps {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	simplifySettings?: boolean
}

export const QwenCode: React.FC<QwenCodeProps> = ({ apiConfiguration, setApiConfigurationField }) => {
	const { t } = useAppTranslation()
	const defaultPath = "~/.qwen/oauth_creds.json"

	const handleInputChange = (e: Event | React.FormEvent<HTMLElement>) => {
		const element = e.target as HTMLInputElement
		setApiConfigurationField("qwenCodeOauthPath", element.value)
	}

	const handleBlur = (e: Event | React.FormEvent<HTMLElement>) => {
		const element = e.target as HTMLInputElement
		// If the field is empty on blur, set it to the default value
		if (!element.value || element.value.trim() === "") {
			setApiConfigurationField("qwenCodeOauthPath", defaultPath)
		}
	}

	return (
		<div className="flex flex-col gap-4">
			<div>
				<VSCodeTextField
					value={apiConfiguration.qwenCodeOauthPath || ""}
					className="w-full mt-1"
					type="text"
					onInput={handleInputChange}
					onBlur={handleBlur}
					placeholder={defaultPath}>
					{t("settings:providers.qwenCode.oauthPathLabel")}
				</VSCodeTextField>

				<p className="text-xs mt-1 text-vscode-descriptionForeground">
					{t("settings:providers.qwenCode.oauthPathDescription", { defaultPath })}
				</p>

				<div className="text-xs text-vscode-descriptionForeground mt-3">
					{t("settings:providers.qwenCode.description")}
				</div>

				<div className="text-xs text-vscode-descriptionForeground mt-2">
					{t("settings:providers.qwenCode.gettingStarted")}
					<br />
					{t("settings:providers.qwenCode.step1")}
					<br />
					{t("settings:providers.qwenCode.step2")}
					<br />
					{t("settings:providers.qwenCode.step3")}
				</div>

				<VSCodeLink
					href="https://github.com/QwenLM/qwen-code/blob/main/README.md"
					className="text-vscode-textLink-foreground mt-2 inline-block text-xs">
					{t("settings:providers.qwenCode.setupInstructions")}
				</VSCodeLink>
			</div>
		</div>
	)
}
