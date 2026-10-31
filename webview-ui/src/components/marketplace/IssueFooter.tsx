import React from "react"
import { Trans, useTranslation } from "react-i18next"
import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"

import { EXTERNAL_LINKS } from "@/constants/externalLinks"

export const IssueFooter: React.FC = () => {
	const { t } = useTranslation()
	return (
		<div className="text-xs text-vscode-descriptionForeground p-3">
			<Trans t={t} i18nKey="marketplace:footer.issueText">
				<VSCodeLink href={EXTERNAL_LINKS.MARKETPLACE_ISSUE} style={{ display: "inline", fontSize: "inherit" }}>
					Open a GitHub issue
				</VSCodeLink>
			</Trans>
		</div>
	)
}
