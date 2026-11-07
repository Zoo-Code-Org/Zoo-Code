import { AppProviders } from "../../../../playwright/AppProviders"
import { UnsavedChangesDialog } from "../UnsavedChangesDialog"

/** The unsaved-changes dialog, open, with or without the note that a save that was not answered may still complete. */
export function UnsavedChangesDialogStory({ saveOutcomeUnknown = false }: { saveOutcomeUnknown?: boolean }) {
	return (
		<AppProviders>
			<UnsavedChangesDialog
				open
				onOpenChange={() => {}}
				saveOutcomeUnknown={saveOutcomeUnknown}
				onCancel={() => {}}
				onDiscard={() => {}}
			/>
		</AppProviders>
	)
}
