import React, { useEffect } from "react"

// NOTE: type-only import. A runtime import of `@roo-code/types` pulls zod into
// the Playwright CT browser bundle and crashes mount with `z is not defined`.
import type { TerminalShellOptionsPayload, TerminalShellSelection } from "@roo-code/types"

import { TranslationContext } from "@src/i18n/TranslationContext"
import { TerminalSettings } from "../TerminalSettings"

const translations: Record<string, string> = {
	"settings:sections.terminal": "Terminal",
	"settings:terminal.basic.label": "Basic",
	"settings:terminal.advanced.label": "Advanced",
	"settings:terminal.advanced.description": "Advanced terminal behavior settings.",
	"settings:terminal.outputPreviewSize.label": "Output preview size",
	"settings:terminal.outputPreviewSize.description": "Controls how much terminal output is shown.",
	"settings:terminal.outputPreviewSize.options.small": "Small",
	"settings:terminal.outputPreviewSize.options.medium": "Medium",
	"settings:terminal.outputPreviewSize.options.large": "Large",
	"settings:terminal.shellIntegrationDisabled.label": "Use Inline Terminal",
	"settings:terminal.shellIntegrationDisabled.description": "Run commands in the inline terminal.",
	"settings:terminal.inlineShell.label": "Inline terminal shell",
	"settings:terminal.inlineShell.auto": "Auto (recommended)",
	"settings:terminal.inlineShell.customPath": "Select custom executable...",
	"settings:terminal.inlineShell.description": "Choose which shell the inline terminal uses.",
	"settings:terminal.inlineShell.effectiveShell.label": "Effective shell",
	"settings:terminal.inlineShell.effectiveShell.family": "Family",
	"settings:terminal.inlineShell.effectiveShell.source": "Source",
	"settings:terminal.inlineShell.effectiveShell.fallbackDescription":
		"If the selected shell is unavailable, the default shell is used.",
	"settings:terminal.inlineShell.error.invalid": "The selected shell is invalid or unavailable.",
	"settings:common.select": "Select",
}

export const shellOptionsPayload: TerminalShellOptionsPayload = {
	options: [
		{ id: "auto", label: "Auto", family: "posix", source: "os-default", available: true },
		{
			id: "profile:PowerShell",
			label: "PowerShell",
			family: "powershell",
			source: "vscode-default",
			available: true,
		},
		{ id: "cmd", label: "Command Prompt", family: "cmd", source: "os-default", available: true },
		{ id: "path:/bin/zsh", label: "zsh", family: "posix", source: "os-default", available: true },
	],
	effectiveShell: {
		label: "zsh",
		family: "posix",
		source: "os-default",
	},
}

/**
 * Dispatches the `terminalShellOptions` extension-host message after mount so
 * TerminalSettings populates its shell dropdown and effective-shell summary,
 * exactly as it does in the real webview.
 */
function useDispatchShellOptions(payload: TerminalShellOptionsPayload) {
	useEffect(() => {
		const timer = setTimeout(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "terminalShellOptions", terminalShellOptions: payload },
				}),
			)
		}, 0)
		return () => clearTimeout(timer)
	}, [payload])
}

type FixtureProps = {
	terminalShellSelection?: TerminalShellSelection
	withEffectiveShell?: boolean
}

export const TerminalSettingsFixture = ({ terminalShellSelection, withEffectiveShell = true }: FixtureProps) => {
	const payload = withEffectiveShell ? shellOptionsPayload : { ...shellOptionsPayload, effectiveShell: undefined }
	useDispatchShellOptions(payload)

	return (
		<TranslationContext.Provider
			value={{
				t: (key) => translations[key] ?? key,
				i18n: null as unknown as typeof import("../../../i18n/setup").default,
			}}>
			<div className="w-[480px] bg-vscode-editor-background p-4 text-vscode-foreground">
				<TerminalSettings
					terminalShellIntegrationDisabled={true}
					terminalShellSelection={terminalShellSelection}
					setCachedStateField={() => undefined}
				/>
			</div>
		</TranslationContext.Provider>
	)
}
