import { useDialog } from "@tui/ui/dialog"
import { DialogAlert } from "@tui/ui/dialog-alert"

interface DialogIndexingProps {
	useSDK: unknown
}

export function DialogIndexing(_props: DialogIndexingProps) {
	const dialog = useDialog()
	return (
		<DialogAlert
			title="Indexing unavailable"
			message="Codebase indexing is not bundled in Zoo Code CLI."
			onConfirm={() => dialog.clear()}
		/>
	)
}
