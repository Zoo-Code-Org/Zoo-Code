import { act, fireEvent, screen, waitFor } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"

import { renderWithExtensionState } from "@/utils/test-utils"

import { vscode } from "@src/utils/vscode"

import SettingsView from "../SettingsView"
import { answerSave, lastSaveRequestId } from "./saveAcknowledgement"
import { withVscodeEditorFontSize } from "./vscodeEditorFontSize"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/utils/TelemetryClient", () => ({ telemetryClient: { capture: vi.fn() } }))

const renderUiTab = () =>
	renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="ui" />, {
		queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
	})

/** The extension host posts a state, as it does after an import that failed part of the way. */
const hostPosts = (state: Record<string, unknown>) =>
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state } }))
	})

const input = (key: string) => screen.getByTestId(`appearance-${key}-input`) as HTMLInputElement
const thinkingCheckbox = () => screen.getByTestId("collapse-thinking-checkbox") as HTMLInputElement

withVscodeEditorFontSize(12)

describe("SettingsView – the form after an import that failed part of the way", () => {
	it("takes the values that the import stored, and keeps the edit made to another setting", async () => {
		renderUiTab()
		fireEvent.click(await screen.findByTestId("collapse-thinking-checkbox"))
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		const editedChecked = thinkingCheckbox().checked

		hostPosts({ terminalFontSize: 16, settingsImportRefreshedAt: 1_000 })

		await waitFor(() => expect(input("terminalFontSize").value).toBe("16"))
		expect(thinkingCheckbox().checked).toBe(editedChecked) // the edit was not dropped
		expect(screen.getByTestId("save-button")).toBeEnabled() // and is still unsaved
	})

	it("does not change the form for a state that is not marked as the refresh of an import", async () => {
		renderUiTab()
		await screen.findByTestId("appearance-terminalFontSize-input")
		const before = input("terminalFontSize").value

		hostPosts({ terminalFontSize: 16 })

		expect(input("terminalFontSize").value).toBe(before)
	})

	it("replaces an edit made to a value that the import stored: what is stored is what the form shows", async () => {
		renderUiTab()
		fireEvent.click(await screen.findByTestId("appearance-terminalFontSize-increment"))
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())

		hostPosts({ terminalFontSize: 16, settingsImportRefreshedAt: 1_000 })

		await waitFor(() => expect(input("terminalFontSize").value).toBe("16"))
	})

	it("leaves a value that did not change with that state as the user has it", async () => {
		renderUiTab()
		fireEvent.click(await screen.findByTestId("appearance-spacingScale-increment"))
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		const edited = input("spacingScale").value

		hostPosts({ terminalFontSize: 16, settingsImportRefreshedAt: 1_000 })

		await waitFor(() => expect(input("terminalFontSize").value).toBe("16"))
		expect(input("spacingScale").value).toBe(edited)
	})

	it("takes a setting that the import says it stored even when the live value looks unchanged", async () => {
		renderUiTab()
		await screen.findByTestId("appearance-terminalFontSize-input")
		hostPosts({ terminalFontSize: 14 }) // the live value; the form does not follow it by itself
		fireEvent.click(screen.getByTestId("appearance-terminalFontSize-increment")) // 13, an edit
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		fireEvent.click(screen.getByTestId("save-button"))
		answerSave(lastSaveRequestId(vi.mocked(vscode.postMessage)), { success: true }) // stored, and no state followed
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())
		expect(input("terminalFontSize").value).toBe("13")

		// A failed import stored 14 again; the live value is 14 as it was, so nothing changed with the state.
		hostPosts({
			terminalFontSize: 14,
			settingsImportRefreshedAt: 1_000,
			settingsImportStoredKeys: ["terminalFontSize"],
		})

		await waitFor(() => expect(input("terminalFontSize").value).toBe("14"))

		// What a save stored is no longer what is stored: 13 is an edit again, and the next save sends it.
		fireEvent.click(screen.getByTestId("appearance-terminalFontSize-decrement"))
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		vi.mocked(vscode.postMessage).mockClear()
		fireEvent.click(screen.getByTestId("save-button"))
		const save = vi
			.mocked(vscode.postMessage)
			.mock.calls.map((call) => call[0] as { type: string; updatedSettings?: Record<string, unknown> })
			.find((message) => message.type === "updateSettings")
		expect(save?.updatedSettings?.terminalFontSize).toBe(13)
	})

	it("leaves that value as the form has it when the import does not say it stored it", async () => {
		renderUiTab()
		await screen.findByTestId("appearance-terminalFontSize-input")
		hostPosts({ terminalFontSize: 14 })
		fireEvent.click(screen.getByTestId("appearance-terminalFontSize-increment"))
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		fireEvent.click(screen.getByTestId("save-button"))
		answerSave(lastSaveRequestId(vi.mocked(vscode.postMessage)), { success: true })
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())

		hostPosts({ terminalFontSize: 14, settingsImportRefreshedAt: 1_000, settingsImportStoredKeys: ["mode"] })

		expect(input("terminalFontSize").value).toBe("13")
	})

	it("acts on each refresh once: the same mark on a later state changes nothing", async () => {
		renderUiTab()
		await screen.findByTestId("appearance-terminalFontSize-input")
		hostPosts({ terminalFontSize: 16, settingsImportRefreshedAt: 1_000 })
		await waitFor(() => expect(input("terminalFontSize").value).toBe("16"))
		fireEvent.click(screen.getByTestId("appearance-terminalFontSize-increment")) // the user edits it again: 17

		hostPosts({ terminalFontSize: 20, settingsImportRefreshedAt: 1_000 }) // another state, with the mark still on it

		expect(input("terminalFontSize").value).toBe("17")
	})

	it("acts on a later refresh again", async () => {
		renderUiTab()
		await screen.findByTestId("appearance-terminalFontSize-input")
		hostPosts({ terminalFontSize: 16, settingsImportRefreshedAt: 1_000 })
		await waitFor(() => expect(input("terminalFontSize").value).toBe("16"))

		hostPosts({ terminalFontSize: 20, settingsImportRefreshedAt: 2_000 })

		await waitFor(() => expect(input("terminalFontSize").value).toBe("20"))
	})

	describe("after the rollback of a write of the import that timed out (a late refresh)", () => {
		// The import was answered with the value that failed to be stored (16, which the host had cached): the form took it.
		// The rollback then put the stored value (14) back, and the host posts a state for it.
		const answeredWithFailedValue = async () => {
			renderUiTab()
			await screen.findByTestId("appearance-terminalFontSize-input")
			hostPosts({ terminalFontSize: 14 })
			hostPosts({
				terminalFontSize: 16,
				settingsImportRefreshedAt: 1_000,
				settingsImportStoredKeys: ["terminalFontSize"],
			})
			await waitFor(() => expect(input("terminalFontSize").value).toBe("16"))
		}
		const lateRefresh = (state: Record<string, unknown> = {}) =>
			hostPosts({
				terminalFontSize: 14,
				settingsImportRefreshedAt: 2_000,
				settingsImportStoredKeys: ["terminalFontSize"],
				settingsImportRefreshIsLate: true,
				...state,
			})

		it("takes the value that is really stored, instead of the one that failed", async () => {
			await answeredWithFailedValue()

			lateRefresh()

			await waitFor(() => expect(input("terminalFontSize").value).toBe("14"))
		})

		it("keeps an edit that was made to that setting since, and does not store the stale value", async () => {
			await answeredWithFailedValue()
			fireEvent.click(screen.getByTestId("appearance-terminalFontSize-increment")) // 17: the user's own edit
			await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())

			lateRefresh()

			expect(input("terminalFontSize").value).toBe("17")
			expect(screen.getByTestId("save-button")).toBeEnabled()
		})

		it("keeps an edit that was made to another setting since, and takes a changed one that was not edited", async () => {
			await answeredWithFailedValue()
			fireEvent.click(screen.getByTestId("appearance-spacingScale-increment"))
			await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
			const edited = input("spacingScale").value

			lateRefresh({ spacingScale: 100 }) // the live state of the other setting changed too

			await waitFor(() => expect(input("terminalFontSize").value).toBe("14"))
			expect(input("spacingScale").value).toBe(edited)
		})

		it("lets the next save send an edit made after the rollback, and not the failed value", async () => {
			await answeredWithFailedValue()
			lateRefresh()
			await waitFor(() => expect(input("terminalFontSize").value).toBe("14"))
			fireEvent.click(screen.getByTestId("appearance-terminalFontSize-decrement")) // 13
			await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
			vi.mocked(vscode.postMessage).mockClear()

			fireEvent.click(screen.getByTestId("save-button"))

			const save = vi
				.mocked(vscode.postMessage)
				.mock.calls.map((call) => call[0] as { type: string; updatedSettings?: Record<string, unknown> })
				.find((message) => message.type === "updateSettings")
			expect(save?.updatedSettings?.terminalFontSize).toBe(13)
		})

		it("takes the stored value when an unmarked state push reported it before the late refresh, if the user has not edited the setting", async () => {
			await answeredWithFailedValue() // the form took 16
			// The host cached 16 before its store settled, and the rollback has put 14 back: a state is pushed with 14.
			hostPosts({ terminalFontSize: 14 })
			expect(input("terminalFontSize").value).toBe("16") // an unmarked state does not change the form

			lateRefresh() // the live value did not change with this one: 14 was already there

			await waitFor(() => expect(input("terminalFontSize").value).toBe("14"))
		})

		it("does not send the failed value with the next save, when the setting had been edited before the import", async () => {
			renderUiTab()
			await screen.findByTestId("appearance-terminalFontSize-input")
			hostPosts({ terminalFontSize: 14 })
			fireEvent.click(screen.getByTestId("appearance-terminalFontSize-increment")) // 15: an edit made before the import
			await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
			hostPosts({
				terminalFontSize: 16, // the value that failed to be stored, as the host cached it
				settingsImportRefreshedAt: 1_000,
				settingsImportStoredKeys: ["terminalFontSize"],
			})
			await waitFor(() => expect(input("terminalFontSize").value).toBe("16"))
			hostPosts({ terminalFontSize: 14 }) // an unmarked push, with the rollback value
			lateRefresh()
			await waitFor(() => expect(input("terminalFontSize").value).toBe("14"))
			fireEvent.click(await screen.findByTestId("collapse-thinking-checkbox")) // an unrelated edit, to be saved
			await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
			vi.mocked(vscode.postMessage).mockClear()

			fireEvent.click(screen.getByTestId("save-button"))

			const save = vi
				.mocked(vscode.postMessage)
				.mock.calls.map((call) => call[0] as { type: string; updatedSettings?: Record<string, unknown> })
				.find((message) => message.type === "updateSettings")
			expect(save?.updatedSettings).toBeDefined()
			// 16 is not sent: it was not stored, and it was not the user's edit any more.
			expect(save?.updatedSettings).not.toHaveProperty("terminalFontSize", 16)
			expect(save?.updatedSettings?.terminalFontSize).toBeUndefined()
		})

		it("does not count an edit made before the import as one once the form took the stored value, even if the late refresh never comes", async () => {
			renderUiTab()
			await screen.findByTestId("appearance-terminalFontSize-input")
			hostPosts({ terminalFontSize: 14 })
			fireEvent.click(screen.getByTestId("appearance-terminalFontSize-increment")) // 15: an edit made before the import
			await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
			hostPosts({
				terminalFontSize: 16,
				settingsImportRefreshedAt: 1_000,
				settingsImportStoredKeys: ["terminalFontSize"],
			})
			await waitFor(() => expect(input("terminalFontSize").value).toBe("16"))
			hostPosts({ terminalFontSize: 14 }) // the rollback value is pushed, unmarked, and the form still shows 16
			fireEvent.click(await screen.findByTestId("collapse-thinking-checkbox"))
			await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
			vi.mocked(vscode.postMessage).mockClear()

			fireEvent.click(screen.getByTestId("save-button"))

			const save = vi
				.mocked(vscode.postMessage)
				.mock.calls.map((call) => call[0] as { type: string; updatedSettings?: Record<string, unknown> })
				.find((message) => message.type === "updateSettings")
			expect(save?.updatedSettings).toBeDefined()
			expect(save?.updatedSettings?.terminalFontSize).toBeUndefined() // the form took 16: that is not an edit of the user
		})

		it("keeps an edit that was made after the answer through an unmarked push of the rollback value", async () => {
			await answeredWithFailedValue()
			fireEvent.click(screen.getByTestId("appearance-terminalFontSize-increment")) // 17, after the answer
			await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
			hostPosts({ terminalFontSize: 14 }) // an unmarked push with the rollback value

			lateRefresh()

			expect(input("terminalFontSize").value).toBe("17")
		})

		it("treats a later, ordinary refresh as ordinary: the host says it is not late, after one that was", async () => {
			await answeredWithFailedValue()
			lateRefresh() // the late refresh: the form took 14
			await waitFor(() => expect(input("terminalFontSize").value).toBe("14"))
			fireEvent.click(screen.getByTestId("appearance-terminalFontSize-increment")) // 15: an edit
			await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())

			// Another import that failed part of the way: a refresh of its own, with the flag sent as false.
			hostPosts({
				terminalFontSize: 20,
				settingsImportRefreshedAt: 3_000,
				settingsImportStoredKeys: ["terminalFontSize"],
				settingsImportRefreshIsLate: false,
			})

			await waitFor(() => expect(input("terminalFontSize").value).toBe("20")) // replaced, as an ordinary refresh does
		})

		it("is not what an ordinary refresh does: the same edit is replaced by the stored value there", async () => {
			await answeredWithFailedValue()
			fireEvent.click(screen.getByTestId("appearance-terminalFontSize-increment")) // 17
			await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())

			lateRefresh({ settingsImportRefreshIsLate: undefined })

			await waitFor(() => expect(input("terminalFontSize").value).toBe("14"))
		})
	})
})
