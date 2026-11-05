import { act, fireEvent, screen, waitFor } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import { createRef } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { renderWithExtensionState } from "@/utils/test-utils"
import { vscode } from "@src/utils/vscode"

import SettingsView, {
	MAX_TIMED_OUT_SAVES,
	SAVE_ANSWER_TIMEOUT_MS,
	TIMED_OUT_SAVE_KEEP_MS,
	type SettingsViewRef,
} from "../SettingsView"
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

/** The extension host reports a new state, as when another webview or the host changes a saved value. */
const liveStateChange = (state: Record<string, unknown>) =>
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state } }))
	})

const lastUpdatedSettings = () =>
	(posted("updateSettings").at(-1) as { updatedSettings?: Record<string, unknown> } | undefined)?.updatedSettings ??
	{}

const appearanceKeys = ["interfaceFontScale", "terminalFontSize", "editorFontSize", "spacingScale"] as const

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

describe("SettingsView – which appearance values a save sends", () => {
	beforeEach(() => postMessage.mockClear())

	it("does not send a value that only differs because the live state changed, and asks for no acknowledgement", async () => {
		renderUiTab()
		await screen.findByTestId("appearance-terminalFontSize-input")

		liveStateChange({ terminalFontSize: 20 }) // another webview changed it; the user did not
		await makeAnOtherEdit()
		fireEvent.click(screen.getByTestId("save-button"))

		const sent = lastUpdatedSettings()
		for (const key of appearanceKeys) expect(sent).not.toHaveProperty(key)
		expect((posted("updateSettings").at(-1) as { requestId?: string }).requestId).toBeUndefined()
	})

	it("sends only the value the user edited, not another that the live state changed meanwhile", async () => {
		renderUiTab()
		await screen.findByTestId("appearance-terminalFontSize-input")

		liveStateChange({ editorFontSize: 18 }) // not edited here
		await makeAnEdit() // the terminal font size
		fireEvent.click(screen.getByTestId("save-button"))

		const sent = lastUpdatedSettings()
		expect(sent.terminalFontSize).toBe(13)
		expect(sent).not.toHaveProperty("editorFontSize")
		expect((posted("updateSettings").at(-1) as { requestId?: string }).requestId).toBeDefined()
	})

	it("sends nothing for a value that was edited and then put back to what is saved", async () => {
		renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="ui" />, {
			state: { terminalFontSize: 14 },
		})
		fireEvent.click(await screen.findByTestId("appearance-terminalFontSize-increment")) // 15
		fireEvent.click(screen.getByTestId("appearance-terminalFontSize-decrement")) // back to the saved 14
		await makeAnOtherEdit()
		fireEvent.click(screen.getByTestId("save-button"))

		for (const key of appearanceKeys) expect(lastUpdatedSettings()).not.toHaveProperty(key)
	})

	it("stops treating a value as an edit once its save was stored, so a later save does not send it again", async () => {
		renderUiTab()
		await makeAnEdit()
		fireEvent.click(screen.getByTestId("save-button"))
		answerSave(lastSaveRequestId(postMessage), { success: true })
		liveStateChange({ terminalFontSize: 25 }) // later, someone else changes it
		postMessage.mockClear()

		await makeAnOtherEdit()
		fireEvent.click(screen.getByTestId("save-button"))

		expect(lastUpdatedSettings()).not.toHaveProperty("terminalFontSize")
	})

	it("keeps a value edited again while the save was pending as an edit, and sends it with the next save", async () => {
		renderUiTab()
		await makeAnEdit() // 13
		fireEvent.click(screen.getByTestId("save-button"))
		fireEvent.click(screen.getByTestId("appearance-terminalFontSize-increment")) // 14, after what was sent
		answerSave(lastSaveRequestId(postMessage), { success: true })
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		postMessage.mockClear()

		fireEvent.click(screen.getByTestId("save-button"))

		expect(lastUpdatedSettings().terminalFontSize).toBe(14)
	})

	it("compares with what a save stored when the live state did not catch up, so a reset to the old value is still sent", async () => {
		renderUiTab()
		await makeAnEdit() // 13; the live state is unset and stays so: its refresh after the save never arrived
		fireEvent.click(screen.getByTestId("save-button"))
		answerSave(lastSaveRequestId(postMessage), { success: true })
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())
		postMessage.mockClear()

		fireEvent.click(screen.getByTestId("appearance-terminalFontSize-reset")) // back to unset, which is the stale live value
		fireEvent.click(screen.getByTestId("save-button"))

		expect(lastUpdatedSettings()).toHaveProperty("terminalFontSize", null)
	})

	it("keeps what a save stored for a value until that value's own live state changes, not another value's", async () => {
		renderUiTab()
		await makeAnEdit() // terminalFontSize 13
		fireEvent.click(screen.getByTestId("save-button"))
		answerSave(lastSaveRequestId(postMessage), { success: true }) // the live state never caught up
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())
		liveStateChange({ spacingScale: 90 }) // a different value changes in the live state
		postMessage.mockClear()

		fireEvent.click(screen.getByTestId("appearance-terminalFontSize-reset"))
		fireEvent.click(screen.getByTestId("save-button"))

		expect(lastUpdatedSettings()).toHaveProperty("terminalFontSize", null)
	})

	it("still sees an edit made after an import that happened while a save was waiting", async () => {
		renderUiTab()
		await makeAnEdit()
		fireEvent.click(screen.getByTestId("save-button"))
		liveStateChange({ settingsImportedAt: Date.now() }) // the import resets the form and the unsaved flag
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())

		fireEvent.click(await screen.findByTestId("appearance-terminalFontSize-increment")) // one more edit
		answerSave(lastSaveRequestId(postMessage), { success: true })

		// That edit was not in the saved request: it stays unsaved.
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
	})

	it("goes back to comparing with the live state once it has changed", async () => {
		renderUiTab()
		await makeAnEdit() // 13
		fireEvent.click(screen.getByTestId("save-button"))
		answerSave(lastSaveRequestId(postMessage), { success: true })
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())
		liveStateChange({ terminalFontSize: 20 }) // another webview stored 20
		postMessage.mockClear()

		fireEvent.change(screen.getByTestId("appearance-terminalFontSize-input"), { target: { value: "2" } })
		fireEvent.change(screen.getByTestId("appearance-terminalFontSize-input"), { target: { value: "20" } })
		fireEvent.blur(screen.getByTestId("appearance-terminalFontSize-input"))
		await makeAnOtherEdit()
		fireEvent.click(screen.getByTestId("save-button"))

		expect(lastUpdatedSettings()).not.toHaveProperty("terminalFontSize") // 20 is what is stored: nothing to send
	})

	it("keeps the edit after a failed save, so a retry sends it again", async () => {
		renderUiTab()
		await makeAnEdit()
		fireEvent.click(screen.getByTestId("save-button"))
		answerSave(lastSaveRequestId(postMessage), { success: false, error: "nope" })
		postMessage.mockClear()

		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		fireEvent.click(screen.getByTestId("save-button"))

		expect(lastUpdatedSettings().terminalFontSize).toBe(13)
	})
})

