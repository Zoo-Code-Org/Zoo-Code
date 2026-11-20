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
		fireEvent.click(screen.getByRole("button", { name: "chat:todo.edit" }))
		fireEvent.click(screen.getByTitle("chat:todo.remove"))

		expect(screen.getByRole("alertdialog")).toBeInTheDocument()
		expect(screen.getByText("chat:todo.deleteDialog.description")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "chat:todo.cancel" }))

		await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
		expect(onChange).not.toHaveBeenCalled()
	})

	it("deletes the selected todo after confirmation", async () => {
		renderEditableList()
		fireEvent.click(screen.getByRole("button", { name: "chat:todo.edit" }))
		fireEvent.click(screen.getByTitle("chat:todo.remove"))
		fireEvent.click(screen.getByRole("button", { name: "chat:todo.deleteDialog.confirm" }))

		await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
		expect(onChange).toHaveBeenCalledWith([])
	})

	test("renders theme-aware edit controls", () => {
		renderEditableList()
		fireEvent.click(screen.getByRole("button", { name: "chat:todo.edit" }))

		expect(screen.getByTitle("chat:todo.remove")).toBeInTheDocument()
		expect(screen.getByDisplayValue("Ship the follow-up")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "chat:todo.addTodo" }))
		expect(screen.getByPlaceholderText("chat:todo.newItemPlaceholder")).toBeInTheDocument()
	})
})
