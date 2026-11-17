import { fireEvent, render, screen } from "@testing-library/react"

import { handlePickerNavigation } from "../pickerNavigation"
import { setupNativePickerFocus } from "../../__tests__/pickerTestFocus"

setupNativePickerFocus()

function setup({ disabled = false, prevented = false } = {}) {
	render(
		<div onKeyDown={handlePickerNavigation}>
			<input aria-label="Search" onKeyDown={prevented ? (event) => event.preventDefault() : undefined} />
			<button data-picker-result disabled={disabled}>
				First
			</button>
			<button data-picker-result disabled>
				Disabled
			</button>
			<button data-picker-result disabled={disabled}>
				Last
			</button>
			<button>Unrelated</button>
			<span data-testid="non-button" data-picker-result tabIndex={0} />
			<svg data-testid="svg" />
		</div>,
	)
	return {
		search: screen.getByRole("textbox"),
		first: screen.getByRole("button", { name: "First" }),
		last: screen.getByRole("button", { name: "Last" }),
	}
}

describe("handlePickerNavigation", () => {
	it.each([
		["ArrowDown", "first"],
		["ArrowUp", "last"],
	] as const)("moves from search with %s, skipping disabled results", (key, next) => {
		const elements = setup()
		elements.search.focus()
		expect(fireEvent.keyDown(elements.search, { key })).toBe(false)
		expect(elements[next]).toHaveFocus()
	})

	it.each([
		["first", "ArrowUp", "last"],
		["last", "ArrowDown", "first"],
		["first", "ArrowDown", "last"],
		["last", "ArrowUp", "first"],
		["first", "End", "last"],
		["last", "Home", "first"],
	] as const)("navigates %s with %s to %s", (start, key, next) => {
		const elements = setup()
		elements[start].focus()
		expect(fireEvent.keyDown(elements[start], { key })).toBe(false)
		expect(elements[next]).toHaveFocus()
	})

	it.each(["Home", "End", "Enter", "Tab", "ArrowLeft"])("leaves search %s native", (key) => {
		const { search } = setup()
		search.focus()
		expect(fireEvent.keyDown(search, { key })).toBe(true)
		expect(search).toHaveFocus()
	})

	it("respects a prevented navigation event", () => {
		const { search } = setup({ prevented: true })
		search.focus()
		expect(fireEvent.keyDown(search, { key: "ArrowDown" })).toBe(false)
		expect(search).toHaveFocus()
	})

	it.each(["svg", "non-button"])("ignores a non-HTMLElement or a result outside the button set: %s", (target) => {
		const { search } = setup({ disabled: true })
		search.focus()
		expect(fireEvent.keyDown(screen.getByTestId(target), { key: "ArrowDown" })).toBe(true)
		expect(search).toHaveFocus()
	})

	it("ignores keys from non-result controls", () => {
		setup()
		const unrelated = screen.getByRole("button", { name: "Unrelated" })
		unrelated.focus()
		expect(fireEvent.keyDown(unrelated, { key: "ArrowDown" })).toBe(true)
		expect(unrelated).toHaveFocus()
	})

	it("leaves search focused when no enabled results exist", () => {
		const { search } = setup({ disabled: true })
		search.focus()
		expect(fireEvent.keyDown(search, { key: "ArrowUp" })).toBe(true)
		expect(search).toHaveFocus()
	})
})