describe("SettingsView – leaving while an appearance save is pending", () => {
	beforeEach(() => postMessage.mockClear())

	const doneButton = () => screen.getByRole("button", { name: "settings:common.done" })

	it("disables Done while the save waits, and enables it again once the host has answered", async () => {
		renderUiTab()
		await makeAnEdit()
		expect(doneButton()).toBeEnabled()

		fireEvent.click(screen.getByTestId("save-button"))
		expect(doneButton()).toBeDisabled()

		answerSave(lastSaveRequestId(postMessage), { success: true })
		await waitFor(() => expect(doneButton()).toBeEnabled())
	})

	it("offers the discard dialog again after a failed save, which left the edits in place", async () => {
		renderUiTab()
		await makeAnEdit()
		fireEvent.click(screen.getByTestId("save-button"))
		answerSave(lastSaveRequestId(postMessage), { success: false, error: "nope" })
		await waitFor(() => expect(doneButton()).toBeEnabled())

		fireEvent.click(doneButton())

		expect(await screen.findByText("settings:unsavedChangesDialog.title")).toBeInTheDocument()
	})

	it("does not disable Done for a save that changes no appearance value", async () => {
		renderUiTab()
		await makeAnOtherEdit()

		fireEvent.click(screen.getByTestId("save-button"))

		expect(doneButton()).toBeEnabled()
	})

	describe("a request to leave that comes in while the save waits", () => {
		const renderWithRef = () => {
			const ref = createRef<SettingsViewRef>()
			renderWithExtensionState(<SettingsView ref={ref} onDone={vi.fn()} targetSection="ui" />)
			return ref
		}
		const dialog = () => screen.queryByText("settings:unsavedChangesDialog.title")

		it("is held, and goes ahead once the save was stored", async () => {
			const ref = renderWithRef()
			await makeAnEdit()
			fireEvent.click(screen.getByTestId("save-button"))
			const then = vi.fn()

			act(() => ref.current?.checkUnsaveChanges(then))
			expect(then).not.toHaveBeenCalled()
			expect(dialog()).not.toBeInTheDocument()

			answerSave(lastSaveRequestId(postMessage), { success: true })

			expect(then).toHaveBeenCalledTimes(1)
			expect(dialog()).not.toBeInTheDocument()
		})

		it("asks the user instead when the save failed, and goes ahead only if they discard", async () => {
			const ref = renderWithRef()
			await makeAnEdit()
			fireEvent.click(screen.getByTestId("save-button"))
			const then = vi.fn()
			act(() => ref.current?.checkUnsaveChanges(then))

			answerSave(lastSaveRequestId(postMessage), { success: false, error: "nope" })

			expect(then).not.toHaveBeenCalled()
			expect(await screen.findByText("settings:unsavedChangesDialog.title")).toBeInTheDocument()
			fireEvent.click(screen.getByText("settings:unsavedChangesDialog.discardButton"))
			expect(then).toHaveBeenCalledTimes(1)
		})

		it("asks the user when an edit was made meanwhile, because that edit was not saved", async () => {
			const ref = renderWithRef()
			await makeAnEdit()
			fireEvent.click(screen.getByTestId("save-button"))
			const then = vi.fn()
			act(() => ref.current?.checkUnsaveChanges(then))
			fireEvent.click(screen.getByTestId("appearance-terminalFontSize-increment")) // not in what was sent

			answerSave(lastSaveRequestId(postMessage), { success: true })

			expect(then).not.toHaveBeenCalled()
			expect(await screen.findByText("settings:unsavedChangesDialog.title")).toBeInTheDocument()
		})

		it("keeps only the latest of several requests", async () => {
			const ref = renderWithRef()
			await makeAnEdit()
			fireEvent.click(screen.getByTestId("save-button"))
			const first = vi.fn()
			const latest = vi.fn()
			act(() => {
				ref.current?.checkUnsaveChanges(first)
				ref.current?.checkUnsaveChanges(latest)
			})

			answerSave(lastSaveRequestId(postMessage), { success: true })

			expect(first).not.toHaveBeenCalled()
			expect(latest).toHaveBeenCalledTimes(1)
		})

		it("goes ahead at once when no save is pending and nothing is unsaved", () => {
			const ref = renderWithRef()
			const then = vi.fn()

			act(() => ref.current?.checkUnsaveChanges(then))

			expect(then).toHaveBeenCalledTimes(1)
		})
	})
})

