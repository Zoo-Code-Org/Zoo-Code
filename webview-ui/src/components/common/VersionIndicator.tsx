import React from "react"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Package } from "@roo/package"

interface VersionIndicatorProps {
	onClick: () => void
	className?: string
}

const VersionIndicator: React.FC<VersionIndicatorProps> = ({ onClick, className = "" }) => {
	const { t } = useAppTranslation()

	return (
		<button
			onClick={onClick}
			className={`text-xs text-vscode-descriptionForeground rounded-full hover:text-vscode-foreground transition-colors cursor-pointer px-2 py-1 border ${className}`}
			aria-label={t("chat:versionIndicator.ariaLabel", { version: Package.version })}>
			v{Package.version}
		</button>
	)
}

export default VersionIndicator
