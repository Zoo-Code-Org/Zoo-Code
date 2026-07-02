import React from "react"
import { fireEvent, render } from "@testing-library/react"

import { vscode } from "@src/utils/vscode"

import { SeeNewChangesButtons } from "../SeeNewChangesButtons"

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key,
	}),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, onClick, disabled, title }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
		<button type="button" onClick={onClick} disabled={disabled} title={title}>
			{children}
		</button>
	),
}))

describe("SeeNewChangesButtons", () => {
	beforeEach(() => vi.clearAllMocks())

	it("posts the Kilo-style see-new-changes action", () => {
		const { getByText } = render(<SeeNewChangesButtons />)

		fireEvent.click(getByText("chat:seeNewChanges.title"))

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "completionCheckpointDiff" })
	})

	it("requires confirmation before restoring changes", () => {
		const { getByText, queryByText } = render(<SeeNewChangesButtons />)

		fireEvent.click(getByText("chat:restoreChanges.title"))

		expect(queryByText("chat:restoreChanges.title")).not.toBeInTheDocument()
		expect(getByText("chat:checkpoint.menu.confirm chat:restoreChanges.title")).toBeInTheDocument()
		expect(getByText("chat:checkpoint.menu.cancel")).toBeInTheDocument()
		expect(vscode.postMessage).not.toHaveBeenCalled()

		fireEvent.click(getByText("chat:checkpoint.menu.confirm chat:restoreChanges.title"))

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "completionCheckpointRestore" })
	})

	it("returns to the initial actions when restore confirmation is cancelled", () => {
		const { getByText, queryByText } = render(<SeeNewChangesButtons />)

		fireEvent.click(getByText("chat:restoreChanges.title"))
		fireEvent.click(getByText("chat:checkpoint.menu.cancel"))

		expect(getByText("chat:seeNewChanges.title")).toBeInTheDocument()
		expect(getByText("chat:restoreChanges.title")).toBeInTheDocument()
		expect(queryByText("chat:checkpoint.menu.confirm chat:restoreChanges.title")).not.toBeInTheDocument()
	})

	it("wires tooltip copy into the primary actions", () => {
		const { getByText } = render(<SeeNewChangesButtons />)

		expect(getByText("chat:seeNewChanges.title")).toHaveAttribute("title", "chat:seeNewChanges.tooltip")
		expect(getByText("chat:restoreChanges.title")).toHaveAttribute("title", "chat:restoreChanges.tooltip")
	})
})
