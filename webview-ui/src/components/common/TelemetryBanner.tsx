import { memo } from "react"
import { VSCodeButton, VSCodeLink } from "@vscode/webview-ui-toolkit/react"

import type { TelemetrySetting } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"
import { Trans, useTranslation } from "react-i18next"

const TelemetryBanner = () => {
	const { t } = useTranslation()

	const handleAccept = () => {
		vscode.postMessage({ type: "telemetrySetting", text: "enabled" satisfies TelemetrySetting })
	}

	const handleDecline = () => {
		vscode.postMessage({ type: "telemetrySetting", text: "disabled" satisfies TelemetrySetting })
	}

	const handleOpenSettings = () => {
		window.postMessage({
			type: "action",
			action: "settingsButtonClicked",
			values: { section: "about" },
		})
	}

	return (
		<div className="px-4 py-2.5 bg-vscode-banner-background border-b border-vscode-panel-border text-sm leading-normal text-vscode-foreground">
			<div className="mb-0.5 font-bold">{t("welcome:telemetry.helpImprove")}</div>
			<div className="mb-2">
				<Trans
					t={t}
					i18nKey="welcome:telemetry.helpImproveMessage"
					components={{
						settingsLink: <VSCodeLink href="#" onClick={handleOpenSettings} />,
					}}
				/>
			</div>
			<div className="flex gap-2">
				<VSCodeButton appearance="primary" onClick={handleAccept}>
					{t("welcome:telemetry.accept")}
				</VSCodeButton>
				<VSCodeButton appearance="secondary" onClick={handleDecline}>
					{t("welcome:telemetry.decline")}
				</VSCodeButton>
			</div>
		</div>
	)
}

export default memo(TelemetryBanner)
