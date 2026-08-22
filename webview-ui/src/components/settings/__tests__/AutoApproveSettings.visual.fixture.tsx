/* v8 ignore file -- Playwright component fixture is covered by the visual test. */
import React from "react"
import { createInstance } from "i18next"

import { TranslationContext } from "@/i18n/TranslationContext"
import { ExtensionStateContextProvider } from "@/context/ExtensionStateContext"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AutoApproveSettings } from "../AutoApproveSettings"

import enSettings from "@/i18n/locales/en/settings.json"
import enCommon from "@/i18n/locales/en/common.json"

const i18n = createInstance()

i18n.init({
	lng: "en",
	fallbackLng: "en",
	resources: {
		en: {
			settings: enSettings,
			common: enCommon,
		},
	},
	interpolation: { escapeValue: false },
	initImmediate: false,
})

type AutoApproveFixtureProps = {
	alwaysAllowReadOnly?: boolean
	alwaysAllowWrite?: boolean
	alwaysAllowExecute?: boolean
	alwaysAllowFollowupQuestions?: boolean
	followupAutoApproveTimeoutMs?: number
	allowedCommands?: string[]
	deniedCommands?: string[]
	destructiveCommandGuardEnabled?: boolean
}

const AutoApproveSettingsFixture = ({
	alwaysAllowReadOnly,
	alwaysAllowWrite,
	alwaysAllowExecute,
	alwaysAllowFollowupQuestions,
	followupAutoApproveTimeoutMs,
	allowedCommands,
	deniedCommands,
	destructiveCommandGuardEnabled,
}: AutoApproveFixtureProps) => (
	<TranslationContext.Provider
		value={{
			t: (key, options?) => i18n.t(key, options),
			i18n,
		}}>
		<ExtensionStateContextProvider
			initialState={{
				autoApprovalEnabled: false,
				alwaysAllowFollowupQuestions: alwaysAllowFollowupQuestions ?? false,
			}}>
			<TooltipProvider>
				<div
					data-testid="auto-approve-settings-visual"
					className="w-[680px] bg-vscode-editor-background p-4 text-vscode-foreground">
					<AutoApproveSettings
						alwaysAllowReadOnly={alwaysAllowReadOnly}
						alwaysAllowWrite={alwaysAllowWrite}
						alwaysAllowExecute={alwaysAllowExecute}
						alwaysAllowFollowupQuestions={alwaysAllowFollowupQuestions}
						followupAutoApproveTimeoutMs={followupAutoApproveTimeoutMs}
						allowedCommands={allowedCommands}
						deniedCommands={deniedCommands}
						destructiveCommandGuardEnabled={destructiveCommandGuardEnabled}
						setCachedStateField={() => {}}
					/>
				</div>
			</TooltipProvider>
		</ExtensionStateContextProvider>
	</TranslationContext.Provider>
)

export const AutoApproveSettingsManualSnapshot1Fixture = () => (
	<AutoApproveSettingsFixture
		alwaysAllowReadOnly
		alwaysAllowWrite
		alwaysAllowExecute
		alwaysAllowFollowupQuestions
		followupAutoApproveTimeoutMs={30000}
		allowedCommands={["npm test"]}
		deniedCommands={["rm -rf"]}
	/>
)

export const AutoApproveSettingsManualSnapshot2Fixture = () => (
	<AutoApproveSettingsFixture
		alwaysAllowExecute
		destructiveCommandGuardEnabled
		alwaysAllowFollowupQuestions
		followupAutoApproveTimeoutMs={45000}
	/>
)

export const AutoApproveSettingsManualSnapshot3Fixture = () => (
	<AutoApproveSettingsFixture alwaysAllowFollowupQuestions followupAutoApproveTimeoutMs={0} />
)
