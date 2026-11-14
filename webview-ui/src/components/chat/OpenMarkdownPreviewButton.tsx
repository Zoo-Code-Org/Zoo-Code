import React, { memo } from "react"
import { SquareArrowOutUpRight } from "lucide-react"

import { vscode } from "@src/utils/vscode"
import { hasComplexMarkdown } from "@src/utils/markdown"
import { StandardTooltip } from "@src/components/ui"
import { useAppTranslation } from "@src/i18n/TranslationContext"

interface OpenMarkdownPreviewButtonProps {
	markdown: string | undefined
	className?: string
}

export const OpenMarkdownPreviewButton = memo(({ markdown, className }: OpenMarkdownPreviewButtonProps) => {
	const { t } = useAppTranslation()

	if (!hasComplexMarkdown(markdown)) {
		return null
	}

	const handleClick = (e: React.MouseEvent) => {
		e.stopPropagation()
		if (markdown) {
			vscode.postMessage({
				type: "openMarkdownPreview",
				text: markdown,
			})
		}
	}

	return (
		<StandardTooltip content={t("chat:openInPreview")}>
			<button
				onClick={handleClick}
				className={`opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer ${className ?? ""}`}
				aria-label={t("chat:openInPreview")}>
				<SquareArrowOutUpRight className="w-4 h-4" />
			</button>
		</StandardTooltip>
	)
})
