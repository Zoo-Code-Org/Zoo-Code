import { render, screen, fireEvent } from "@/utils/test-utils"

import { RenameButton } from "../RenameButton"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

describe("RenameButton", () => {
	it("calls onRename without letting the click reach the task row", () => {
		const onRename = vi.fn()
		const onRowClick = vi.fn()
		render(
			<div onClick={onRowClick}>
				<RenameButton onRename={onRename} />
			</div>,
		)

		fireEvent.click(screen.getByRole("button", { name: "history:renameTask" }))

		expect(onRename).toHaveBeenCalledTimes(1)
		expect(onRowClick).not.toHaveBeenCalled()
	})
})
