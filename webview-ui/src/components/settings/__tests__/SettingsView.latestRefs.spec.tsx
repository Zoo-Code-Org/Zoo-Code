import { fireEvent, screen, waitFor } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"

import { renderWithExtensionState } from "@/utils/test-utils"
import { vscode } from "@src/utils/vscode"

import SettingsView from "../SettingsView"
import { answerSave, lastSaveRequestId } from "./saveAcknowledgement"
import { withVscodeEditorFontSize } from "./vscodeEditorFontSize"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/utils/TelemetryClient", () => ({ telemetryClient: { capture: vi.fn() } }))

withVscodeEditorFontSize(12)

const input = () => screen.getByTestId("appearance-terminalFontSize-input") as HTMLInputElement
const increment = () => fireEvent.click(screen.getByTestId("appearance-terminalFontSize-increment"))

// A save result arrives through a window message, outside of React, and is compared with the form as it is now (the
// latest commit), not as it was when the save was sent.
describe("SettingsView – a save result is compared with the latest form and edit count", () => {
	const renderAndSave = async () => {
		renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="ui" />, {
			queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
		})
		increment() // 13
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		vi.mocked(vscode.postMessage).mockClear()
		fireEvent.click(screen.getByTestId("save-button"))
		return lastSaveRequestId(vi.mocked(vscode.postMessage)) // the answer to be delivered, captured before the next edit
	}

	it("keeps an edit made after the save was sent, and the unsaved state, when the answer of that save arrives", async () => {
		const requestId = await renderAndSave()
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled()) // waiting for the answer
		increment() // 14, made while the save is pending
		await waitFor(() => expect(input().value).toBe("14"))

		answerSave(requestId, { success: true })

		expect(input().value).toBe("14") // not replaced with the 13 that was saved
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled()) // and still unsaved
	})

	it("clears the unsaved state when nothing was edited after the save was sent", async () => {
		const requestId = await renderAndSave()

		answerSave(requestId, { success: true })

		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())
		expect(input().value).toBe("13")
	})

	it("sends the edit that was made while the save was pending with the next save", async () => {
		const requestId = await renderAndSave()
		increment() // 14
		await waitFor(() => expect(input().value).toBe("14"))
		answerSave(requestId, { success: true })
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		vi.mocked(vscode.postMessage).mockClear()

		fireEvent.click(screen.getByTestId("save-button"))

		const save = vi
			.mocked(vscode.postMessage)
			.mock.calls.map((call) => call[0] as { type: string; updatedSettings?: Record<string, unknown> })
			.find((message) => message.type === "updateSettings")
		expect(save?.updatedSettings?.terminalFontSize).toBe(14)
	})
})
