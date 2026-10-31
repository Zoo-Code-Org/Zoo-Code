import { render, screen } from "@/utils/test-utils"
import { ExtensionStateContext } from "@/context/ExtensionStateContext"
import { formatDateTime } from "@/utils/format"

import TaskItemFooter from "../TaskItemFooter"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

// Renders the tooltip's content as an attribute, so whether a tooltip exists and what it says can be asserted.
vi.mock("../../ui/standard-tooltip", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../ui/standard-tooltip")>()),
	StandardTooltip: ({ children, content }: { children: React.ReactNode; content: string }) => (
		<div data-testid="tooltip" data-content={content}>
			{children}
		</div>
	),
}))

vi.mock("@/utils/format", () => ({
	formatTimeAgo: vi.fn(() => "2 hours ago"),
	// Depends on its arguments, so a test can tell which formats were applied.
	formatDateTime: vi.fn(
		(_ts: number, timeFormat = "auto", dateFormat = "auto") =>
			`${dateFormat === "ymd" ? "2024-01-15" : dateFormat === "dmy" ? "15/01/2024" : "Jan 15, 2024"}, ${timeFormat === "24h" ? "14:30" : "2:30 PM"}`,
	),
	formatLargeNumber: vi.fn((num: number) => num.toString()),
}))

const mockItem = {
	id: "1",
	number: 1,
	task: "Test task",
	ts: Date.now(),
	tokensIn: 100,
	tokensOut: 50,
	totalCost: 0.002,
	workspace: "/test/workspace",
}

