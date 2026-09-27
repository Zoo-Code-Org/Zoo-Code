import { FormEvent } from "react"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { vscode } from "@src/utils/vscode"

interface McpEnabledToggleProps {
	mcpEnabled?: boolean
	setMcpEnabled?: (value: boolean) => void
}

const McpEnabledToggle = ({
	mcpEnabled: propsMcpEnabled,
	setMcpEnabled: propsSetMcpEnabled,
}: McpEnabledToggleProps = {}) => {
	const { mcpEnabled: contextMcpEnabled, setMcpEnabled: contextSetMcpEnabled } = useExtensionState()
	const { t } = useAppTranslation()

	// When rendered inside SettingsView the value is buffered in `cachedState` and
	// only persisted on Save. Fall back to live extension state when used uncontrolled.
	const mcpEnabled = propsMcpEnabled ?? contextMcpEnabled

	const handleChange = (e: Event | FormEvent<HTMLElement>) => {
		const target = ("target" in e ? e.target : null) as HTMLInputElement | null

		if (!target) {
			return
		}

		if (propsSetMcpEnabled) {
			propsSetMcpEnabled(target.checked)
		} else {
			contextSetMcpEnabled(target.checked)
			vscode.postMessage({ type: "updateSettings", updatedSettings: { mcpEnabled: target.checked } })
		}
	}

	return (
		<div style={{ marginBottom: "20px" }}>
			<VSCodeCheckbox checked={mcpEnabled} onChange={handleChange}>
				<span style={{ fontWeight: "500" }}>{t("mcp:enableToggle.title")}</span>
			</VSCodeCheckbox>
			<p
				style={{
					fontSize: "12px",
					marginTop: "5px",
					color: "var(--vscode-descriptionForeground)",
				}}>
				{t("mcp:enableToggle.description")}
			</p>
		</div>
	)
}

export default McpEnabledToggle
