// npx vitest src/components/settings/__tests__/ToolRepetitionLimitControl.spec.tsx

import { render, screen, fireEvent } from "@testing-library/react"

import { ToolRepetitionLimitControl } from "../ToolRepetitionLimitControl"

// Mock the translation hook
vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => {
			const translations: Record<string, string> = {
				"settings:providers.toolRepetitionSoftLimit.label": "Tool repetition soft limit",
				"settings:providers.toolRepetitionSoftLimit.description":
					"Number of identical consecutive tool calls allowed before Roo is asked to justify repeating.",
			}
			return translations[key] || key
		},
	}),
}))

// Mock the Slider so we can drive onValueChange from a range input.
vi.mock("@/components/ui", () => ({
	Slider: ({ value, onValueChange }: any) => (
		<input
			type="range"
			role="slider"
			value={value[0]}
			onChange={(e) => onValueChange([parseInt(e.target.value, 10)])}
		/>
	),
}))

describe("ToolRepetitionLimitControl", () => {
	it("renders the label, description, and current soft value", () => {
		const onSoftChange = vi.fn()
		render(<ToolRepetitionLimitControl softValue={3} onSoftChange={onSoftChange} />)

		expect(screen.getByText("Tool repetition soft limit")).toBeInTheDocument()
		expect(screen.getByText(/Number of identical consecutive tool calls/)).toBeInTheDocument()

		const slider = screen.getByRole("slider")
		expect(slider).toHaveValue("3")
		// The numeric value is displayed next to the slider.
		expect(screen.getByText("3")).toBeInTheDocument()
	})

	it("falls back to the default soft limit when softValue is undefined", () => {
		const onSoftChange = vi.fn()
		render(<ToolRepetitionLimitControl softValue={undefined as unknown as number} onSoftChange={onSoftChange} />)

		const slider = screen.getByRole("slider")
		// DEFAULT_TOOL_REPETITION_SOFT_LIMIT is 2.
		expect(slider).toHaveValue("2")
	})

	it("calls onSoftChange when the slider value changes", () => {
		const onSoftChange = vi.fn()
		render(<ToolRepetitionLimitControl softValue={2} onSoftChange={onSoftChange} />)

		const slider = screen.getByRole("slider")
		fireEvent.change(slider, { target: { value: "5" } })

		expect(onSoftChange).toHaveBeenCalledWith(5)
	})

	it("clamps negative slider values to 0", () => {
		const onSoftChange = vi.fn()
		render(<ToolRepetitionLimitControl softValue={2} onSoftChange={onSoftChange} />)

		const slider = screen.getByRole("slider")
		fireEvent.change(slider, { target: { value: "-3" } })

		expect(onSoftChange).toHaveBeenCalledWith(0)
	})
})