describe("TaskItemFooter", () => {
	it("renders time ago information", () => {
		render(<TaskItemFooter item={mockItem} variant="full" />)

		// Should show time ago format
		expect(screen.getByText(/ago/)).toBeInTheDocument()
	})

	it("renders cost information", () => {
		render(<TaskItemFooter item={mockItem} variant="full" />)

		// The component shows $0.00 for small amounts, not the exact value
		expect(screen.getByText("$0.00")).toBeInTheDocument()
	})

	it("shows action buttons", () => {
		render(<TaskItemFooter item={mockItem} variant="full" />)

		// Should show copy and export buttons
		expect(screen.getByTestId("copy-prompt-button")).toBeInTheDocument()
		expect(screen.getByTestId("export")).toBeInTheDocument()
	})

	it("hides export button in compact variant", () => {
		render(<TaskItemFooter item={mockItem} variant="compact" />)

		// Should show copy button but not export button
		expect(screen.getByTestId("copy-prompt-button")).toBeInTheDocument()
		expect(screen.queryByTestId("export")).not.toBeInTheDocument()
	})

	it("hides action buttons in selection mode", () => {
		render(<TaskItemFooter item={mockItem} variant="full" isSelectionMode={true} />)

		// Should not show any action buttons
		expect(screen.queryByTestId("copy-prompt-button")).not.toBeInTheDocument()
		expect(screen.queryByTestId("export")).not.toBeInTheDocument()
		expect(screen.queryByTestId("delete-task-button")).not.toBeInTheDocument()
	})

	it("shows delete button when not in selection mode and onDelete is provided", () => {
		render(<TaskItemFooter item={mockItem} variant="full" isSelectionMode={false} onDelete={vi.fn()} />)

		expect(screen.getByTestId("delete-task-button")).toBeInTheDocument()
	})

	it("does not show delete button in selection mode", () => {
		render(<TaskItemFooter item={mockItem} variant="full" isSelectionMode={true} onDelete={vi.fn()} />)

		expect(screen.queryByTestId("delete-task-button")).not.toBeInTheDocument()
	})

	it("does not show delete button when onDelete is not provided", () => {
		render(<TaskItemFooter item={mockItem} variant="full" isSelectionMode={false} />)

		expect(screen.queryByTestId("delete-task-button")).not.toBeInTheDocument()
	})

	it("shows subtask tag when isSubtask is true", () => {
		render(<TaskItemFooter item={mockItem} variant="full" isSubtask={true} />)

		expect(screen.getByText("history:subtaskTag")).toBeInTheDocument()
	})

	it("does not show subtask tag when isSubtask is false", () => {
		render(<TaskItemFooter item={mockItem} variant="full" isSubtask={false} />)

		expect(screen.queryByText("history:subtaskTag")).not.toBeInTheDocument()
	})

	it("shows a delegated status badge when status is delegated", () => {
		render(
			<TaskItemFooter item={{ ...mockItem, status: "delegated", awaitingChildId: "child-1" }} variant="full" />,
		)

		expect(screen.getByTestId("task-status-badge-delegated")).toBeInTheDocument()
	})

	it("shows an interrupted status badge when status is interrupted", () => {
		render(<TaskItemFooter item={{ ...mockItem, status: "interrupted" }} variant="full" />)

		expect(screen.getByTestId("task-status-badge-interrupted")).toBeInTheDocument()
	})

	it("does not show a status badge for a completed task", () => {
		render(<TaskItemFooter item={{ ...mockItem, status: "completed" }} variant="full" />)

		expect(screen.queryByTestId(/task-status-badge-/)).not.toBeInTheDocument()
	})

	it("shows rename button in full variant when onRename is provided", () => {
		render(<TaskItemFooter item={mockItem} variant="full" onRename={vi.fn()} />)

		expect(screen.getByTestId("rename-task-button")).toBeInTheDocument()
	})

	it.each([
		["compact variant", { variant: "compact" as const, onRename: vi.fn() }],
		["selection mode", { variant: "full" as const, onRename: vi.fn(), isSelectionMode: true }],
		["no onRename", { variant: "full" as const }],
	])("hides rename button in %s", (_label, props) => {
		render(<TaskItemFooter item={mockItem} {...props} />)

		expect(screen.queryByTestId("rename-task-button")).not.toBeInTheDocument()
	})

	describe("time display settings", () => {
		const renderWith = (state: Record<string, unknown>) =>
			render(
				<ExtensionStateContext.Provider value={state as never}>
					<TaskItemFooter item={mockItem} variant="compact" />
				</ExtensionStateContext.Provider>,
			)

		it("shows a relative time by default", () => {
			renderWith({})
			expect(screen.getByText("2 hours ago")).toBeInTheDocument()
		})

		it("shows a relative time when showRelativeTimes is on", () => {
			renderWith({ showRelativeTimes: true })
			expect(screen.getByText("2 hours ago")).toBeInTheDocument()
		})

		// The footer has other tooltips (the action buttons), so look at the one around the time.
		const tooltipAround = (text: string) =>
			screen.queryAllByTestId("tooltip").find((tooltip) => tooltip.textContent?.includes(text))

		it("gives a relative time a tooltip with the full date and time", () => {
			renderWith({ showRelativeTimes: true, timeFormat: "24h", dateFormat: "ymd" })

			expect(tooltipAround("2 hours ago")).toHaveAttribute("data-content", "2024-01-15, 14:30")
		})

		it("gives an absolute time no tooltip, which would only repeat it", () => {
			renderWith({ showRelativeTimes: false, timeFormat: "24h", dateFormat: "ymd" })

			expect(screen.getByText("2024-01-15, 14:30")).toBeInTheDocument()
			expect(tooltipAround("2024-01-15, 14:30")).toBeUndefined()
			// ...and nothing carries the same text as a tooltip's content either.
			expect(screen.queryAllByTestId("tooltip").map((t) => t.getAttribute("data-content"))).not.toContain(
				"2024-01-15, 14:30",
			)
		})

		it("shows the absolute date/time instead when showRelativeTimes is off", () => {
			renderWith({ showRelativeTimes: false, timeFormat: "24h", dateFormat: "ymd" })
			expect(screen.queryByText("2 hours ago")).not.toBeInTheDocument()
			// 24-hour clock and year-first date: the visible text carries both choices.
			expect(screen.getByText("2024-01-15, 14:30")).toBeInTheDocument()
			expect(screen.queryByText(/PM/)).not.toBeInTheDocument()
		})

		it("shows a 12-hour time when the clock is not set to 24-hour", () => {
			renderWith({ showRelativeTimes: false, timeFormat: "12h", dateFormat: "auto" })
			expect(screen.getByText("Jan 15, 2024, 2:30 PM")).toBeInTheDocument()
		})

		it("passes the chosen time and date formats to the formatter", () => {
			renderWith({ showRelativeTimes: false, timeFormat: "24h", dateFormat: "dmy" })
			expect(formatDateTime).toHaveBeenCalledWith(mockItem.ts, "24h", "dmy")
			expect(screen.getByText("15/01/2024, 14:30")).toBeInTheDocument()
		})
	})
})
