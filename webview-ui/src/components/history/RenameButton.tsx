import { useCallback } from "react"

import { Button, StandardTooltip } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"

type RenameButtonProps = {
	onRename: () => void
}

export const RenameButton = ({ onRename }: RenameButtonProps) => {
	const { t } = useAppTranslation()

	const handleRenameClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation()
			onRename()
		},
		[onRename],
	)

	return (
		<StandardTooltip content={t("history:renameTask")}>
			<Button
				data-testid="rename-task-button"
				variant="ghost"
				size="icon"
				className="group-hover:opacity-100 opacity-50 transition-opacity"
				onClick={handleRenameClick}>
				<span className="codicon codicon-edit scale-80" />
			</Button>
		</StandardTooltip>
	)
}
