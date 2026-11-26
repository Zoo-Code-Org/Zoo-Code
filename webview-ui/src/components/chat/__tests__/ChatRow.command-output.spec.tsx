import React from "react"

import { fireEvent, renderWithExtensionState, screen } from "@/utils/test-utils"

import { ChatRowContent } from "../ChatRow"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
	Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

const renderRead = (text: string, isExpanded = false, onToggleExpand = vi.fn()) =>
	renderWithExtensionState(
		<ChatRowContent
			message={{ type: "say", say: "tool", ts: 10, text }}
			isExpanded={isExpanded}
			isLast={false}
			isStreaming={false}
			onToggleExpand={onToggleExpand}
		/>,
	)

describe("command output read display", () => {
	it("keeps an individual read's range visible", () => {
		renderRead(JSON.stringify({ tool: "readCommandOutput", readStart: 0, readEnd: 5300, totalBytes: 12000 }))

		expect(screen.getByText("(0 B - 5.2 KB of 11.7 KB)")).toBeInTheDocument()
	})

	it("collapses grouped reads and reveals each range on demand", () => {
		const onToggleExpand = vi.fn()
		const message = JSON.stringify({
			tool: "readCommandOutput",
			batchCommandOutputReads: [
				{ readStart: 0, readEnd: 5300, totalBytes: 12000 },
				{ readStart: 5300, readEnd: 8000, totalBytes: 12000 },
			],
		})
		renderRead(message, false, onToggleExpand)

		const toggle = screen.getByRole("button", { name: "chat:readCommandOutput.title ×2" })
		expect(toggle).toHaveAttribute("aria-expanded", "false")
		expect(screen.queryByText("0 B - 5.2 KB of 11.7 KB")).not.toBeInTheDocument()
		fireEvent.click(toggle)
		expect(onToggleExpand).toHaveBeenCalledWith(10)
	})

	it("shows every grouped read when expanded", () => {
		const message = JSON.stringify({
			tool: "readCommandOutput",
			batchCommandOutputReads: [
				{ readStart: 0, readEnd: 5300, totalBytes: 12000 },
				{ searchPattern: "failed", matchCount: 2 },
			],
		})
		renderRead(message, true)

		expect(screen.getByText("0 B - 5.2 KB of 11.7 KB")).toBeInTheDocument()
		expect(screen.getByText('search: "failed" · 2 matches')).toBeInTheDocument()
	})
})
