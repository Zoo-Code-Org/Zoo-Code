import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"

import UpdateTodoListToolBlock from "../UpdateTodoListToolBlock"

describe("UpdateTodoListToolBlock", () => {
	test("renders theme-aware edit controls", () => {
		render(
			<UpdateTodoListToolBlock
				todos={[{ id: "todo-1", content: "Ship the cleanup", status: "in_progress" }]}
				onChange={vi.fn()}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: "Edit" }))
		expect(screen.getByTitle("Remove")).toBeInTheDocument()
		expect(screen.getByDisplayValue("Ship the cleanup")).toBeInTheDocument()

		fireEvent.click(screen.getByRole("button", { name: "+ Add Todo" }))
		expect(screen.getByPlaceholderText("Enter todo item, press Enter to add")).toBeInTheDocument()
	})

	test("cancels and confirms todo deletion", () => {
		const onChange = vi.fn()
		render(
			<UpdateTodoListToolBlock
				todos={[{ id: "todo-1", content: "Ship the cleanup", status: "in_progress" }]}
				onChange={onChange}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: "Edit" }))
		fireEvent.click(screen.getByTitle("Remove"))
		expect(screen.getByRole("alertdialog")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
		expect(onChange).not.toHaveBeenCalled()

		fireEvent.click(screen.getByTitle("Remove"))
		fireEvent.click(screen.getByRole("button", { name: "Delete" }))
		expect(onChange).toHaveBeenCalledWith([])
	})
})
