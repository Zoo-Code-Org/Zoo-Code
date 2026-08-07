import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"
import { PinnedHistoryItem } from "../PinnedHistoryItem"
import type { ResolvedTaskUnit } from "../types"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) => {
			if (key === "history:openFolder") return `Open folder ${options?.name}`
			if (key === "history:openTask") return "Open task"
			return key
		},
	}),
}))

describe("PinnedHistoryItem", () => {
	const mockUnit: ResolvedTaskUnit = {
		rootTaskId: "task-100",
		target: { kind: "task", taskId: "task-100" },
		closureTaskIds: ["task-100"],
	}

	it("renders a pinned task card with rootTaskId label by default", () => {
		render(<PinnedHistoryItem unit={mockUnit} isPinned={true} canPin={true} onTogglePin={vi.fn()} />)

		expect(screen.getByTestId("pinned-item-label")).toHaveTextContent("task-100")
		expect(screen.getByRole("button", { name: "Open task" })).toBeInTheDocument()
	})

	it("renders a pinned task card with custom label when provided", () => {
		render(
			<PinnedHistoryItem
				unit={mockUnit}
				label="Custom Task Label"
				isPinned={true}
				canPin={true}
				onTogglePin={vi.fn()}
			/>,
		)

		expect(screen.getByTestId("pinned-item-label")).toHaveTextContent("Custom Task Label")
	})

	it("renders a pinned folder card when unit is undefined", () => {
		render(<PinnedHistoryItem folderName="My Pinned Folder" isPinned={true} canPin={true} onTogglePin={vi.fn()} />)

		expect(screen.getByTestId("pinned-item-label")).toHaveTextContent("My Pinned Folder")
		expect(screen.getByRole("button", { name: "Open folder My Pinned Folder" })).toBeInTheDocument()
	})

	it("triggers onClick when the main button is clicked", () => {
		const onClick = vi.fn()
		render(
			<PinnedHistoryItem unit={mockUnit} isPinned={true} canPin={true} onTogglePin={vi.fn()} onClick={onClick} />,
		)

		fireEvent.click(screen.getByRole("button", { name: "Open task" }))
		expect(onClick).toHaveBeenCalledTimes(1)
	})

	it("triggers onTogglePin when the PinButton is clicked", () => {
		const onTogglePin = vi.fn()
		render(<PinnedHistoryItem unit={mockUnit} isPinned={true} canPin={true} onTogglePin={onTogglePin} />)

		fireEvent.click(screen.getByTestId("pinned-item-pin-button"))
		expect(onTogglePin).toHaveBeenCalledTimes(1)
	})
})
