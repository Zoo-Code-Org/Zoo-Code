import { fireEvent, screen, waitFor } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"

import { renderWithExtensionState } from "@/utils/test-utils"
import * as latestRefHook from "@src/hooks/useLatestRef"

import SettingsView from "../SettingsView"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/utils/TelemetryClient", () => ({ telemetryClient: { capture: vi.fn() } }))

// What a save result is compared with is read from refs that follow the latest commit (see `useLatestRef`): the view must
// keep its edited state and its edit count in them.
describe("SettingsView – the values that a save result is compared with", () => {
	it("keeps the edited form and the edit count in refs that follow the commit", async () => {
		const useLatestRef = vi.spyOn(latestRefHook, "useLatestRef")
		renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="ui" />, {
			queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
		})
		const counts = () =>
			useLatestRef.mock.calls.map(([value]) => value).filter((value) => typeof value === "number")
		const forms = () =>
			useLatestRef.mock.calls
				.map(([value]) => value)
				.filter((value) => typeof value === "object" && value !== null)

		const editsBefore = Math.max(...counts().map(Number))
		fireEvent.click(await screen.findByTestId("appearance-terminalFontSize-increment"))
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())

		expect(Math.max(...counts().map(Number))).toBeGreaterThan(editsBefore)
		expect(forms().some((form) => (form as { terminalFontSize?: number }).terminalFontSize === 13)).toBe(true)
		useLatestRef.mockRestore()
	})
})
