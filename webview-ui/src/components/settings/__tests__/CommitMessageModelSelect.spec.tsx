// npx vitest src/components/settings/__tests__/CommitMessageModelSelect.spec.tsx

import { render, screen, fireEvent } from "@/utils/test-utils"

import { CommitMessageModelSelect } from "../CommitMessageModelSelect"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/components/ui", () => ({
	Select: ({ children, value, onValueChange, ...props }: any) => (
		<div role="combobox" data-value={value} {...props}>
			{/* Hidden trigger lets tests drive selection deterministically:
			    set data-next-value on the button, then click it. */}
			<button
				type="button"
				aria-hidden="true"
				data-testid="commit-message-model-change"
				onClick={(e: any) => onValueChange?.(e.currentTarget.getAttribute("data-next-value"))}
			/>
			{children}
		</div>
	),
	Input: (props: any) => <input {...props} />,
	SelectTrigger: ({ children, ...props }: any) => <div {...props}>{children}</div>,
	SelectValue: ({ children, ...props }: any) => <div {...props}>{children}</div>,
	SelectContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
	SelectItem: ({ children, ...props }: any) => <div {...props}>{children}</div>,
}))

describe("CommitMessageModelSelect", () => {
	const listApiConfigMeta = [
		{ id: "config1", name: "Config 1" },
		{ id: "config2", name: "Config 2" },
	]

	const renderSelect = (commitMessageApiConfigId?: string, commitMessageTimeout?: number) => {
		const setCachedStateField = vi.fn()

		const { rerender } = render(
			<CommitMessageModelSelect
				listApiConfigMeta={listApiConfigMeta}
				commitMessageApiConfigId={commitMessageApiConfigId}
				commitMessageTimeout={commitMessageTimeout}
				setCachedStateField={setCachedStateField}
			/>,
		)

		return { setCachedStateField, rerender }
	}

	const selectValue = (value: string) => {
		const trigger = screen.getByTestId("commit-message-model-change")
		trigger.setAttribute("data-next-value", value)
		fireEvent.click(trigger)
	}

	it("lists every available profile alongside the fallback option", () => {
		renderSelect()

		expect(screen.getByTestId("config1-option")).toHaveTextContent("Config 1")
		expect(screen.getByTestId("config2-option")).toHaveTextContent("Config 2")
		expect(screen.getByText("settings:providers.commitMessageModel.useCurrentConfig")).toBeInTheDocument()
	})

	it("names the trigger with the setting label", () => {
		renderSelect()

		// A sibling <label> does not name a Radix trigger, so screen readers rely on this link.
		const trigger = screen.getByTestId("commit-message-model-select")
		const labelId = trigger.getAttribute("aria-labelledby")

		expect(labelId).toBeTruthy()
		expect(document.getElementById(labelId!)).toHaveTextContent("settings:providers.commitMessageModel.label")
	})

	it("shows the sentinel when no profile is selected", () => {
		renderSelect()

		expect(screen.getByRole("combobox")).toHaveAttribute("data-value", "-")
	})

	it("shows the saved profile when one is selected", () => {
		renderSelect("config2")

		expect(screen.getByRole("combobox")).toHaveAttribute("data-value", "config2")
	})

	// Radix renders a blank trigger when the value matches no item, so a profile deleted after it
	// was chosen would leave the picker looking empty rather than showing the fallback.
	it("falls back to the sentinel when the saved profile no longer exists", () => {
		renderSelect("deleted-config")

		expect(screen.getByRole("combobox")).toHaveAttribute("data-value", "-")
	})

	it("stores the selected profile id", () => {
		const { setCachedStateField } = renderSelect()

		selectValue("config2")

		expect(setCachedStateField).toHaveBeenCalledWith("commitMessageApiConfigId", "config2")
	})

	it("stores an empty string when the fallback option is chosen", () => {
		const { setCachedStateField } = renderSelect("config2")

		selectValue("-")

		expect(setCachedStateField).toHaveBeenCalledWith("commitMessageApiConfigId", "")
	})

	describe("timeout", () => {
		const timeoutInput = () => screen.getByTestId("commit-message-timeout")

		it("shows the default when the setting is unset", () => {
			renderSelect()

			expect(timeoutInput()).toHaveValue(60)
		})

		it("shows the saved value", () => {
			renderSelect(undefined, 120)

			expect(timeoutInput()).toHaveValue(120)
		})

		// Persisting only on blur loses the edit when Save is clicked without blurring first, or
		// when Save reads cached state before the blur handler runs - which is what made saving
		// the timeout intermittently revert.
		it("stores a value inside the accepted range as it is typed", () => {
			const { setCachedStateField } = renderSelect()

			fireEvent.change(timeoutInput(), { target: { value: "90" } })

			expect(setCachedStateField).toHaveBeenCalledWith("commitMessageTimeout", 90)
		})

		// The input keeps a local draft so the user can clear it and type intermediate values
		// without each keystroke fighting validation.
		it("keeps intermediate states in the draft without persisting them", () => {
			const { setCachedStateField } = renderSelect()

			// A number input reports a null value when its text content is empty.
			fireEvent.change(timeoutInput(), { target: { value: "" } })
			expect(timeoutInput()).toHaveValue(null)
			expect(setCachedStateField).not.toHaveBeenCalled()

			// Below the minimum on the way to a longer number, so still not persisted.
			fireEvent.change(timeoutInput(), { target: { value: "1" } })
			expect(timeoutInput()).toHaveValue(1)
			expect(setCachedStateField).not.toHaveBeenCalled()

			fireEvent.change(timeoutInput(), { target: { value: "120" } })
			expect(setCachedStateField).toHaveBeenCalledWith("commitMessageTimeout", 120)
		})

		// `parseInt` stops at the first character it cannot use, so a fractional entry would store a
		// truncated integer while the field still displayed what was typed - the setting and the
		// input would disagree, and the schema only accepts integers anyway.
		it.each([["23.5"], ["12abc"], ["23,5"]])("does not persist a truncated integer from %s", (value) => {
			const { setCachedStateField } = renderSelect()

			fireEvent.change(timeoutInput(), { target: { value } })

			expect(setCachedStateField).not.toHaveBeenCalled()
		})

		it("restores the last persisted value when the field is left invalid", () => {
			renderSelect(undefined, 45)

			fireEvent.change(timeoutInput(), { target: { value: "" } })
			fireEvent.blur(timeoutInput())

			expect(timeoutInput()).toHaveValue(45)
		})

		// Keeping a local copy of a valid value made the field shadow the setting: after a save it
		// kept showing the old number until the panel remounted. It has to follow the prop.
		it("shows the saved value as soon as it arrives", () => {
			const { rerender } = renderSelect(undefined, 60)

			rerender(
				<CommitMessageModelSelect
					listApiConfigMeta={listApiConfigMeta}
					commitMessageTimeout={120}
					setCachedStateField={vi.fn()}
				/>,
			)

			expect(timeoutInput()).toHaveValue(120)
		})

		// An unstorable draft is the one thing that outranks the prop, so a value arriving mid-edit
		// must not yank the field out from under what is being typed.
		it("keeps an in-progress draft when a new value arrives", () => {
			const { rerender } = renderSelect(undefined, 60)

			fireEvent.change(timeoutInput(), { target: { value: "" } })

			rerender(
				<CommitMessageModelSelect
					listApiConfigMeta={listApiConfigMeta}
					commitMessageTimeout={120}
					setCachedStateField={vi.fn()}
				/>,
			)

			expect(timeoutInput()).toHaveValue(null)
		})
	})
})
