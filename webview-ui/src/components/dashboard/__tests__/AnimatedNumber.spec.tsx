// npx vitest run src/components/dashboard/__tests__/AnimatedNumber.spec.tsx

import React from "react"
import { render, act } from "@/utils/test-utils"

import AnimatedNumber from "../AnimatedNumber"

// ── Tests ────────────────────────────────────────────────────────────────────

describe("AnimatedNumber", () => {
	it("renders the initial value immediately", () => {
		const { container } = render(<AnimatedNumber value={42} />)
		const el = container.querySelector('[data-testid="animated-number"]')
		expect(el).toBeTruthy()
		expect(el?.textContent).toBe("42")
	})

	it("renders with custom format function", () => {
		const { container } = render(<AnimatedNumber value={1500} format={(v) => `${(v / 1000).toFixed(1)}K`} />)
		const el = container.querySelector('[data-testid="animated-number"]')
		expect(el?.textContent).toBe("1.5K")
	})

	it("renders with default format (toLocaleString)", () => {
		const { container } = render(<AnimatedNumber value={1234567} />)
		const el = container.querySelector('[data-testid="animated-number"]')
		expect(el?.textContent).toBe((1234567).toLocaleString())
	})

	it("renders with custom className", () => {
		const { container } = render(<AnimatedNumber value={0} className="text-lg font-bold" />)
		const el = container.querySelector('[data-testid="animated-number"]')
		expect(el?.className).toContain("text-lg")
		expect(el?.className).toContain("font-bold")
	})

	it("snaps immediately when prefers-reduced-motion is active", () => {
		// Mock matchMedia to simulate reduced motion
		const original = window.matchMedia
		window.matchMedia = vi.fn().mockReturnValue({
			matches: true,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		}) as unknown as typeof window.matchMedia

		const { container, rerender } = render(<AnimatedNumber value={0} />)
		const el = container.querySelector('[data-testid="animated-number"]')

		// Initial value
		expect(el?.textContent).toBe("0")

		// Change value — should snap immediately, not animate
		rerender(<AnimatedNumber value={100} />)
		const elAfter = container.querySelector('[data-testid="animated-number"]')
		expect(elAfter?.textContent).toBe("100")

		// Restore
		window.matchMedia = original
	})

	it("animates towards the target value when value changes (without reduced motion)", () => {
		// Mock matchMedia to simulate no reduced motion
		const original = window.matchMedia
		window.matchMedia = vi.fn().mockReturnValue({
			matches: false,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		}) as unknown as typeof window.matchMedia

		// Mock requestAnimationFrame to control animation steps
		const rafCallbacks: FrameRequestCallback[] = []
		const originalRAF = window.requestAnimationFrame
		window.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
			rafCallbacks.push(cb)
			return rafCallbacks.length
		})
		const originalCancelRAF = window.cancelAnimationFrame
		window.cancelAnimationFrame = vi.fn()

		const { container, rerender } = render(<AnimatedNumber value={0} duration={100} />)

		// Change value to trigger animation
		rerender(<AnimatedNumber value={100} duration={100} />)

		// The display value should still be 0 initially (animation hasn't started)
		const elBefore = container.querySelector('[data-testid="animated-number"]')
		expect(elBefore?.textContent).toBe("0")

		// Fire the first animation frame (timestamp 0)
		if (rafCallbacks.length > 0) {
			act(() => {
				rafCallbacks[0](0)
			})
		}

		// After some frames, the value should be between 0 and 100
		// Fire a frame at 50ms (halfway through 100ms duration)
		if (rafCallbacks.length > 1) {
			act(() => {
				rafCallbacks[rafCallbacks.length - 1](50)
			})
		}

		const elMid = container.querySelector('[data-testid="animated-number"]')
		const midValue = parseInt(elMid?.textContent ?? "0", 10)
		expect(midValue).toBeGreaterThan(0)
		expect(midValue).toBeLessThan(100)

		// Fire a frame past the duration to complete the animation
		const lastCallback = rafCallbacks[rafCallbacks.length - 1]
		if (lastCallback) {
			act(() => {
				lastCallback(200)
			})
		}

		const elAfter = container.querySelector('[data-testid="animated-number"]')
		expect(elAfter?.textContent).toBe("100")

		// Restore
		window.matchMedia = original
		window.requestAnimationFrame = originalRAF
		window.cancelAnimationFrame = originalCancelRAF
	})

	it("does not animate when value does not change", () => {
		const { container, rerender } = render(<AnimatedNumber value={42} />)
		rerender(<AnimatedNumber value={42} />)
		const el = container.querySelector('[data-testid="animated-number"]')
		expect(el?.textContent).toBe("42")
	})
})
