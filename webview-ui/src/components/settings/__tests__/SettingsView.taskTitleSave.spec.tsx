import { fireEvent, screen, waitFor } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ExtensionState } from "@roo-code/types"

import { renderWithExtensionState } from "@/utils/test-utils"
import { vscode } from "@src/utils/vscode"

import SettingsView from "../SettingsView"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@/utils/TelemetryClient", () => ({ telemetryClient: { capture: vi.fn() } }))

// The tab's own controls are covered by PromptsSettings.taskTitle.spec; this stub drives the setters
// SettingsView passes down so the test can follow the cachedState-to-Save path.
vi.mock("../PromptsSettings", () => ({
	default: (props: {
		taskTitleGenerationEnabled?: boolean
		setTaskTitleGenerationEnabled?: (value: boolean) => void
		taskTitleApiConfigId?: string
		setTaskTitleApiConfigId?: (value: string) => void
	}) => (
		<div>
			<span data-testid="stub-enabled">{String(props.taskTitleGenerationEnabled)}</span>
			<span data-testid="stub-profile">{props.taskTitleApiConfigId ?? ""}</span>
			<button
				data-testid="stub-toggle"
				onClick={() => props.setTaskTitleGenerationEnabled?.(!props.taskTitleGenerationEnabled)}
			/>
			<button data-testid="stub-pick-light" onClick={() => props.setTaskTitleApiConfigId?.("light")} />
			<button data-testid="stub-clear-profile" onClick={() => props.setTaskTitleApiConfigId?.("")} />
		</div>
	),
}))

const postMessage = vi.mocked(vscode.postMessage)

type SavedSettings = Partial<Pick<ExtensionState, "taskTitleGenerationEnabled" | "taskTitleApiConfigId">>

const savedSettings = (): SavedSettings[] =>
	postMessage.mock.calls
		.map((call) => call[0] as { type: string; updatedSettings?: SavedSettings })
		.filter((message) => message.type === "updateSettings")
		.map((message) => message.updatedSettings ?? {})

const renderPrompts = (state: Partial<ExtensionState>) =>
	renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="prompts" />, {
		state,
		queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
	})

const save = async () => {
	await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
	fireEvent.click(screen.getByTestId("save-button"))
}

describe("SettingsView – saving the task title settings", () => {
	beforeEach(() => postMessage.mockClear())

	it("buffers both edits and sends them only when Save is clicked", async () => {
		renderPrompts({ taskTitleGenerationEnabled: true })

		fireEvent.click(await screen.findByTestId("stub-toggle"))
		fireEvent.click(screen.getByTestId("stub-pick-light"))

		expect(screen.getByTestId("stub-enabled")).toHaveTextContent("false")
		expect(screen.getByTestId("stub-profile")).toHaveTextContent("light")
		expect(savedSettings()).toEqual([])

		await save()

		expect(savedSettings()).toHaveLength(1)
		expect(savedSettings()[0]).toMatchObject({ taskTitleGenerationEnabled: false, taskTitleApiConfigId: "light" })
	})

	it("sends an empty profile id when the selected profile is cleared", async () => {
		renderPrompts({ taskTitleApiConfigId: "light" })

		fireEvent.click(await screen.findByTestId("stub-clear-profile"))
		await save()

		expect(savedSettings()[0]).toMatchObject({ taskTitleApiConfigId: "" })
	})

	it.each([
		{ stored: undefined, expected: true },
		{ stored: false, expected: false },
	])("saves the enabled flag as $expected when the stored value is $stored", async ({ stored, expected }) => {
		renderPrompts({ taskTitleGenerationEnabled: stored })

		// Edit an unrelated title setting so Save becomes available without touching the flag.
		fireEvent.click(await screen.findByTestId("stub-pick-light"))
		await save()

		expect(savedSettings()[0]).toMatchObject({ taskTitleGenerationEnabled: expected })
	})
})
