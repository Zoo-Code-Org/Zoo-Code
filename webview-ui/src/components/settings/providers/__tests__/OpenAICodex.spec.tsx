import React from "react"

import {
	OPEN_AI_CODEX_SERVICE_TIER_KEY,
	OpenAiCodexServiceTier,
	providerIdentifiers,
	type ProviderSettings,
} from "@roo-code/types"

import { fireEvent, render, screen } from "@/utils/test-utils"
import { vscode } from "@src/utils/vscode"

import { OpenAICodex } from "../OpenAICodex"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) =>
			({
				"settings:openAiCodexSpeed.label": "Speed",
				"settings:openAiCodexWebSocket.label": "Use WebSocket",
				"settings:openAiCodexSpeed.tooltip":
					"Fast uses Codex priority processing for about 1.5x speed and consumes more subscription quota.",
				"settings:openAiCodexSpeed.standard": "Standard",
				"settings:openAiCodexSpeed.fast": "Fast (1.5x speed, increased usage)",
			})[key] ?? key,
	}),
}))

vi.mock("@src/components/ui", () => ({
	Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
		<button {...props}>{children}</button>
	),
	Select: ({ children, value, onValueChange }: any) => (
		<select aria-label="Speed" value={value} onChange={(event) => onValueChange(event.target.value)}>
			{children}
		</select>
	),
	SelectContent: ({ children }: any) => <>{children}</>,
	SelectItem: ({ children, value }: any) => <option value={value}>{children}</option>,
	SelectTrigger: ({ children }: any) => <>{children}</>,
	SelectValue: () => null,
	StandardTooltip: ({ children, content }: any) => <span title={content}>{children}</span>,
}))

vi.mock("../../ModelPicker", () => ({
	ModelPicker: () => <div data-testid="model-picker" />,
}))

vi.mock("../OpenAICodexRateLimitDashboard", () => ({
	OpenAICodexRateLimitDashboard: () => null,
}))

vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

describe("OpenAICodex speed selector", () => {
	const renderSelector = (apiConfiguration: ProviderSettings, setApiConfigurationField = vi.fn()) => {
		render(<OpenAICodex apiConfiguration={apiConfiguration} setApiConfigurationField={setApiConfigurationField} />)
		return { setApiConfigurationField, selector: screen.getByRole("combobox", { name: "Speed" }) }
	}

	it("defaults to Standard and clearly explains the Fast quota trade-off", () => {
		const { selector } = renderSelector({ apiProvider: providerIdentifiers.openaiCodex })

		expect(selector).toHaveValue(OpenAiCodexServiceTier.Default)
		expect(screen.getByRole("option", { name: "Standard" })).toBeInTheDocument()
		expect(screen.getByRole("option", { name: "Fast (1.5x speed, increased usage)" })).toBeInTheDocument()
		expect(
			screen.getByTitle(
				"Fast uses Codex priority processing for about 1.5x speed and consumes more subscription quota.",
			),
		).toBeInTheDocument()
	})

	it("selects Fast from a saved preference and persists changes through the settings callback", () => {
		const { selector, setApiConfigurationField } = renderSelector({
			apiProvider: providerIdentifiers.openaiCodex,
			[OPEN_AI_CODEX_SERVICE_TIER_KEY]: OpenAiCodexServiceTier.Priority,
		})
		const postMessage = vi.mocked(vscode.postMessage)

		expect(selector).toHaveValue(OpenAiCodexServiceTier.Priority)

		fireEvent.change(selector, { target: { value: OpenAiCodexServiceTier.Default } })
		expect(setApiConfigurationField).toHaveBeenLastCalledWith(
			OPEN_AI_CODEX_SERVICE_TIER_KEY,
			OpenAiCodexServiceTier.Default,
		)

		fireEvent.change(selector, { target: { value: OpenAiCodexServiceTier.Priority } })
		expect(setApiConfigurationField).toHaveBeenLastCalledWith(
			OPEN_AI_CODEX_SERVICE_TIER_KEY,
			OpenAiCodexServiceTier.Priority,
		)
		expect(postMessage).not.toHaveBeenCalled()
	})
})

describe("OpenAICodex WebSocket preference", () => {
	it.each([undefined, false, true])(
		"renders saved preference %s and edits through the cached settings callback",
		(enabled) => {
			const setApiConfigurationField = vi.fn()
			const configuration: ProviderSettings = {
				apiProvider: providerIdentifiers.openaiCodex,
				openAiCodexUseWebSocket: enabled,
			}
			render(<OpenAICodex apiConfiguration={configuration} setApiConfigurationField={setApiConfigurationField} />)
			const checkbox = screen.getByRole("checkbox", { name: "Use WebSocket" })
			if (enabled) expect(checkbox).toBeChecked()
			else expect(checkbox).not.toBeChecked()
			fireEvent.click(checkbox)
			expect(setApiConfigurationField).toHaveBeenLastCalledWith("openAiCodexUseWebSocket", !enabled)
			expect(configuration.openAiCodexUseWebSocket).toBe(enabled)
			expect(vscode.postMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ type: "upsertApiConfiguration" }),
			)
		},
	)
})
