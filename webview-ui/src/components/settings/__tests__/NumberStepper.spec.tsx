import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { APPEARANCE_SETTINGS } from "@/utils/appearance"

import { NumberStepper } from "../NumberStepper"

const setting = APPEARANCE_SETTINGS.terminalFontSize // 8–32 px, step 1, fallback 12

const setup = (props: Partial<React.ComponentProps<typeof NumberStepper>> = {}) => {
	const onChange = vi.fn()
	render(
		<NumberStepper
			label="Terminal font size"
			description="desc"
			resetLabel="Reset"
			setting={setting}
			onChange={onChange}
			testId="t"
			{...props}
		/>,
	)
	return { onChange, input: screen.getByTestId("t-input") as HTMLInputElement }
}

describe("NumberStepper", () => {
	it("shows the fallback when unset and hides reset", () => {
		const { input } = setup()
		expect(input.value).toBe("12")
		expect(screen.getByTestId("t-reset").className).toContain("invisible")
	})

	it("shows the stored value and an active reset", () => {
		const { input } = setup({ value: 16 })
		expect(input.value).toBe("16")
		expect(screen.getByTestId("t-reset").className).not.toContain("invisible")
	})

	it("increments and decrements by the step", () => {
		const { onChange } = setup({ value: 16 })
		fireEvent.click(screen.getByTestId("t-increment"))
		expect(onChange).toHaveBeenLastCalledWith(17)
		fireEvent.click(screen.getByTestId("t-decrement"))
		expect(onChange).toHaveBeenLastCalledWith(15)
	})

	it("keeps an explicit value that equals the displayed default: only Reset clears an override", () => {
		const { onChange } = setup({ value: 13 })
		fireEvent.click(screen.getByTestId("t-decrement")) // 12 == the shown fallback, but the user chose it
		expect(onChange).toHaveBeenLastCalledWith(12)
		expect(onChange).not.toHaveBeenCalledWith(undefined)
	})

	it("stores a typed value that equals the displayed default as that number", () => {
		const { onChange, input } = setup()
		// As typed over the shown 12: the box goes through "1" on the way to "12".
		fireEvent.change(input, { target: { value: "1" } })
		fireEvent.change(input, { target: { value: "12" } })
		fireEvent.blur(input)
		expect(onChange).toHaveBeenCalledTimes(1)
		expect(onChange).toHaveBeenLastCalledWith(12)
	})

	it("disables the buttons at the limits", () => {
		setup({ value: setting.max })
		expect((screen.getByTestId("t-increment") as HTMLButtonElement).disabled).toBe(true)
		expect((screen.getByTestId("t-decrement") as HTMLButtonElement).disabled).toBe(false)
	})

	it("disables decrement at the minimum", () => {
		setup({ value: setting.min })
		expect((screen.getByTestId("t-decrement") as HTMLButtonElement).disabled).toBe(true)
	})

	it("does not commit while typing, then commits clamped on blur", () => {
		const { onChange, input } = setup({ value: 16 })
		fireEvent.change(input, { target: { value: "999" } })
		expect(onChange).not.toHaveBeenCalled()
		fireEvent.blur(input)
		expect(onChange).toHaveBeenCalledWith(setting.max)
		expect(input.value).toBe(String(setting.max))
	})

	it("commits on Enter and strips non-digits", () => {
		const { onChange, input } = setup({ value: 16 })
		fireEvent.change(input, { target: { value: "2a0" } })
		expect(input.value).toBe("20")
		fireEvent.keyDown(input, { key: "Enter" })
		expect(onChange).toHaveBeenCalledWith(20)
	})

	it("supports arrow keys", () => {
		const { onChange, input } = setup({ value: 16 })
		fireEvent.keyDown(input, { key: "ArrowUp" })
		expect(onChange).toHaveBeenLastCalledWith(17)
		fireEvent.keyDown(input, { key: "ArrowDown" })
		expect(onChange).toHaveBeenLastCalledWith(15)
	})

	describe("arrow keys", () => {
		it("step from the stored value when nothing was typed", () => {
			const { onChange, input } = setup({ value: 16 })
			fireEvent.keyDown(input, { key: "ArrowUp" })
			expect(onChange).toHaveBeenLastCalledWith(17)
			fireEvent.keyDown(input, { key: "ArrowDown" })
			expect(onChange).toHaveBeenLastCalledWith(15)
		})

		it("step from the number typed in the box, not the stored value", () => {
			const { onChange, input } = setup({ value: 16 })
			fireEvent.change(input, { target: { value: "20" } })
			fireEvent.keyDown(input, { key: "ArrowUp" })
			expect(onChange).toHaveBeenLastCalledWith(21)
		})

		it("step down from the typed number", () => {
			const { onChange, input } = setup({ value: 16 })
			fireEvent.change(input, { target: { value: "20" } })
			fireEvent.keyDown(input, { key: "ArrowDown" })
			expect(onChange).toHaveBeenLastCalledWith(19)
		})

		it("step from the stored value when the box was emptied", () => {
			const { onChange, input } = setup({ value: 16 })
			fireEvent.change(input, { target: { value: "" } })
			fireEvent.keyDown(input, { key: "ArrowUp" })
			expect(onChange).toHaveBeenLastCalledWith(17)
		})
	})

	describe("accessibility", () => {
		it("announces the unit and the description with the value", () => {
			const { input } = setup({ description: "Size of the terminal text" })

			const described = (input.getAttribute("aria-describedby") ?? "").split(" ")
			const texts = described.map((id) => document.getElementById(id)?.textContent)

			expect(texts).toEqual([setting.unit, "Size of the terminal text"])
		})
	})

	describe("leaving the box without typing", () => {
		it("stores nothing when the setting is unset and the box is only focused and left", () => {
			const { onChange, input } = setup() // unset: shows the fallback, 12
			fireEvent.focus(input)
			fireEvent.blur(input)
			expect(onChange).not.toHaveBeenCalled()
			expect(input.value).toBe("12")
		})

		it("stores nothing when Enter is pressed in an untouched box", () => {
			const { onChange, input } = setup()
			fireEvent.keyDown(input, { key: "Enter" })
			expect(onChange).not.toHaveBeenCalled()
		})

		it("stores nothing when a set value is only focused and left", () => {
			const { onChange, input } = setup({ value: 16 })
			fireEvent.focus(input)
			fireEvent.blur(input)
			expect(onChange).not.toHaveBeenCalled()
		})

		it("still stores what the user typed, even when it equals the shown fallback", () => {
			const { onChange, input } = setup()
			fireEvent.change(input, { target: { value: "1" } })
			fireEvent.change(input, { target: { value: "12" } })
			fireEvent.blur(input)
			expect(onChange).toHaveBeenCalledWith(12)
		})

		it("treats a second blur after a commit as untouched", () => {
			const { onChange, input } = setup({ value: 16 })
			fireEvent.change(input, { target: { value: "20" } })
			fireEvent.blur(input)
			fireEvent.blur(input)
			expect(onChange).toHaveBeenCalledTimes(1)
		})
	})

	it("reverts an empty entry to the current value", () => {
		const { onChange, input } = setup({ value: 16 })
		fireEvent.change(input, { target: { value: "" } })
		fireEvent.blur(input)
		expect(input.value).toBe("16")
		expect(onChange).not.toHaveBeenCalled()
	})

	it("clamps a typed zero up to the minimum (a real 0, unlike an emptied box)", () => {
		const { onChange, input } = setup({ value: 16 })
		fireEvent.change(input, { target: { value: "0" } })
		fireEvent.blur(input)
		expect(onChange).toHaveBeenCalledWith(setting.min)
	})

	it("reset clears the override", () => {
		const { onChange } = setup({ value: 20 })
		fireEvent.click(screen.getByTestId("t-reset"))
		expect(onChange).toHaveBeenCalledWith(undefined)
	})

	it("reverts when the typed number is too large to be finite", () => {
		const { onChange, input } = setup({ value: 16 })
		// 400 digits parse to Infinity.
		fireEvent.change(input, { target: { value: "9".repeat(400) } })
		fireEvent.blur(input)
		expect(onChange).not.toHaveBeenCalled()
		expect(input.value).toBe("16")
	})

	it("re-syncs the draft when the value changes from outside", () => {
		const { rerender } = (() => {
			const r = render(
				<NumberStepper
					label="l"
					description="d"
					resetLabel="r"
					setting={setting}
					value={14}
					onChange={vi.fn()}
					testId="x"
				/>,
			)
			return r
		})()
		expect((screen.getByTestId("x-input") as HTMLInputElement).value).toBe("14")
		rerender(
			<NumberStepper
				label="l"
				description="d"
				resetLabel="r"
				setting={setting}
				value={20}
				onChange={vi.fn()}
				testId="x"
			/>,
		)
		expect((screen.getByTestId("x-input") as HTMLInputElement).value).toBe("20")
	})
})
