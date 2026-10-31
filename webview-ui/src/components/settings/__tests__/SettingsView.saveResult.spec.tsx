import { fireEvent, screen, waitFor } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { renderWithExtensionState } from "@/utils/test-utils"
import { vscode } from "@src/utils/vscode"

import SettingsView from "../SettingsView"
import { answerSave, lastSaveRequestId } from "./saveAcknowledgement"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@/utils/TelemetryClient", () => ({ telemetryClient: { capture: vi.fn() } }))

const postMessage = vi.mocked(vscode.postMessage)

const posted = (type: string) =>
	postMessage.mock.calls.map((call) => call[0] as { type: string }).filter((message) => message.type === type)

const renderUiTab = () =>
	renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="ui" />, {
		queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
	})

/** Edit an appearance value (the terminal font size, 12 by default) so Save becomes available. */
const makeAnEdit = async () => {
	fireEvent.click(await screen.findByTestId("appearance-terminalFontSize-increment"))
	await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
}

/** Edit a setting that is not an appearance value, so Save becomes available. */
const makeAnOtherEdit = async () => {
	fireEvent.click(await screen.findByTestId("collapse-thinking-checkbox"))
	await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
}

describe("SettingsView – save acknowledgement", () => {
	beforeEach(() => postMessage.mockClear())

	it("sends the settings with a request id, plus the API configuration, telemetry and debug as before", async () => {
		renderUiTab()
		await makeAnEdit()

		fireEvent.click(screen.getByTestId("save-button"))

		const [save] = posted("updateSettings") as Array<{ type: string; requestId?: string }>
		expect(save.requestId).toMatch(/^settings-save-[a-z0-9]+-\d+$/)
		// These do not wait for the host's answer, exactly as before the acknowledgement existed.
		expect(posted("upsertApiConfiguration")).toHaveLength(1)
		expect(posted("telemetrySetting")).toHaveLength(1)
		expect(posted("debugSetting")).toHaveLength(1)
		// Save stays unavailable, and the edit stays unsaved, until the host answers.
		expect(screen.getByTestId("save-button")).toBeDisabled()
	})

	it("clears the unsaved flag once the host confirms, and sends nothing more", async () => {
		renderUiTab()
		await makeAnEdit()
		fireEvent.click(screen.getByTestId("save-button"))

		answerSave(lastSaveRequestId(postMessage), { success: true })

		// Saved: nothing left to save.
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())
		expect(posted("upsertApiConfiguration")).toHaveLength(1)
		expect(posted("updateSettings")).toHaveLength(1)
	})

	it("keeps the edits and the unsaved flag when the host reports a failure, so the user can retry", async () => {
		renderUiTab()
		await makeAnEdit()
		fireEvent.click(screen.getByTestId("save-button"))

		answerSave(lastSaveRequestId(postMessage), { success: false, error: "disk full" })

		// The edit is still there, still unsaved, and Save is available again.
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		// The stepper started at 12; the user raised it, and that edit survives the failed save.
		expect((screen.getByTestId("appearance-terminalFontSize-input") as HTMLInputElement).value).toBe("13")

		// Retrying sends a fresh request with a new id.
		const firstId = lastSaveRequestId(postMessage)
		fireEvent.click(screen.getByTestId("save-button"))
		expect(lastSaveRequestId(postMessage)).not.toBe(firstId)
		expect(posted("updateSettings")).toHaveLength(2)
	})

	describe("a save that changes no appearance value", () => {
		it("is sent without a request id and behaves as it always did: nothing to wait for", async () => {
			renderUiTab()
			await makeAnOtherEdit()

			fireEvent.click(screen.getByTestId("save-button"))

			const [save] = posted("updateSettings") as Array<{ type: string; requestId?: string }>
			expect(save.requestId).toBeUndefined()
			expect(posted("upsertApiConfiguration")).toHaveLength(1)
			// The unsaved flag is cleared at once, so Save is idle straight away.
			expect(screen.getByTestId("save-button")).toBeDisabled()
			// ...and a further edit enables it again, with no answer from the host needed in between.
			fireEvent.click(screen.getByTestId("collapse-thinking-checkbox"))
			await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		})

		it("ignores any save result, since it did not ask for one", async () => {
			renderUiTab()
			await makeAnOtherEdit()
			fireEvent.click(screen.getByTestId("save-button"))
			fireEvent.click(screen.getByTestId("collapse-thinking-checkbox"))
			await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())

			answerSave("settings-save-never-issued", { success: false, error: "nope" })

			expect(screen.getByTestId("save-button")).toBeEnabled()
		})

		it("also waits for the host when an appearance value is edited together with other settings", async () => {
			renderUiTab()
			await makeAnOtherEdit()
			fireEvent.click(await screen.findByTestId("appearance-spacingScale-increment"))

			fireEvent.click(screen.getByTestId("save-button"))

			const [save] = posted("updateSettings") as Array<{ type: string; requestId?: string }>
			expect(save.requestId).toMatch(/^settings-save-[a-z0-9]+-\d+$/)
			expect(screen.getByTestId("save-button")).toBeDisabled()
			answerSave(save.requestId, { success: false })
			await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		})

		it("treats a reset of an appearance value as an appearance edit", async () => {
			renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="ui" />, {
				state: { terminalFontSize: 20 },
				queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
			})
			fireEvent.click(await screen.findByTestId("appearance-terminalFontSize-reset"))
			await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())

			fireEvent.click(screen.getByTestId("save-button"))

			const [save] = posted("updateSettings") as Array<{ type: string; requestId?: string }>
			expect(save.requestId).toMatch(/^settings-save-[a-z0-9]+-\d+$/)
		})
	})

	it("does not send a second save while one is waiting for the host", async () => {
		renderUiTab()
		await makeAnEdit()

		fireEvent.click(screen.getByTestId("save-button"))
		fireEvent.click(screen.getByTestId("save-button"))
		fireEvent.click(screen.getByTestId("save-button"))

		expect(posted("updateSettings")).toHaveLength(1)
		expect(posted("upsertApiConfiguration")).toHaveLength(1)
	})

	it("ignores an answer for a different save, or one that arrives with no id", async () => {
		renderUiTab()
		await makeAnEdit()
		fireEvent.click(screen.getByTestId("save-button"))

		answerSave("settings-save-never-issued", { success: true })
		answerSave(undefined, { success: true })
		expect(screen.getByTestId("save-button")).toBeDisabled()

		// The real answer still works afterwards: the edit is saved and Save is idle.
		answerSave(lastSaveRequestId(postMessage), { success: false })
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
	})

	it("ignores a save result when nothing is being saved", async () => {
		renderUiTab()
		await makeAnEdit()
		answerSave("settings-save-never-issued", { success: true })
		// The unsaved edit is untouched.
		expect(screen.getByTestId("save-button")).toBeEnabled()
	})

	it("keeps an edit made while the save was pending unsaved, so Save stays available for it", async () => {
		renderUiTab()
		await makeAnEdit()
		fireEvent.click(screen.getByTestId("save-button"))

		// A second edit lands before the host answers; it is not in what was sent.
		fireEvent.click(screen.getByTestId("enter-behavior-checkbox"))
		answerSave(lastSaveRequestId(postMessage), { success: true })

		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
	})

	it("does nothing, and does not fail, when the answer arrives after the view is gone", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			const view = renderUiTab()
			await makeAnEdit()
			fireEvent.click(screen.getByTestId("save-button"))
			const id = lastSaveRequestId(postMessage)
			view.unmount()

			answerSave(id, { success: true })
			expect(posted("upsertApiConfiguration")).toHaveLength(1)
			expect(consoleError).not.toHaveBeenCalled()
		} finally {
			consoleError.mockRestore()
		}
	})

	it("never reuses a request id across mounts, so an earlier save's answer cannot complete a later one", async () => {
		const first = renderUiTab()
		await makeAnEdit()
		fireEvent.click(screen.getByTestId("save-button"))
		const earlierId = lastSaveRequestId(postMessage)
		first.unmount()

		renderUiTab()
		await makeAnEdit()
		fireEvent.click(screen.getByTestId("save-button"))
		const laterId = lastSaveRequestId(postMessage)
		expect(laterId).not.toBe(earlierId)

		// The earlier save's answer arrives while the new save is pending: it must not complete it.
		answerSave(earlierId, { success: true })
		expect(screen.getByTestId("save-button")).toBeDisabled()

		answerSave(laterId, { success: false })
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
	})
})
