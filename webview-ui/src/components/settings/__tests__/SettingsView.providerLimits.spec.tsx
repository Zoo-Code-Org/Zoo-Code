import { act, screen, waitFor } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { renderWithExtensionState } from "@/utils/test-utils"
import { vscode } from "@src/utils/vscode"

import SettingsView from "../SettingsView"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@/utils/TelemetryClient", () => ({ telemetryClient: { capture: vi.fn() } }))

const postMessage = vi.mocked(vscode.postMessage)

const posted = (type: string) =>
	postMessage.mock.calls.map((call) => call[0] as { type: string; requestId?: string }).filter((m) => m.type === type)

describe("SettingsView – provider limits", () => {
	beforeEach(() => postMessage.mockClear())

	it("asks the host for the limits once, when the Usage tab is shown, and not while the tabs are indexed", async () => {
		renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="usage" />, {
			queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
		})

		// Settings mounts every tab once to index it (the Usage tab included) before it shows the one that was asked for.
		await waitFor(() => expect(screen.getByTestId("provider-limits")).toBeTruthy())
		await waitFor(() => expect(posted("requestProviderQuotas")).toHaveLength(1))
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50))
		})

		// One request, from the tab the user is looking at; the indexing pass sent none (and so cancelled none).
		expect(posted("requestProviderQuotas")).toHaveLength(1)
		expect(posted("cancelProviderQuotas")).toHaveLength(0)
	})

	it("sends no request at all when another tab is shown", async () => {
		renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="about" />, {
			queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
		})

		await waitFor(() => expect(screen.getByTestId("save-button")).toBeTruthy())
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50))
		})

		expect(posted("requestProviderQuotas")).toHaveLength(0)
		expect(posted("cancelProviderQuotas")).toHaveLength(0)
	})
})
