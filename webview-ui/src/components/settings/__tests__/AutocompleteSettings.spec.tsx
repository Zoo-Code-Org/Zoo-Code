import { render, screen, fireEvent } from "@testing-library/react"

import { AUTOCOMPLETE_DEFAULTS, type AutocompleteConfig } from "@roo-code/types"

import { TooltipProvider } from "../../ui/tooltip"
import { AutocompleteSettings } from "../AutocompleteSettings"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("../SearchableSetting", () => ({
	SearchableSetting: ({ children, settingId }: { children: React.ReactNode; settingId: string }) => (
		<div data-setting-id={settingId}>{children}</div>
	),
}))

const renderSettings = (props: Partial<React.ComponentProps<typeof AutocompleteSettings>> = {}) => {
	const setAutocompleteConfigField = vi.fn()
	const setAutocompleteApiKey = vi.fn()

	// Supplied by App.tsx in the real tree; the model picker's refresh tooltip needs it.
	const utils = render(
		<TooltipProvider>
			<AutocompleteSettings
				autocompleteConfig={{ enabled: true }}
				setAutocompleteConfigField={setAutocompleteConfigField}
				setAutocompleteApiKey={setAutocompleteApiKey}
				{...props}
			/>
		</TooltipProvider>,
	)

	return { ...utils, setAutocompleteConfigField, setAutocompleteApiKey }
}

