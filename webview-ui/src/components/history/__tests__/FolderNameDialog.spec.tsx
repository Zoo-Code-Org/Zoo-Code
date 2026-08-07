import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"
import { FolderNameDialog } from "../FolderNameDialog"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

describe("FolderNameDialog", () => {
	it("renders dialog when open is true", () => {
		render(<FolderNameDialog open={true} onOpenChange={vi.fn()} onConfirm={vi.fn()} defaultName="Test Folder" />)

		expect(screen.getByRole("dialog")).toBeInTheDocument()
		expect(screen.getByRole("textbox")).toHaveValue("Test Folder")
	})

	it("shows validation error when attempting to confirm empty folder name", () => {
		const onConfirm = vi.fn()
		render(<FolderNameDialog open={true} onOpenChange={vi.fn()} onConfirm={onConfirm} defaultName="" />)

		fireEvent.click(screen.getByTestId("folder-name-confirm"))
		expect(screen.getByText("history:folderNameRequired")).toBeInTheDocument()
		expect(onConfirm).not.toHaveBeenCalled()
	})

	it("shows validation error when folder name exceeds max length", () => {
		const onConfirm = vi.fn()
		render(
			<FolderNameDialog open={true} onOpenChange={vi.fn()} onConfirm={onConfirm} defaultName={"a".repeat(81)} />,
		)

		fireEvent.click(screen.getByTestId("folder-name-confirm"))
		expect(screen.getByText("history:folderNameTooLong")).toBeInTheDocument()
		expect(onConfirm).not.toHaveBeenCalled()
	})

	it("shows validation error when folder name contains control characters", () => {
		const onConfirm = vi.fn()
		render(
			<FolderNameDialog open={true} onOpenChange={vi.fn()} onConfirm={onConfirm} defaultName={"Bad\nFolder"} />,
		)

		fireEvent.click(screen.getByTestId("folder-name-confirm"))
		expect(screen.getByText("history:folderNameInvalidChars")).toBeInTheDocument()
		expect(onConfirm).not.toHaveBeenCalled()
	})

	it("trims and normalizes valid folder name on confirm", () => {
		const onConfirm = vi.fn()
		const onOpenChange = vi.fn()
		render(
			<FolderNameDialog
				open={true}
				onOpenChange={onOpenChange}
				onConfirm={onConfirm}
				defaultName="   New Folder Name   "
			/>,
		)

		fireEvent.click(screen.getByTestId("folder-name-confirm"))
		expect(onConfirm).toHaveBeenCalledWith("New Folder Name")
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})

	it("submits on Enter key in input field", () => {
		const onConfirm = vi.fn()
		render(<FolderNameDialog open={true} onOpenChange={vi.fn()} onConfirm={onConfirm} defaultName="Valid Folder" />)

		const input = screen.getByRole("textbox")
		fireEvent.keyDown(input, { key: "Enter" })
		expect(onConfirm).toHaveBeenCalledWith("Valid Folder")
	})

	it("cancels on Escape key in input field or Cancel button click", () => {
		const onOpenChange = vi.fn()
		render(
			<FolderNameDialog open={true} onOpenChange={onOpenChange} onConfirm={vi.fn()} defaultName="Valid Folder" />,
		)

		const input = screen.getByRole("textbox")
		fireEvent.keyDown(input, { key: "Escape" })
		expect(onOpenChange).toHaveBeenCalledWith(false)

		fireEvent.click(screen.getByRole("button", { name: "history:cancel" }))
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})
})
