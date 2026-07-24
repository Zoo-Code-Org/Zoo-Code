// npx vitest src/components/chat/__tests__/ReasoningBlock.spec.tsx

import React from "react"
import { render, screen, act } from "@/utils/test-utils"

import { ReasoningBlock } from "../ReasoningBlock"

// Mock i18n
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: any) => {
			if (key === "chat:reasoning.seconds") {
				return `${options?.count ?? 0}s`
			}
			return key
		},
	}),
	initReactI18next: {
		type: "3rdParty",
		init: vi.fn(),
	},
}))

// Mock ExtensionStateContext
const mockExtensionState = {
	reasoningBlockCollapsed: false,
}

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => mockExtensionState,
}))

const defaultProps = {
	content: "Let me think about this...",
	ts: Date.now() - 30_000, // 30 seconds ago
	isStreaming: false,
	isLast: false,
} as const

describe("ReasoningBlock", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(Date.now())
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("renders the thinking label", () => {
		render(<ReasoningBlock {...defaultProps} />)
		expect(screen.getByText("chat:reasoning.thinking")).toBeInTheDocument()
	})

	it("shows elapsed time for non-streaming blocks anchored to ts", () => {
		const thirtySecAgo = Date.now() - 30_000
		render(<ReasoningBlock {...defaultProps} ts={thirtySecAgo} isStreaming={false} />)

		// Should show ~30s since the timestamp
		expect(screen.getByText("30s")).toBeInTheDocument()
	})

	it("starts timer at 0 when streaming and is last message", () => {
		const ts = Date.now()
		render(<ReasoningBlock {...defaultProps} ts={ts} isStreaming={true} isLast={true} content="" />)

		// Initially 0 while streaming (just started) — no label shown when elapsed is 0
		expect(screen.queryByText(/^\d+s$/)).not.toBeInTheDocument()

		// Advance time by 5 seconds
		act(() => {
			vi.advanceTimersByTime(5000)
		})

		expect(screen.getByText("5s")).toBeInTheDocument()
	})

		it("preserves elapsed time on remount with same ts (Virtuoso recycle)", () => {
			// ts is 1 second in the past so elapsed starts at 1s (not 0, since 0 hides the label)
			const ts = Date.now() - 1000

			const { unmount } = render(<ReasoningBlock {...defaultProps} ts={ts} isStreaming={false} isLast={false} />)

			// Initially 1s since ts is 1s ago
			expect(screen.getByText("1s")).toBeInTheDocument()

			// Advance time by 10 seconds
			act(() => {
				vi.advanceTimersByTime(10_000)
			})

			// Unmount (simulating Virtuoso recycling the component)
			unmount()

			// Remount with the same ts
			render(<ReasoningBlock {...defaultProps} ts={ts} isStreaming={false} isLast={false} />)

			// Should still show 1s — the elapsed value was cached at module level
			// and survived the remount, instead of recomputing from Date.now() - ts
			// (which would give 11s and inflate the timer after a scroll away)
			expect(screen.getByText("1s")).toBeInTheDocument()
		})

	it("stops timer when streaming ends", () => {
		const ts = Date.now() - 5000

		const { rerender } = render(
			<ReasoningBlock {...defaultProps} ts={ts} isStreaming={true} isLast={true} content="" />,
		)

		// Streaming — timer is active
		expect(screen.getByText("5s")).toBeInTheDocument()

		// Advance time while streaming
		act(() => {
			vi.advanceTimersByTime(3000)
		})

		expect(screen.getByText("8s")).toBeInTheDocument()

		// Streaming stops — rerender with isStreaming=false
		rerender(<ReasoningBlock {...defaultProps} ts={ts} isStreaming={false} isLast={false} />)

		// Timer should stop at current value
		act(() => {
			vi.advanceTimersByTime(5000)
		})

		// Should NOT have advanced
		expect(screen.getByText("8s")).toBeInTheDocument()
	})

	it("collapses when reasoningBlockCollapsed is true", () => {
		mockExtensionState.reasoningBlockCollapsed = true

		render(<ReasoningBlock {...defaultProps} />)

		// Content and markdown should be hidden
		expect(screen.queryByText(defaultProps.content)).not.toBeInTheDocument()

		// Reset for other tests
		mockExtensionState.reasoningBlockCollapsed = false
	})

	it("hides elapsed label when elapsed is 0", () => {
		const ts = Date.now()
		render(<ReasoningBlock {...defaultProps} ts={ts} isStreaming={false} isLast={false} />)

		// No seconds label because elapsed is 0
		expect(screen.queryByText(/^\d+s$/)).not.toBeInTheDocument()
	})
})
