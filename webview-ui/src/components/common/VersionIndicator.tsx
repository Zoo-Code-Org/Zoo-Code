import React from "react"
import { useTranslation } from "react-i18next"
import { Package } from "@roo/package"

interface VersionIndicatorProps {
	className?: string
}

const VersionIndicator: React.FC<VersionIndicatorProps> = ({ className = "" }) => {
	const { t } = useTranslation()

	return (
		<span
			className={`text-xs text-vscode-descriptionForeground rounded-full px-2 py-1 border ${className}`}
			aria-label={t("chat:versionIndicator.ariaLabel", { version: Package.version })}>
			v{Package.version}
		</span>
	)
}

export default VersionIndicator
