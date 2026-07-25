import { useCallback } from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	Button,
} from "@/components/ui"
import { AlertDialogProps } from "@radix-ui/react-alert-dialog"

interface DeleteFoldersDialogProps extends AlertDialogProps {
	/** Number of folders that will be deleted. */
	folderCount: number
	/** Callback invoked when the user confirms deletion. */
	onConfirm: () => void
}

/**
 * Destructive confirmation for deleting one or more manual folders.
 * Tasks contained in the folders are preserved and returned to the
 * unfiled list; only the folder grouping (and matching pins) is removed.
 */
export const DeleteFoldersDialog = ({ folderCount, onConfirm, ...props }: DeleteFoldersDialogProps) => {
	const { t } = useAppTranslation()
	const { onOpenChange } = props

	const handleConfirm = useCallback(() => {
		onConfirm()
		onOpenChange?.(false)
	}, [onConfirm, onOpenChange])

	return (
		<AlertDialog {...props}>
			<AlertDialogContent className="max-w-md">
				<AlertDialogHeader>
					<AlertDialogTitle>{t("history:deleteFoldersTitle", { count: folderCount })}</AlertDialogTitle>
					<AlertDialogDescription className="text-vscode-foreground">
						<div className="mb-2">{t("history:confirmDeleteFolders", { count: folderCount })}</div>
						<div className="text-vscode-editor-foreground bg-vscode-editor-background p-2 rounded text-sm">
							{t("history:deleteFoldersTasksPreserved")}
						</div>
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="secondary">{t("history:cancel")}</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button variant="destructive" onClick={handleConfirm} data-testid="confirm-delete-folders">
							<span className="codicon codicon-trash mr-1"></span>
							{t("history:deleteFoldersConfirm", { count: folderCount })}
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
