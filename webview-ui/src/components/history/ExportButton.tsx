import { vscode } from "@/utils/vscode"
import { Button, StandardTooltip } from "@/components/ui"
import { useTranslation } from "react-i18next"
import { useCallback } from "react"

export const ExportButton = ({ itemId }: { itemId: string }) => {
	const { t } = useTranslation()

	const handleExportClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation()
			vscode.postMessage({ type: "exportTaskWithId", text: itemId })
		},
		[itemId],
	)

	return (
		<StandardTooltip content={t("history:exportTask")}>
			<Button
				data-testid="export"
				variant="ghost"
				size="icon"
				className="group-hover:opacity-100 opacity-50 transition-opacity"
				onClick={handleExportClick}>
				<span className="codicon codicon-desktop-download scale-80" />
			</Button>
		</StandardTooltip>
	)
}
