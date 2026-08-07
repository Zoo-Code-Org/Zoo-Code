import { render, screen, fireEvent } from "@/utils/test-utils"
import { FolderNameDialog } from "../FolderNameDialog"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) => {
			if (!params) return key
			return Object.entries(params).reduce(
				(acc, [k, v]) => acc.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v)),
				key,
			)
		},
	}),
}))

describe("FolderNameDialog validation", () => {
	it("rejects an empty (whitespace-only) name", () => {
		const onConfirm = vi.fn()
		render(<FolderNameDialog open onOpenChange={() => {}} onConfirm={onConfirm} />)

		const input = screen.getByTestId("folder-name-input")
		fireEvent.change(input, { target: { value: "   " } })
		fireEvent.click(screen.getByTestId("folder-name-confirm"))

		expect(screen.getByTestId("folder-name-error")).toHaveTextContent("history:folderNameRequired")
		expect(onConfirm).not.toHaveBeenCalled()
	})

	it("rejects a name longer than the max length", () => {
		const onConfirm = vi.fn()
		render(<FolderNameDialog open onOpenChange={() => {}} onConfirm={onConfirm} />)

		const input = screen.getByTestId("folder-name-input")
		fireEvent.change(input, { target: { value: "x".repeat(81) } })
		fireEvent.click(screen.getByTestId("folder-name-confirm"))

		expect(screen.getByTestId("folder-name-error")).toHaveTextContent("history:folderNameTooLong")
		expect(onConfirm).not.toHaveBeenCalled()
	})

	it("rejects a name containing control characters", () => {
		const onConfirm = vi.fn()
		render(<FolderNameDialog open onOpenChange={() => {}} onConfirm={onConfirm} />)

		const input = screen.getByTestId("folder-name-input")
		fireEvent.change(input, { target: { value: "BadName" } })
		fireEvent.click(screen.getByTestId("folder-name-confirm"))

		expect(screen.getByTestId("folder-name-error")).toHaveTextContent("history:folderNameInvalidChars")
		expect(onConfirm).not.toHaveBeenCalled()
	})

	it("confirms a valid name, normalizing and trimming it", () => {
		const onConfirm = vi.fn()
		const onOpenChange = vi.fn()
		render(<FolderNameDialog open onOpenChange={onOpenChange} onConfirm={onConfirm} />)

		const input = screen.getByTestId("folder-name-input")
		fireEvent.change(input, { target: { value: "  My Folder  " } })
		fireEvent.click(screen.getByTestId("folder-name-confirm"))

		expect(onConfirm).toHaveBeenCalledWith("My Folder")
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})

	it("clears the error when the user edits after an invalid confirm", () => {
		render(<FolderNameDialog open onOpenChange={() => {}} onConfirm={() => {}} />)

		const input = screen.getByTestId("folder-name-input")
		fireEvent.change(input, { target: { value: "" } })
		fireEvent.click(screen.getByTestId("folder-name-confirm"))
		expect(screen.getByTestId("folder-name-error")).toBeInTheDocument()

		fireEvent.change(input, { target: { value: "Now valid" } })
		expect(screen.queryByTestId("folder-name-error")).not.toBeInTheDocument()
	})
})
