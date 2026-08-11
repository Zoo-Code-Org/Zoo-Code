/* v8 ignore file -- Playwright component fixture is covered by the visual test. */
import React from "react"

import { TranslationContext } from "@/i18n/TranslationContext"
import i18next from "@/i18n/setup"
import { ExtensionStateContextProvider } from "@/context/ExtensionStateContext"
import { AutoApproveSettings } from "../AutoApproveSettings"

export const AutoApproveSettingsFixture = () => (
	<TranslationContext.Provider
		value={{
			t: (key) => (key === "settings:autoApprove.followupQuestions.timeoutDisabled" ? "Disabled" : key),
			i18n: i18next,
		}}>
		<ExtensionStateContextProvider
			initialState={{ autoApprovalEnabled: false, alwaysAllowFollowupQuestions: true }}>
			<div className="w-[680px] bg-vscode-editor-background p-4 text-vscode-foreground">
				<AutoApproveSettings
					alwaysAllowFollowupQuestions
					followupAutoApproveTimeoutMs={0}
					setCachedStateField={() => {}}
				/>
			</div>
		</ExtensionStateContextProvider>
	</TranslationContext.Provider>
)
