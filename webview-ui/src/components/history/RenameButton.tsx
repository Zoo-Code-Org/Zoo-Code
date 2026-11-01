import { Button, StandardTooltip } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"

type RenameButtonProps = {
	onRename: () => void
}

export const RenameButton = ({ onRename }: RenameButtonProps) => {
	const { t } = useAppTranslation()
	const label = t("history:renameTask")

	return (
		<StandardTooltip content={label}>
			<Button
				data-testid="rename-task-button"
				aria-label={label}
				variant="ghost"
				size="icon"
				className="group-hover:opacity-100 opacity-50 transition-opacity"
				onClick={(e) => {
					e.stopPropagation()
					onRename()
				}}>
				<span className="codicon codicon-edit scale-80" />
			</Button>
		</StandardTooltip>
	)
}
