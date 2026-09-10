import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, test, vi } from "vitest"

import UpdateTodoListToolBlock from "../UpdateTodoListToolBlock"

describe("UpdateTodoListToolBlock", () => {
	const onChange = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
	})

	function renderEditableList() {
		return render(
			<UpdateTodoListToolBlock
				todos={[{ id: "todo-1", content: "Ship the follow-up", status: "in_progress" }]}
				onChange={onChange}
			/>,
		)
	}

	it("cancels deletion without changing the todo list", async () => {
		renderEditableList()
		fireEvent.click(screen.getByRole("button", { name: "Edit" }))
		fireEvent.click(screen.getByTitle("Remove"))

		expect(screen.getByRole("alertdialog")).toBeInTheDocument()
		expect(screen.getByText("Are you sure you want to delete this todo item?")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

		await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
		expect(onChange).not.toHaveBeenCalled()
	})

	it("deletes the selected todo after confirmation", async () => {
		renderEditableList()
		fireEvent.click(screen.getByRole("button", { name: "Edit" }))
		fireEvent.click(screen.getByTitle("Remove"))
		fireEvent.click(screen.getByRole("button", { name: "Delete" }))

		await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
		expect(onChange).toHaveBeenCalledWith([])
	})

	test("renders theme-aware edit controls", () => {
		renderEditableList()
		fireEvent.click(screen.getByRole("button", { name: "Edit" }))

		expect(screen.getByTitle("Remove")).toBeInTheDocument()
		expect(screen.getByDisplayValue("Ship the follow-up")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "+ Add Todo" }))
		expect(screen.getByPlaceholderText("Enter todo item, press Enter to add")).toBeInTheDocument()
	})
})
