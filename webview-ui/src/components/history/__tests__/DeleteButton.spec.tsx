import { render, screen, fireEvent } from "@/utils/test-utils"

import { DeleteButton } from "../DeleteButton"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key,
	}),
}))

describe("DeleteButton", () => {
	it("calls onDelete when clicked", () => {
		const onDelete = vi.fn()
		render(<DeleteButton itemId="test-id" onDelete={onDelete} />)

		const deleteButton = screen.getByRole("button")
		fireEvent.click(deleteButton)

		expect(onDelete).toHaveBeenCalledWith("test-id")
	})
})
