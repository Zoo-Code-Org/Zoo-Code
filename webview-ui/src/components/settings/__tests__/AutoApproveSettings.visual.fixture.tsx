/* v8 ignore file -- Playwright component fixture is covered by the visual test. */
import React from "react"
import { createInstance } from "i18next"

import { TranslationContext } from "@/i18n/TranslationContext"
import { ExtensionStateContextProvider } from "@/context/ExtensionStateContext"
import { AutoApproveSettings } from "../AutoApproveSettings"

const i18n = createInstance()

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
			t: (key) => (key === "settings:autoApprove.followupQuestions.timeoutDisabled" ? "Disabled" : key),
			i18n,
		}}>
		<ExtensionStateContextProvider
			initialState={{
				autoApprovalEnabled: false,
				alwaysAllowFollowupQuestions: alwaysAllowFollowupQuestions ?? false,
			}}>
			<div className="w-[680px] bg-vscode-editor-background p-4 text-vscode-foreground">
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
