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

	const renderSelect = (commitMessageApiConfigId?: string) => {
		const setCachedStateField = vi.fn()

		render(
			<CommitMessageModelSelect
				listApiConfigMeta={listApiConfigMeta}
				commitMessageApiConfigId={commitMessageApiConfigId}
				setCachedStateField={setCachedStateField}
			/>,
		)

		return { setCachedStateField }
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

	it("shows the sentinel when no profile is selected", () => {
		renderSelect()

		expect(screen.getByRole("combobox")).toHaveAttribute("data-value", "-")
	})

	it("shows the saved profile when one is selected", () => {
		renderSelect("config2")

		expect(screen.getByRole("combobox")).toHaveAttribute("data-value", "config2")
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
})
