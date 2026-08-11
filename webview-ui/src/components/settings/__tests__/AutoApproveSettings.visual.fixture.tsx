/* v8 ignore file -- Playwright component fixture is covered by the visual test. */
import React from "react"

import { TranslationContext } from "@/i18n/TranslationContext"
import { ExtensionStateContext } from "@/context/ExtensionStateContext"
import { AutoApproveSettings } from "../AutoApproveSettings"

const extensionStateValue = {
	autoApprovalEnabled: false,
	setAutoApprovalEnabled: () => {},
	alwaysAllowReadOnly: false,
	alwaysAllowWrite: false,
	alwaysAllowExecute: false,
	alwaysAllowMcp: false,
	alwaysAllowModeSwitch: false,
	alwaysAllowSubtasks: false,
	alwaysAllowFollowupQuestions: true,
} as any

export const AutoApproveSettingsFixture = () => (
	<TranslationContext.Provider
		value={{
			t: (key) => key,
			i18n: null as unknown as typeof import("../../../i18n/setup").default,
		}}>
		<ExtensionStateContext.Provider value={extensionStateValue}>
			<div className="w-[680px] bg-vscode-editor-background p-4 text-vscode-foreground">
				<AutoApproveSettings
					alwaysAllowFollowupQuestions
					followupAutoApproveTimeoutMs={0}
					setCachedStateField={() => {}}
				/>
			</div>
		</ExtensionStateContext.Provider>
	</TranslationContext.Provider>
)
