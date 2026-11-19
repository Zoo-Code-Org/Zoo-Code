import { useState } from "react"
import { fireEvent, render, screen } from "@testing-library/react"

import { PickerSearchField } from "../PickerSearchField"

function SearchFixture() {
	const [value, setValue] = useState("")
	return <PickerSearchField label="Search models" value={value} onChange={setValue} />
}

describe("PickerSearchField", () => {
	it("uses shared spacing, placeholder and focus treatment", () => {
		render(<SearchFixture />)
		const input = screen.getByRole("textbox", { name: "Search models" })
		expect(input).toHaveAttribute("placeholder", "common:ui.search_placeholder")
		expect(input).toHaveClass("h-8")
		expect(input.parentElement).toHaveClass("focus-within:ring-1")
		expect(input.parentElement?.parentElement).toHaveClass("px-3", "py-2", "border-b")
	})

	it("clears the query and returns focus to the input", () => {
		render(<SearchFixture />)
		const input = screen.getByRole("textbox")
		// The shared test setup replaces native focus with a no-op for FAST compatibility.
		const focus = vi.fn()
		input.focus = focus
		expect(screen.queryByRole("button", { name: "chat:modelPicker.clearSearch" })).not.toBeInTheDocument()
		fireEvent.change(input, { target: { value: "query" } })
		fireEvent.click(screen.getByRole("button", { name: "chat:modelPicker.clearSearch" }))
		expect(input).toHaveValue("")
		expect(focus).toHaveBeenCalled()
	})

	it("disables both the input and clear button", () => {
		const onChange = vi.fn()
		render(<PickerSearchField label="Search profiles" value="query" onChange={onChange} disabled />)
		expect(screen.getByRole("textbox")).toBeDisabled()
		expect(screen.getByRole("button", { name: "chat:modelPicker.clearSearch" })).toBeDisabled()
		fireEvent.click(screen.getByRole("button", { name: "chat:modelPicker.clearSearch" }))
		expect(onChange).not.toHaveBeenCalled()
	})
})
