import { act, fireEvent, screen, waitFor } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { renderWithExtensionState } from "@/utils/test-utils"
import { vscode } from "@src/utils/vscode"

import SettingsView, { SAVE_ANSWER_TIMEOUT_MS } from "../SettingsView"
import { answerSave, lastSaveRequestId, saveAndConfirm } from "./saveAcknowledgement"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@/utils/TelemetryClient", () => ({ telemetryClient: { capture: vi.fn() } }))

const postMessage = vi.mocked(vscode.postMessage)

const posted = (type: string) =>
	postMessage.mock.calls.map((call) => call[0] as { type: string; requestId?: string }).filter((m) => m.type === type)

const renderTab = (targetSection: string) =>
	renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection={targetSection} />, {
		queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
	})

/** Edit a time or date setting (the relative times checkbox, on by default) so Save becomes available. */
const editDisplaySetting = async () => {
	fireEvent.click(await screen.findByTestId("relative-times-checkbox"))
	await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
}

describe("SettingsView – saving the time and date settings", () => {
	beforeEach(() => postMessage.mockClear())
	afterEach(() => vi.useRealTimers())

	it("sends a request id, and keeps the edit unsaved and Save disabled until the host answers", async () => {
		renderTab("language")
		await editDisplaySetting()

		fireEvent.click(screen.getByTestId("save-button"))

		expect(posted("updateSettings")[0].requestId).toMatch(/^settings-save-[a-z0-9]+-\d+$/)
		expect(screen.getByTestId("save-button")).toBeDisabled()
		// The messages that never waited for an answer still go out as before.
		expect(posted("upsertApiConfiguration")).toHaveLength(1)
	})

	it("clears the unsaved flag once the host confirms the save", async () => {
		renderTab("language")
		await editDisplaySetting()

		saveAndConfirm(postMessage)

		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())
		expect(posted("updateSettings")).toHaveLength(1)
	})

	it("keeps the edit unsaved and Save available after a failed save, and a retry sends a new request", async () => {
		renderTab("language")
		await editDisplaySetting()
		fireEvent.click(screen.getByTestId("save-button"))
		const firstId = lastSaveRequestId(postMessage)

		answerSave(firstId, { success: false, error: "storage unavailable" })

		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		expect(screen.getByTestId("relative-times-checkbox")).not.toBeChecked() // the edit is still there
		fireEvent.click(screen.getByTestId("save-button"))
		expect(lastSaveRequestId(postMessage)).not.toBe(firstId)
		expect(posted("updateSettings")).toHaveLength(2)
	})

	it("keeps the unsaved flag when the user edited again while the save waited", async () => {
		renderTab("language")
		await editDisplaySetting()
		fireEvent.click(screen.getByTestId("save-button"))
		const id = lastSaveRequestId(postMessage)

		fireEvent.click(screen.getByTestId("relative-times-checkbox")) // an edit after the save was sent
		answerSave(id, { success: true })

		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
	})

	it("ignores the answer to another request", async () => {
		renderTab("language")
		await editDisplaySetting()
		fireEvent.click(screen.getByTestId("save-button"))

		answerSave("settings-save-someone-else-1", { success: true })

		expect(screen.getByTestId("save-button")).toBeDisabled() // still waiting for its own answer
		answerSave(lastSaveRequestId(postMessage), { success: false })
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
	})

	it("treats a save the host never answers as failed after the timeout: the edit stays and Save works again", async () => {
		renderTab("language")
		await editDisplaySetting()
		vi.useFakeTimers() // after the render: the queries need real timers, the save's timeout does not
		fireEvent.click(screen.getByTestId("save-button"))
		expect(screen.getByTestId("save-button")).toBeDisabled()

		await act(async () => {
			await vi.advanceTimersByTimeAsync(SAVE_ANSWER_TIMEOUT_MS)
		})

		expect(screen.getByTestId("save-button")).toBeEnabled()
	})

	it("is unchanged for a save that touches no time or date setting: no request id, and the flag clears at once", async () => {
		renderTab("ui")
		fireEvent.click(await screen.findByTestId("collapse-thinking-checkbox"))
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())

		fireEvent.click(screen.getByTestId("save-button"))

		expect(posted("updateSettings")[0].requestId).toBeUndefined()
		expect(screen.getByTestId("save-button")).toBeDisabled() // cleared without waiting for the host
	})
})
