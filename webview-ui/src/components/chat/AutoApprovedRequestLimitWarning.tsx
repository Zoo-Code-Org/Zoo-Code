import React, { memo, useState } from "react"
import { Trans, useTranslation } from "react-i18next"

import type { ClineMessage } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"
import { Button } from "@src/components/ui"

type AutoApprovedRequestLimitWarningProps = {
	message: ClineMessage
}

export const AutoApprovedRequestLimitWarning = memo(({ message }: AutoApprovedRequestLimitWarningProps) => {
	const { t } = useTranslation()
	const [buttonClicked, setButtonClicked] = useState(false)
	const { count, type = "requests" } = JSON.parse(message.text ?? "{}")

	if (buttonClicked) {
		return null
	}

	const isCostLimit = type === "cost"
	const titleKey = isCostLimit
		? "ask.autoApprovedCostLimitReached.title"
		: "ask.autoApprovedRequestLimitReached.title"
	const descriptionKey = isCostLimit
		? "ask.autoApprovedCostLimitReached.description"
		: "ask.autoApprovedRequestLimitReached.description"
	const buttonKey = isCostLimit
		? "ask.autoApprovedCostLimitReached.button"
		: "ask.autoApprovedRequestLimitReached.button"

	return (
		<>
			<div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--vscode-foreground)" }}>
				<span className="codicon codicon-warning" />
				<span style={{ fontWeight: "bold" }}>
					<Trans t={t} i18nKey={titleKey} ns="chat" />
				</span>
			</div>

			<div
				className="bg-vscode-panel-border flex flex-col gap-3"
				style={{
					borderRadius: "4px",
					display: "flex",
					marginTop: "15px",
					padding: "14px 16px 22px",
					justifyContent: "center",
				}}>
				<div className="flex justify-between items-center">
					<Trans t={t} i18nKey={descriptionKey} ns="chat" values={{ count }} />
				</div>
				<Button
					style={{ width: "100%", padding: "6px", borderRadius: "4px" }}
					onClick={(e) => {
						e.preventDefault()
						setButtonClicked(true)
						vscode.postMessage({ type: "askResponse", askResponse: "yesButtonClicked" })
					}}>
					<Trans t={t} i18nKey={buttonKey} ns="chat" />
				</Button>
			</div>
		</>
	)
})
