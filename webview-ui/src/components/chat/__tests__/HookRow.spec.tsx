import { fireEvent, render, screen } from "@/utils/test-utils"

import { HookRow } from "../HookRow"

const translations: Record<string, string> = {
	"chat:hooks.phase.sessionStart": "Session start",
	"chat:hooks.status.running": "Running",
	"chat:hooks.status.failed": "Failed",
	"chat:hooks.summary.running": "Executing trusted local hook",
	"chat:hooks.summary.failed": "Hook failed; task execution continued",
	"chat:hooks.details": "Output details",
	"chat:hooks.openSettings": "Open Hooks settings",
}

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => translations[key] ?? key }),
}))

describe("HookRow", () => {
	it("renders a compact running row without exposing command data", () => {
		render(
			<HookRow
				hook={{
					hookRunId: "run-1",
					hookId: "hook-1",
					name: "Prepare session",
					phase: "sessionStart",
					status: "running",
					startedAt: 1,
				}}
			/>,
		)

		expect(screen.getByText("Prepare session")).toBeInTheDocument()
		expect(screen.getByText(/Running/)).toBeInTheDocument()
		expect(screen.queryByRole("button")).not.toBeInTheDocument()
	})

	it("shows bounded details and deep-links failures to Hooks settings", () => {
		const postMessage = vi.spyOn(window, "postMessage").mockImplementation(() => {})
		render(
			<HookRow
				hook={{
					hookRunId: "run-1",
					hookId: "hook-1",
					name: "Prepare session",
					phase: "sessionStart",
					status: "failed",
					startedAt: 1,
					completedAt: 2,
					errorSummary: "bounded diagnostic",
				}}
			/>,
		)

		fireEvent.click(screen.getByText("Output details"))
		expect(screen.getByText("bounded diagnostic")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: /Open Hooks settings/ }))
		expect(postMessage).toHaveBeenCalledWith(
			{ type: "action", action: "settingsButtonClicked", values: { section: "hooks" } },
			"*",
		)
	})
})
