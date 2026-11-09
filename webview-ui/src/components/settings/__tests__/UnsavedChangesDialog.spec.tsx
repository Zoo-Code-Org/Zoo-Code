import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { UnsavedChangesDialog } from "../UnsavedChangesDialog"

const renderDialog = (saveOutcomeUnknown: boolean) =>
	render(
		<UnsavedChangesDialog
			open
			onOpenChange={vi.fn()}
			saveOutcomeUnknown={saveOutcomeUnknown}
			onCancel={vi.fn()}
			onDiscard={vi.fn()}
		/>,
	)

describe("UnsavedChangesDialog – the note about an unanswered save", () => {
	it("shows the note, with its own translation, when the outcome of a save is unknown", () => {
		renderDialog(true)

		const note = screen.getByTestId("save-outcome-unknown")
		expect(note).toHaveTextContent("settings:unsavedChangesDialog.saveMayComplete")
		// The note is part of the description of the dialog.
		expect(screen.getByRole("alertdialog")).toContainElement(note)
	})

	it("shows no note otherwise, only the question", () => {
		renderDialog(false)

		expect(screen.queryByTestId("save-outcome-unknown")).toBeNull()
		expect(screen.getByText("settings:unsavedChangesDialog.description")).toBeInTheDocument()
	})
})
