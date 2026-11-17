import { useState } from "react"

import type { ExtensionStateContextType } from "@/context/ExtensionStateContext"
import type { DateFormat, TimeFormat } from "@/utils/format"
import { AppProviders } from "../../../../playwright/AppProviders"
import type { SetCachedStateField } from "../types"
import { LanguageSettings } from "../LanguageSettings"

/** The Language tab with a 24-hour clock, a year-first date, and absolute times in history. */
export function LanguageSettingsStory() {
	const [state, setState] = useState<{
		language: string
		timeFormat: TimeFormat
		dateFormat: DateFormat
		showRelativeTimes: boolean
	}>({ language: "en", timeFormat: "24h", dateFormat: "ymd", showRelativeTimes: false })

	const setCachedStateField: SetCachedStateField<keyof ExtensionStateContextType> = (field, value) =>
		setState((current) => ({ ...current, [field]: value }))

	return (
		<AppProviders>
			<div
				data-testid="language-settings-story"
				className="w-[488px] max-w-full rounded-lg border border-vscode-panel-border bg-vscode-editor-background p-4 text-vscode-editor-foreground">
				<LanguageSettings {...state} setCachedStateField={setCachedStateField} />
			</div>
		</AppProviders>
	)
}
