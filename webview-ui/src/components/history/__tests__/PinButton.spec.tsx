import { render, screen, fireEvent, act } from "@/utils/test-utils"
import { PinButton } from "../PinButton"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

describe("PinButton", () => {
	it("renders an unpinned state", () => {
		const onToggle = vi.fn()
		render(<PinButton isPinned={false} canPin={true} onToggle={onToggle} />)

		const button = screen.getByTestId("pin-button")
		expect(button).toHaveAttribute("data-pinned", "false")
		expect(button).toHaveAttribute("aria-pressed", "false")
	})

	it("renders a pinned state", () => {
		const onToggle = vi.fn()
		render(<PinButton isPinned={true} canPin={false} onToggle={onToggle} />)

		const button = screen.getByTestId("pin-button")
		expect(button).toHaveAttribute("data-pinned", "true")
		expect(button).toHaveAttribute("aria-pressed", "true")
	})

	it("calls onToggle when clicked in unpinned state with canPin true", () => {
		const onToggle = vi.fn()
		render(<PinButton isPinned={false} canPin={true} onToggle={onToggle} />)

		fireEvent.click(screen.getByTestId("pin-button"))
		expect(onToggle).toHaveBeenCalledTimes(1)
	})

	it("calls onToggle when clicked in pinned state", () => {
		const onToggle = vi.fn()
		render(<PinButton isPinned={true} canPin={false} onToggle={onToggle} />)

		fireEvent.click(screen.getByTestId("pin-button"))
		expect(onToggle).toHaveBeenCalledTimes(1)
	})

	it("shows limit error feedback and does not call onToggle when pin is blocked", () => {
		vi.useFakeTimers()
		const onToggle = vi.fn()
		render(<PinButton isPinned={false} canPin={false} onToggle={onToggle} />)

		const button = screen.getByTestId("pin-button")
		fireEvent.click(button)

		expect(onToggle).not.toHaveBeenCalled()
		expect(button).toHaveAttribute("data-limit-error", "true")

		act(() => {
			vi.advanceTimersByTime(1600)
		})

		expect(button).toHaveAttribute("data-limit-error", "false")
		vi.useRealTimers()
	})

	it("stops click propagation to parent handlers", () => {
		const parentClick = vi.fn()
		const onToggle = vi.fn()
		render(
			<div onClick={parentClick}>
				<PinButton isPinned={false} canPin={true} onToggle={onToggle} />
			</div>,
		)

		fireEvent.click(screen.getByTestId("pin-button"))
		expect(onToggle).toHaveBeenCalled()
		expect(parentClick).not.toHaveBeenCalled()
	})
})
