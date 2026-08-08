import { render, screen } from "@/utils/test-utils"
import { OpenAICompatibleStrictModeFixture } from "./OpenAICompatible.visual.fixture"

vi.mock("vscrui", () => ({
	Checkbox: ({
		children,
		checked,
		onChange,
	}: {
		children: React.ReactNode
		checked?: boolean
		onChange?: () => void
	}) => (
		<label>
			<input type="checkbox" checked={checked} onChange={() => onChange?.()} readOnly />
			{children}
		</label>
	),
}))

describe("OpenAICompatibleStrictModeFixture", () => {
	it("renders the strict tool schemas toggle block", () => {
		render(<OpenAICompatibleStrictModeFixture />)
		expect(screen.getByTestId("strict-tool-schemas-block")).toBeInTheDocument()
	})

	it("renders the checkbox with checked state", () => {
		render(<OpenAICompatibleStrictModeFixture />)
		const checkbox = screen.getByRole("checkbox") as HTMLInputElement
		expect(checkbox).toBeChecked()
	})

	it("renders the description text", () => {
		render(<OpenAICompatibleStrictModeFixture />)
		expect(
			screen.getByText(/Enables strict mode for function tool schemas/),
		).toBeInTheDocument()
	})
})
