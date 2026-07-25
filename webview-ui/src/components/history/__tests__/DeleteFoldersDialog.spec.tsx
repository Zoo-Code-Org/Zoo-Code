import { render, screen, fireEvent } from "@/utils/test-utils"
import { DeleteFoldersDialog } from "../DeleteFoldersDialog"

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

describe("DeleteFoldersDialog", () => {
	it("renders the confirmation copy with the folder count", () => {
		render(<DeleteFoldersDialog folderCount={3} open onOpenChange={() => {}} onConfirm={() => {}} />)

		expect(screen.getByText("history:deleteFoldersTitle")).toBeInTheDocument()
		expect(screen.getByText("history:confirmDeleteFolders")).toBeInTheDocument()
		expect(screen.getByText("history:deleteFoldersTasksPreserved")).toBeInTheDocument()
	})

	it("invokes onConfirm and closes when the destructive action is clicked", () => {
		const onConfirm = vi.fn()
		const onOpenChange = vi.fn()
		render(<DeleteFoldersDialog folderCount={2} open onOpenChange={onOpenChange} onConfirm={onConfirm} />)

		fireEvent.click(screen.getByTestId("confirm-delete-folders"))

		expect(onConfirm).toHaveBeenCalledTimes(1)
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})

	it("does not invoke onConfirm when cancel is clicked", () => {
		const onConfirm = vi.fn()
		render(<DeleteFoldersDialog folderCount={1} open onOpenChange={() => {}} onConfirm={onConfirm} />)

		fireEvent.click(screen.getByText("history:cancel"))
		expect(onConfirm).not.toHaveBeenCalled()
	})
})
