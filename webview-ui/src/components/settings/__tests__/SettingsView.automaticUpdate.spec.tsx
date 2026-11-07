import { fireEvent, screen, waitFor } from "@testing-library/react"
import { useEffect } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { renderWithExtensionState } from "@/utils/test-utils"
import { vscode } from "@src/utils/vscode"

import SettingsView from "../SettingsView"
import { answerSave, lastSaveRequestId } from "./saveAcknowledgement"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/utils/TelemetryClient", () => ({ telemetryClient: { capture: vi.fn() } }))

// The providers page fills in a default for its own part of the state when it first appears. That is not an edit, but
// it replaces the state object of the form while the page is open.
// Each time the page mounts it fills in a field that was still empty, so it is an initial sync: no edit, but the state
// object is replaced. (The form also mounts every page once, briefly, to index its settings, so a field filled in
// by the first mount would leave nothing to fill in later.)
const emptyFields = [
	"apiModelId",
	"openRouterModelId",
	"requestyModelId",
	"unboundModelId",
	"litellmModelId",
	"ollamaModelId",
	"lmStudioModelId",
	"glamaModelId",
]
let fieldsFilled = 0

vi.mock("../ApiOptions", () => {
	const ApiOptionsMock = ({
		setApiConfigurationField,
	}: {
		setApiConfigurationField: (field: string, value: unknown, isUserAction?: boolean) => void
	}) => {
		useEffect(() => {
			setApiConfigurationField(emptyFields[fieldsFilled++ % emptyFields.length], "a-default-model", false)
		}, [setApiConfigurationField])
		return <div data-testid="api-options-mock" />
	}

	return { default: ApiOptionsMock }
})

const postMessage = vi.mocked(vscode.postMessage)

describe("SettingsView – an automatic update of the state while an appearance save waits", () => {
	beforeEach(() => postMessage.mockClear())

	it("does not keep the form unsaved after the save was stored, and leaving it asks nothing", async () => {
		renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="ui" />)
		fireEvent.click(await screen.findByTestId("appearance-terminalFontSize-increment"))
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		fireEvent.click(screen.getByTestId("save-button"))

		fireEvent.click(screen.getByTestId("tab-providers"))
		await screen.findByTestId("api-options-mock")
		answerSave(lastSaveRequestId(postMessage), { success: true })

		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())
		fireEvent.click(screen.getByRole("button", { name: "settings:common.done" }))
		expect(screen.queryByText("settings:unsavedChangesDialog.title")).not.toBeInTheDocument()
	})

	it("still keeps the form unsaved when the user edited something while the save waited", async () => {
		renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="ui" />)
		fireEvent.click(await screen.findByTestId("appearance-terminalFontSize-increment"))
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		fireEvent.click(screen.getByTestId("save-button"))

		fireEvent.click(screen.getByTestId("appearance-terminalFontSize-increment")) // a real edit, after the save
		answerSave(lastSaveRequestId(postMessage), { success: true })

		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
	})
})
