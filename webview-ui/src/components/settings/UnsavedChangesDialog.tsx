import { TriangleAlert } from "lucide-react"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@src/components/ui"

interface UnsavedChangesDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	/** A save was not answered in time: the user is told that it may still complete after they leave. */
	saveOutcomeUnknown: boolean
	onCancel: () => void
	onDiscard: () => void
}

/** The question asked before the settings are left with edits that were not saved. */
export const UnsavedChangesDialog = ({
	open,
	onOpenChange,
	saveOutcomeUnknown,
	onCancel,
	onDiscard,
}: UnsavedChangesDialogProps) => {
	const { t } = useAppTranslation()

	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						<TriangleAlert className="w-5 h-5 text-yellow-500" />
						{t("settings:unsavedChangesDialog.title")}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{t("settings:unsavedChangesDialog.description")}
						{saveOutcomeUnknown && (
							<span className="block mt-2" data-testid="save-outcome-unknown">
								{t("settings:unsavedChangesDialog.saveMayComplete")}
							</span>
						)}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel onClick={onCancel}>
						{t("settings:unsavedChangesDialog.cancelButton")}
					</AlertDialogCancel>
					<AlertDialogAction onClick={onDiscard}>
						{t("settings:unsavedChangesDialog.discardButton")}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