describe("SettingsView – a save the host never answers", () => {
	beforeEach(() => {
		postMessage.mockClear()
		vi.useFakeTimers({ shouldAdvanceTime: true })
	})
	afterEach(() => vi.useRealTimers())

	const doneButton = () => screen.getByRole("button", { name: "settings:common.done" })

	it("unlocks the form after the wait, keeping the edits, so Save can be tried again", async () => {
		renderUiTab()
		await makeAnEdit()
		fireEvent.click(screen.getByTestId("save-button"))
		expect(screen.getByTestId("save-button")).toBeDisabled()
		expect(doneButton()).toBeDisabled()

		act(() => vi.advanceTimersByTime(SAVE_ANSWER_TIMEOUT_MS))

		expect(screen.getByTestId("save-button")).toBeEnabled()
		expect(doneButton()).toBeEnabled()
		postMessage.mockClear()
		fireEvent.click(screen.getByTestId("save-button"))
		expect(lastUpdatedSettings().terminalFontSize).toBe(13) // the edit was kept, and is sent again
	})

	it("does not unlock the form before the wait is over", async () => {
		renderUiTab()
		await makeAnEdit()
		fireEvent.click(screen.getByTestId("save-button"))

		act(() => vi.advanceTimersByTime(SAVE_ANSWER_TIMEOUT_MS - 1000))

		expect(screen.getByTestId("save-button")).toBeDisabled()
	})

	it("ignores an answer that arrives after the wait, so it cannot complete a later save", async () => {
		renderUiTab()
		await makeAnEdit()
		fireEvent.click(screen.getByTestId("save-button"))
		const lateId = lastSaveRequestId(postMessage)
		act(() => vi.advanceTimersByTime(SAVE_ANSWER_TIMEOUT_MS))

		fireEvent.click(screen.getByTestId("save-button")) // tries again: a new request
		expect(lastSaveRequestId(postMessage)).not.toBe(lateId)
		answerSave(lateId, { success: true }) // the first save answers, late

		expect(screen.getByTestId("save-button")).toBeDisabled() // the second save is still waiting
		answerSave(lastSaveRequestId(postMessage), { success: true })
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled()) // saved: nothing left to save
	})

	it("treats a held request to leave as after a failed save, when the wait is over", async () => {
		const ref = createRef<SettingsViewRef>()
		renderWithExtensionState(<SettingsView ref={ref} onDone={vi.fn()} targetSection="ui" />)
		await makeAnEdit()
		fireEvent.click(screen.getByTestId("save-button"))
		const then = vi.fn()
		act(() => ref.current?.checkUnsaveChanges(then))

		act(() => vi.advanceTimersByTime(SAVE_ANSWER_TIMEOUT_MS))

		expect(then).not.toHaveBeenCalled()
		expect(await screen.findByText("settings:unsavedChangesDialog.title")).toBeInTheDocument()
	})

	describe("the outcome of a save that was not answered is unknown", () => {
		const noteShown = () => screen.queryByTestId("save-outcome-unknown")

		const timeOutAfterAnEdit = async () => {
			renderUiTab()
			await makeAnEdit() // 13
			fireEvent.click(screen.getByTestId("save-button"))
			const id = lastSaveRequestId(postMessage)
			act(() => vi.advanceTimersByTime(SAVE_ANSWER_TIMEOUT_MS))
			return id
		}

		describe("how long, and how many, are kept", () => {
			const terminalFontSize = () =>
				(screen.getByTestId("appearance-terminalFontSize-input") as HTMLInputElement).value

			const discardTheEdit = async () => {
				fireEvent.click(doneButton())
				fireEvent.click(await screen.findByText("settings:unsavedChangesDialog.discardButton"))
				expect(terminalFontSize()).toBe("12")
			}

			it("forgets a save the host has not answered for long: its late answer is ignored, and no warning is shown", async () => {
				const id = await timeOutAfterAnEdit()
				act(() => vi.advanceTimersByTime(TIMED_OUT_SAVE_KEEP_MS))

				await discardTheEdit()
				answerSave(id, { success: true })

				expect(terminalFontSize()).toBe("12") // not brought up to date: nothing waits for that save any more
				fireEvent.click(screen.getByTestId("appearance-terminalFontSize-increment"))
				fireEvent.click(doneButton())
				expect(await screen.findByText("settings:unsavedChangesDialog.title")).toBeInTheDocument()
				expect(noteShown()).not.toBeInTheDocument()
			})

			it("still waits for a save before that time is over", async () => {
				const id = await timeOutAfterAnEdit()
				act(() => vi.advanceTimersByTime(TIMED_OUT_SAVE_KEEP_MS - SAVE_ANSWER_TIMEOUT_MS))

				await discardTheEdit()
				answerSave(id, { success: true })

				await waitFor(() => expect(terminalFontSize()).toBe("13"))
			})

			it("keeps only the latest saves, so a view that stays open does not collect them without end", async () => {
				renderUiTab()
				await makeAnEdit()
				const ids: Array<string | undefined> = []
				for (let attempt = 0; attempt <= MAX_TIMED_OUT_SAVES; attempt++) {
					fireEvent.click(screen.getByTestId("save-button"))
					ids.push(lastSaveRequestId(postMessage))
					act(() => vi.advanceTimersByTime(SAVE_ANSWER_TIMEOUT_MS))
				}
				expect(new Set(ids).size).toBe(MAX_TIMED_OUT_SAVES + 1)

				// The host answers (with a failure, which changes nothing) every save but the oldest, which was dropped to make
				// room: if it had been kept, the user would still be told that a save may complete.
				for (const id of ids.slice(1)) answerSave(id, { success: false, error: "nope" })

				fireEvent.click(doneButton())
				expect(await screen.findByText("settings:unsavedChangesDialog.title")).toBeInTheDocument()
				expect(noteShown()).not.toBeInTheDocument()
			})

			it("still tells the user about the saves it kept, up to the limit", async () => {
				renderUiTab()
				await makeAnEdit()
				const ids: Array<string | undefined> = []
				for (let attempt = 0; attempt < MAX_TIMED_OUT_SAVES; attempt++) {
					fireEvent.click(screen.getByTestId("save-button"))
					ids.push(lastSaveRequestId(postMessage))
					act(() => vi.advanceTimersByTime(SAVE_ANSWER_TIMEOUT_MS))
				}
				for (const id of ids.slice(1)) answerSave(id, { success: false, error: "nope" })

				fireEvent.click(doneButton())

				expect(await screen.findByText("settings:unsavedChangesDialog.title")).toBeInTheDocument()
				expect(noteShown()).toBeInTheDocument() // the first of them is still waited for
			})

			it("lets go of the timer of the save it kept when the view is closed", async () => {
				// Other parts of the view leave timers too: what closing the view takes away is compared with a view that kept
				// no save, and the difference is the timer of the one that was kept.
				const timersTakenAwayByClosing = (view: { unmount: () => void }) => {
					const before = vi.getTimerCount()
					view.unmount()
					return before - vi.getTimerCount()
				}
				const withoutASave = renderUiTab()
				await makeAnEdit()
				const takenWithoutASave = timersTakenAwayByClosing(withoutASave)

				const withASave = renderUiTab()
				await makeAnEdit()
				fireEvent.click(screen.getByTestId("save-button"))
				act(() => vi.advanceTimersByTime(SAVE_ANSWER_TIMEOUT_MS))

				expect(timersTakenAwayByClosing(withASave)).toBe(takenWithoutASave + 1)
			})
		})

		it("tells the user in the discard dialog that the save may still complete", async () => {
			await timeOutAfterAnEdit()

			fireEvent.click(doneButton())

			expect(await screen.findByText("settings:unsavedChangesDialog.title")).toBeInTheDocument()
			expect(noteShown()).toHaveTextContent("settings:unsavedChangesDialog.saveMayComplete")
		})

		it("does not say that after a save that failed", async () => {
			renderUiTab()
			await makeAnEdit()
			fireEvent.click(screen.getByTestId("save-button"))
			answerSave(lastSaveRequestId(postMessage), { success: false, error: "nope" })
			await waitFor(() => expect(doneButton()).toBeEnabled())

			fireEvent.click(doneButton())

			expect(await screen.findByText("settings:unsavedChangesDialog.title")).toBeInTheDocument()
			expect(noteShown()).not.toBeInTheDocument()
		})

		it("brings the form up to date when the late answer says the save was stored, even after the edits were discarded", async () => {
			const id = await timeOutAfterAnEdit()
			fireEvent.click(doneButton())
			fireEvent.click(await screen.findByText("settings:unsavedChangesDialog.discardButton"))
			expect((screen.getByTestId("appearance-terminalFontSize-input") as HTMLInputElement).value).toBe("12") // discarded

			answerSave(id, { success: true }) // the host stored 13 after all

			await waitFor(() =>
				expect((screen.getByTestId("appearance-terminalFontSize-input") as HTMLInputElement).value).toBe("13"),
			)
			expect(screen.getByTestId("save-button")).toBeDisabled() // nothing is unsaved
		})

		it("leaves a value the user is editing again as it is, but compares it with what was stored", async () => {
			const id = await timeOutAfterAnEdit()
			fireEvent.click(screen.getByTestId("appearance-terminalFontSize-increment")) // 14, edited after the save

			answerSave(id, { success: true })

			expect((screen.getByTestId("appearance-terminalFontSize-input") as HTMLInputElement).value).toBe("14")
			expect(screen.getByTestId("save-button")).toBeEnabled()
			postMessage.mockClear()
			fireEvent.click(screen.getByTestId("appearance-terminalFontSize-decrement")) // back to 13, which is stored now
			await makeAnOtherEdit()
			fireEvent.click(screen.getByTestId("save-button"))
			expect(lastUpdatedSettings()).not.toHaveProperty("terminalFontSize")
		})

		it("clears the unsaved flag when a late success stores the edit that was kept, and nothing else changed", async () => {
			const id = await timeOutAfterAnEdit() // 13 kept in the form, unanswered

			answerSave(id, { success: true })

			await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())
			fireEvent.click(doneButton())
			expect(screen.queryByText("settings:unsavedChangesDialog.title")).not.toBeInTheDocument()
		})

		it("keeps the unsaved flag when something else was changed after that save was sent", async () => {
			const id = await timeOutAfterAnEdit()
			fireEvent.click(await screen.findByTestId("collapse-thinking-checkbox")) // another change, after the save

			answerSave(id, { success: true })

			expect(screen.getByTestId("save-button")).toBeEnabled()
		})

		it("stops counting the stored value as an edit after a late success, so a later save does not send it again", async () => {
			const id = await timeOutAfterAnEdit()
			answerSave(id, { success: true })
			liveStateChange({ terminalFontSize: 20 }) // another webview stores 20 later
			postMessage.mockClear()

			await makeAnOtherEdit()
			fireEvent.click(screen.getByTestId("save-button"))

			expect(lastUpdatedSettings()).not.toHaveProperty("terminalFontSize")
		})

		it("sends a reset to the live value while an earlier save of that value is unanswered, because it may still store", async () => {
			await timeOutAfterAnEdit() // 13 sent, never answered; the live value is still unset
			fireEvent.click(screen.getByTestId("appearance-terminalFontSize-reset")) // back to unset, equal to the live value
			postMessage.mockClear()

			fireEvent.click(screen.getByTestId("save-button"))

			expect(lastUpdatedSettings()).toHaveProperty("terminalFontSize", null)
		})

		it("shows a value as unset when the late success is for a reset", async () => {
			renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="ui" />, {
				state: { terminalFontSize: 20 },
				queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
			})
			fireEvent.click(await screen.findByTestId("appearance-terminalFontSize-reset"))
			await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
			fireEvent.click(screen.getByTestId("save-button"))
			const id = lastSaveRequestId(postMessage)
			expect(lastUpdatedSettings()).toHaveProperty("terminalFontSize", null)
			act(() => vi.advanceTimersByTime(SAVE_ANSWER_TIMEOUT_MS))

			answerSave(id, { success: true })

			// Stored as unset (null on the wire): the field shows the fallback again, and nothing is left unsaved.
			expect((screen.getByTestId("appearance-terminalFontSize-input") as HTMLInputElement).value).toBe("12")
			await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())
		})

		it("keeps a value the user edited again after the save was sent when its late success arrives", async () => {
			const id = await timeOutAfterAnEdit() // 13 sent, unanswered
			fireEvent.click(screen.getByTestId("appearance-terminalFontSize-increment")) // 14, an edit made after the send

			answerSave(id, { success: true })

			// The edit is not what was stored: it stays in the form, and is still an unsaved change.
			expect((screen.getByTestId("appearance-terminalFontSize-input") as HTMLInputElement).value).toBe("14")
			expect(screen.getByTestId("save-button")).toBeEnabled()
		})

		it("does not let a late answer overwrite a value that a newer save has stored", async () => {
			const first = await timeOutAfterAnEdit() // 13, unanswered
			fireEvent.click(screen.getByTestId("appearance-terminalFontSize-increment")) // 14
			fireEvent.click(screen.getByTestId("save-button"))
			const second = lastSaveRequestId(postMessage)
			expect(second).not.toBe(first)
			answerSave(second, { success: true })

			answerSave(first, { success: true }) // the old save answers last

			expect((screen.getByTestId("appearance-terminalFontSize-input") as HTMLInputElement).value).toBe("14")
		})

		it("does nothing for a late answer that says the save failed, and stops saying the save may complete", async () => {
			const id = await timeOutAfterAnEdit()

			answerSave(id, { success: false, error: "nope" })

			expect((screen.getByTestId("appearance-terminalFontSize-input") as HTMLInputElement).value).toBe("13")
			fireEvent.click(doneButton())
			expect(await screen.findByText("settings:unsavedChangesDialog.title")).toBeInTheDocument()
			expect(noteShown()).not.toBeInTheDocument()
		})

		it("ignores an answer to a request it never gave up on", async () => {
			await timeOutAfterAnEdit()

			answerSave("settings-save-never-issued", { success: true })

			expect((screen.getByTestId("appearance-terminalFontSize-input") as HTMLInputElement).value).toBe("13")
			fireEvent.click(doneButton())
			expect(noteShown()).toBeInTheDocument() // still unknown
		})
	})

	it("does nothing when the answer came in time and the wait would have ended later", async () => {
		renderUiTab()
		await makeAnEdit()
		fireEvent.click(screen.getByTestId("save-button"))
		answerSave(lastSaveRequestId(postMessage), { success: true })

		act(() => vi.advanceTimersByTime(SAVE_ANSWER_TIMEOUT_MS * 2))

		expect(screen.queryByText("settings:unsavedChangesDialog.title")).not.toBeInTheDocument()
		expect(screen.getByTestId("save-button")).toBeDisabled() // nothing unsaved
	})
})