describe("AutocompleteSettings", () => {
	it("reflects the persisted enabled flag", () => {
		renderSettings({ autocompleteConfig: { enabled: true } })

		expect(screen.getByTestId("autocomplete-enabled-checkbox")).toBeChecked()
	})

	it("falls back to the shared default when nothing is persisted", () => {
		renderSettings({ autocompleteConfig: undefined })

		const checkbox = screen.getByTestId("autocomplete-enabled-checkbox")

		expect(AUTOCOMPLETE_DEFAULTS.ENABLED).toBe(false)
		expect(checkbox).not.toBeChecked()
	})

	it("propagates the enable toggle", () => {
		const { setAutocompleteConfigField } = renderSettings({ autocompleteConfig: { enabled: false } })

		fireEvent.click(screen.getByTestId("autocomplete-enabled-checkbox"))

		expect(setAutocompleteConfigField).toHaveBeenCalledWith("enabled", true)
	})

	it("propagates base URL and model edits", () => {
		const { setAutocompleteConfigField } = renderSettings()

		fireEvent.input(screen.getByTestId("autocomplete-base-url-input"), {
			target: { value: "http://localhost:9999" },
		})
		fireEvent.input(screen.getByTestId("autocomplete-model-input"), {
			target: { value: "qwen2.5-coder:1.5b-base" },
		})

		expect(setAutocompleteConfigField).toHaveBeenCalledWith("baseUrl", "http://localhost:9999")
		expect(setAutocompleteConfigField).toHaveBeenCalledWith("modelId", "qwen2.5-coder:1.5b-base")
	})

	it("offers the API key field even for transports that usually do not authenticate", () => {
		// Ollama and OpenAI-compatible reach hosted endpoints too
		// (`https://ollama.com/v1`), so hiding the field made those unconfigurable.
		renderSettings({ autocompleteConfig: { enabled: true, provider: "ollama" } })

		expect(screen.getByTestId("autocomplete-api-key-input")).toBeInTheDocument()
	})

	it("shows the API key field for Codestral", () => {
		renderSettings({ autocompleteConfig: { enabled: true, provider: "codestral" } })

		expect(screen.getByTestId("autocomplete-api-key-input")).toBeInTheDocument()
	})

	it("keeps the API key input write-only", () => {
		// The stored key never reaches the webview, so the field must render empty even
		// when one exists; only the placeholder signals that a key is saved.
		renderSettings({
			autocompleteConfig: { enabled: true, provider: "codestral" },
			hasAutocompleteApiKey: true,
			autocompleteApiKeyDraft: undefined,
		})

		const input = screen.getByTestId("autocomplete-api-key-input")

		expect(input).toHaveValue("")
		expect(input).toHaveAttribute("placeholder", "settings:autocomplete.apiKey.storedPlaceholder")
	})

	it("distinguishes the empty-key placeholder", () => {
		renderSettings({
			autocompleteConfig: { enabled: true, provider: "codestral" },
			hasAutocompleteApiKey: false,
		})

		expect(screen.getByTestId("autocomplete-api-key-input")).toHaveAttribute(
			"placeholder",
			"settings:autocomplete.apiKey.emptyPlaceholder",
		)
	})

	it("propagates API key edits through the dedicated setter", () => {
		const { setAutocompleteApiKey, setAutocompleteConfigField } = renderSettings({
			autocompleteConfig: { enabled: true, provider: "codestral" },
		})

		fireEvent.input(screen.getByTestId("autocomplete-api-key-input"), { target: { value: "sk-test" } })

		expect(setAutocompleteApiKey).toHaveBeenCalledWith("sk-test")
		// The key is a global secret, not part of the nested config object.
		expect(setAutocompleteConfigField).not.toHaveBeenCalledWith("apiKey", expect.anything())
	})

	it("disables dependent controls while autocomplete is off", () => {
		// Ollama takes a base URL; hosted providers like Codestral do not, so the
		// field is only rendered for transports that actually have an endpoint.
		renderSettings({ autocompleteConfig: { enabled: false, provider: "ollama" } })

		expect(screen.getByTestId("autocomplete-base-url-input")).toBeDisabled()
		expect(screen.getByTestId("autocomplete-model-input")).toBeDisabled()
		expect(screen.getByTestId("autocomplete-api-key-input")).toBeDisabled()
	})

	it("hides the endpoint field for hosted providers", () => {
		renderSettings({ autocompleteConfig: { enabled: true, provider: "codestral" } })

		expect(screen.queryByTestId("autocomplete-base-url-input")).not.toBeInTheDocument()
	})

	it("offers only the FIM-capable transports as providers", () => {
		// Autocomplete is FIM-only: a chat provider cannot take a suffix, so listing
		// the full Providers-tab set offered choices that quietly underperformed —
		// including three near-identical "OpenAI" rows.
		renderSettings({ autocompleteConfig: { enabled: true, provider: "ollama" } })

		fireEvent.click(screen.getByTestId("autocomplete-provider-select"))

		// Scoped to the listbox: the trigger also renders the selected label, so a
		// document-wide query for "Ollama" matches twice.
		const options = screen.getAllByRole("option").map((option) => option.textContent)

		expect(options).toEqual(["Ollama", "OpenAI Compatible (LM Studio, llama.cpp, vLLM)", "Mistral Codestral"])
	})

	it("clamps an out-of-range stored suggestion length and says so", () => {
		// The schema permits up to 2048 but the slider stops at 512, so a config saved
		// before the bounds tightened rendered as a handle pinned to the far right —
		// indistinguishable from a legitimate maximum.
		renderSettings({ autocompleteConfig: { enabled: true, maxOutputTokens: 1024 } })

		expect(screen.getByTestId("autocomplete-max-output-tokens-clamped")).toBeInTheDocument()
	})

	it("says nothing when the stored suggestion length is in range", () => {
		renderSettings({
			autocompleteConfig: { enabled: true, maxOutputTokens: AUTOCOMPLETE_DEFAULTS.MAX_OUTPUT_TOKENS },
		})

		expect(screen.queryByTestId("autocomplete-max-output-tokens-clamped")).not.toBeInTheDocument()
	})

	it("mounts headlessly without issuing any side effects", () => {
		// SettingsView cycles every section at opacity-0 on mount to build the search
		// index. A section that fetched models on mount would fire for every user.
		const config: AutocompleteConfig = { enabled: true, provider: "ollama" }
		const postMessage = vi.fn()
		vi.stubGlobal("acquireVsCodeApi", () => ({ postMessage }))

		renderSettings({ autocompleteConfig: config })

		expect(postMessage).not.toHaveBeenCalled()
		vi.unstubAllGlobals()
	})
})
