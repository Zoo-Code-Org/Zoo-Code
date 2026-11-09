import { act, fireEvent, screen, waitFor } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"

import { providerIdentifiers } from "@roo-code/types"

import { renderWithExtensionState } from "@/utils/test-utils"

import SettingsView from "../SettingsView"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/utils/TelemetryClient", () => ({ telemetryClient: { capture: vi.fn() } }))

const hostPosts = (state: Record<string, unknown>) =>
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state } }))
	})

const renderImageSettings = () =>
	renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection="experimental" />, {
		queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
		state: {
			experiments: { imageGeneration: true },
			imageGenerationProvider: providerIdentifiers.openrouter,
			openRouterImageApiKey: "initial-key",
		},
	})

// An import was answered with a value that failed to be stored, and a late refresh then brings the stored one: an edit
// made through a dedicated setter in between (not the generic one) has to be kept, as well.
const answeredThenLate = (key: string, answered: unknown, stored: unknown) => {
	hostPosts({ [key]: answered, settingsImportRefreshedAt: 1_000, settingsImportStoredKeys: [key] })
	return () =>
		hostPosts({
			[key]: stored,
			settingsImportRefreshedAt: 2_000,
			settingsImportStoredKeys: [key],
			settingsImportRefreshIsLate: true,
		})
}

describe("SettingsView – a late import refresh keeps an edit made through a dedicated setter", () => {
	const placeholder = "settings:experimental.IMAGE_GENERATION.openRouterApiKeyPlaceholder"
	const apiKeyField = () => screen.getByPlaceholderText(placeholder) as HTMLInputElement

	const typeApiKey = (value: string) => {
		const field = apiKeyField()
		field.value = value
		fireEvent.input(field, { target: { value } })
	}

	it("keeps the OpenRouter image key the user typed", async () => {
		renderImageSettings()
		await screen.findByPlaceholderText(placeholder)
		const late = answeredThenLate("openRouterImageApiKey", "failed-key", "stored-key")
		await waitFor(() => expect(apiKeyField().value).toBe("failed-key"))

		typeApiKey("my-key")
		await waitFor(() => expect(apiKeyField().value).toBe("my-key"))
		late()

		expect(apiKeyField().value).toBe("my-key")
		expect(screen.getByTestId("save-button")).toBeEnabled()
	})

	it("takes the stored OpenRouter image key when the user did not edit it", async () => {
		renderImageSettings()
		await screen.findByPlaceholderText(placeholder)
		const late = answeredThenLate("openRouterImageApiKey", "failed-key", "stored-key")
		await waitFor(() => expect(apiKeyField().value).toBe("failed-key"))

		late()

		await waitFor(() => expect(apiKeyField().value).toBe("stored-key"))
	})
})
