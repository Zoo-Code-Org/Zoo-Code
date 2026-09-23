import { fireEvent, render, screen } from "@testing-library/react"

import { openAiModelInfoSaneDefaults, providerIdentifiers, type ModelInfo, type ProviderSettings } from "@roo-code/types"

import { CustomModelInfoSettings } from "../CustomModelInfoSettings"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

const contextWindowLabel = "settings:providers.customModelInfo.contextWindow.label"
const maxTokensLabel = "settings:providers.customModelInfo.maxTokens.label"
const imagesLabel = "settings:providers.customModelInfo.supportsImages.label"
const promptCacheLabel = "settings:providers.customModelInfo.supportsPromptCache.label"

describe("CustomModelInfoSettings", () => {
	const modelInfo: ModelInfo = {
		contextWindow: 128_000,
		maxTokens: 16_384,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 3,
		outputPrice: 15,
	}

	const open = () => fireEvent.click(screen.getByText("settings:providers.customModelInfo.title"))

	it("seeds the editor from the discovered model and omits provider pricing when saving", () => {
		const setApiConfigurationField = vi.fn()

		render(
			<CustomModelInfoSettings
				apiConfiguration={{ apiProvider: providerIdentifiers.openrouter }}
				setApiConfigurationField={setApiConfigurationField}
				selectedModelInfo={modelInfo}
			/>,
		)

		open()

		// Prefilled from the catalog entry rather than left blank.
		expect(screen.getByLabelText(contextWindowLabel)).toHaveValue("128000")
		expect(screen.getByLabelText(maxTokensLabel)).toHaveValue("16384")

		fireEvent.input(screen.getByLabelText(contextWindowLabel), { target: { value: "200000" } })

		const saved = setApiConfigurationField.mock.calls.at(-1)?.[1]
		expect(saved).toMatchObject({ contextWindow: 200_000, maxTokens: 16_384, supportsPromptCache: true })
		// Pricing stays provider-owned so a stored snapshot cannot go stale.
		expect(saved && "inputPrice" in saved).toBe(false)
		expect(saved && "outputPrice" in saved).toBe(false)
	})

	it("falls back to shared defaults when the model is not in the catalog", () => {
		render(
			<CustomModelInfoSettings
				apiConfiguration={{ apiProvider: providerIdentifiers.requesty }}
				setApiConfigurationField={vi.fn()}
				selectedModelInfo={undefined}
			/>,
		)

		// The panel auto-opens for an unresolved model.
		expect(screen.getByText("settings:providers.customModelInfo.unresolved")).toBeInTheDocument()
		expect(screen.getByLabelText(contextWindowLabel)).toHaveValue(
			openAiModelInfoSaneDefaults.contextWindow.toString(),
		)

		// `openAiModelInfoSaneDefaults.maxTokens` is the -1 "provider decides"
		// sentinel; showing it verbatim would render a permanently invalid field.
		expect(screen.getByLabelText(maxTokensLabel)).toHaveValue("")
		expect(screen.getByLabelText(maxTokensLabel)).toHaveAttribute("aria-invalid", "false")
	})

	it("keeps invalid context window text visible without persisting it", () => {
		const setApiConfigurationField = vi.fn()

		render(
			<CustomModelInfoSettings
				apiConfiguration={{
					apiProvider: providerIdentifiers.requesty,
					customModelInfo: { contextWindow: 64_000, supportsPromptCache: false },
				}}
				setApiConfigurationField={setApiConfigurationField}
				selectedModelInfo={modelInfo}
			/>,
		)

		open()

		const contextWindowInput = screen.getByLabelText(contextWindowLabel)
		fireEvent.input(contextWindowInput, { target: { value: "12abc" } })

		expect(contextWindowInput).toHaveValue("12abc")
		expect(contextWindowInput).toHaveAttribute("aria-invalid", "true")
		// A context window is required for token accounting, so nothing is stored.
		expect(setApiConfigurationField).not.toHaveBeenCalled()
	})

	it("treats an empty max output tokens field as provider-decided", () => {
		const setApiConfigurationField = vi.fn()

		render(
			<CustomModelInfoSettings
				apiConfiguration={{
					apiProvider: providerIdentifiers.requesty,
					customModelInfo: { contextWindow: 64_000, maxTokens: 8_000, supportsPromptCache: false },
				}}
				setApiConfigurationField={setApiConfigurationField}
				selectedModelInfo={modelInfo}
			/>,
		)

		open()

		fireEvent.input(screen.getByLabelText(maxTokensLabel), { target: { value: "" } })

		expect(setApiConfigurationField.mock.calls.at(-1)?.[1]).toMatchObject({
			contextWindow: 64_000,
			maxTokens: undefined,
		})
	})

	it("accumulates capability toggles on top of the stored snapshot", () => {
		const setApiConfigurationField = vi.fn()
		const baseConfig: ProviderSettings = {
			apiProvider: providerIdentifiers.unbound,
			customModelInfo: { contextWindow: 1_000, maxTokens: 2_000, supportsPromptCache: false },
		}

		const { rerender } = render(
			<CustomModelInfoSettings
				apiConfiguration={baseConfig}
				setApiConfigurationField={setApiConfigurationField}
				selectedModelInfo={modelInfo}
			/>,
		)

		open()

		// maxTokens above the context window is surfaced to the user.
		expect(screen.getByText("settings:providers.customModelInfo.maxTokensWarning")).toBeInTheDocument()

		fireEvent.click(screen.getByText(imagesLabel))
		expect(setApiConfigurationField).toHaveBeenLastCalledWith("customModelInfo", {
			contextWindow: 1_000,
			maxTokens: 2_000,
			supportsImages: true,
			supportsPromptCache: false,
		})

		rerender(
			<CustomModelInfoSettings
				apiConfiguration={{ ...baseConfig, customModelInfo: setApiConfigurationField.mock.calls[0][1] }}
				setApiConfigurationField={setApiConfigurationField}
				selectedModelInfo={modelInfo}
			/>,
		)

		fireEvent.click(screen.getByText(promptCacheLabel))
		expect(setApiConfigurationField).toHaveBeenLastCalledWith("customModelInfo", {
			contextWindow: 1_000,
			maxTokens: 2_000,
			supportsImages: true,
			supportsPromptCache: true,
		})
	})

	it("reverts the inputs to the discovered values when the override is cleared", () => {
		const setApiConfigurationField = vi.fn()

		const { rerender } = render(
			<CustomModelInfoSettings
				apiConfiguration={{
					apiProvider: providerIdentifiers.openrouter,
					customModelInfo: { contextWindow: 64_000, maxTokens: 4_000, supportsPromptCache: false },
				}}
				setApiConfigurationField={setApiConfigurationField}
				selectedModelInfo={modelInfo}
			/>,
		)

		open()
		expect(screen.getByLabelText(contextWindowLabel)).toHaveValue("64000")

		fireEvent.click(screen.getByText("settings:providers.customModelInfo.reset"))
		expect(setApiConfigurationField).toHaveBeenLastCalledWith("customModelInfo", undefined)

		rerender(
			<CustomModelInfoSettings
				apiConfiguration={{ apiProvider: providerIdentifiers.openrouter }}
				setApiConfigurationField={setApiConfigurationField}
				selectedModelInfo={modelInfo}
			/>,
		)

		expect(screen.getByLabelText(contextWindowLabel)).toHaveValue("128000")
		expect(screen.getByLabelText(maxTokensLabel)).toHaveValue("16384")
	})

	it("mirrors an externally updated snapshot into the inputs", () => {
		const setApiConfigurationField = vi.fn()

		const { rerender } = render(
			<CustomModelInfoSettings
				apiConfiguration={{ apiProvider: providerIdentifiers.openrouter }}
				setApiConfigurationField={setApiConfigurationField}
				selectedModelInfo={modelInfo}
			/>,
		)

		open()

		rerender(
			<CustomModelInfoSettings
				apiConfiguration={{
					apiProvider: providerIdentifiers.openrouter,
					customModelInfo: { contextWindow: 32_000, maxTokens: 200, supportsPromptCache: false },
				}}
				setApiConfigurationField={setApiConfigurationField}
				selectedModelInfo={modelInfo}
			/>,
		)

		expect(screen.getByLabelText(contextWindowLabel)).toHaveValue("32000")
		expect(screen.getByLabelText(maxTokensLabel)).toHaveValue("200")
	})

	it("resets half-typed invalid text when switching to a profile without overrides", () => {
		const setApiConfigurationField = vi.fn()

		const { rerender } = render(
			<CustomModelInfoSettings
				apiConfiguration={{
					apiProvider: providerIdentifiers.openrouter,
					customModelInfo: { contextWindow: 64_000, supportsPromptCache: false },
				}}
				setApiConfigurationField={setApiConfigurationField}
				selectedModelInfo={modelInfo}
			/>,
		)

		open()

		const contextWindowInput = screen.getByLabelText(contextWindowLabel)
		fireEvent.input(contextWindowInput, { target: { value: "12abc" } })
		expect(contextWindowInput).toHaveValue("12abc")

		// Invalid text and an absent override both parse to undefined, so the sync
		// must key off the stored value rather than the parsed input.
		rerender(
			<CustomModelInfoSettings
				apiConfiguration={{ apiProvider: providerIdentifiers.unbound }}
				setApiConfigurationField={setApiConfigurationField}
				selectedModelInfo={modelInfo}
			/>,
		)

		expect(contextWindowInput).toHaveValue("128000")
		expect(contextWindowInput).toHaveAttribute("aria-invalid", "false")
	})
})
