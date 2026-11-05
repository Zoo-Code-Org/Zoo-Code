import { act, fireEvent, screen, waitFor } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"

import { renderWithExtensionState } from "@/utils/test-utils"

import SettingsView from "../SettingsView"

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
})
