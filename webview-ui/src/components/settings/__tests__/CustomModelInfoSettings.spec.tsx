import { fireEvent, render, screen } from "@testing-library/react"

import type { ModelInfo, ProviderSettings } from "@roo-code/types"

import { CustomModelInfoSettings } from "../CustomModelInfoSettings"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

describe("CustomModelInfoSettings", () => {
	const modelInfo: ModelInfo = {
		contextWindow: 128_000,
		maxTokens: 16_384,
		supportsImages: false,
		supportsPromptCache: true,
	}

	it("keeps numeric edits in the cached provider configuration and supports reset", () => {
		const setApiConfigurationField = vi.fn()
		const apiConfiguration: ProviderSettings = {
			apiProvider: "openrouter",
			customModelInfo: { contextWindow: 64_000 },
		}

		render(
			<CustomModelInfoSettings
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				selectedModelInfo={modelInfo}
			/>,
		)

		fireEvent.click(screen.getByText("settings:providers.customModelInfo.title"))

		const contextWindowInput = screen.getByLabelText("settings:providers.customModelInfo.contextWindow.label")
		fireEvent.input(contextWindowInput, { target: { value: "128000" } })

		expect(setApiConfigurationField).toHaveBeenCalledTimes(1)
		expect(setApiConfigurationField).toHaveBeenLastCalledWith("customModelInfo", { contextWindow: 128_000 })

		fireEvent.click(screen.getByText("settings:providers.customModelInfo.reset"))
		expect(setApiConfigurationField).toHaveBeenCalledTimes(2)
		expect(setApiConfigurationField).toHaveBeenLastCalledWith("customModelInfo", undefined)
	})

	it("keeps invalid numeric input visible without persisting it", () => {
		const setApiConfigurationField = vi.fn()

		render(
			<CustomModelInfoSettings
				apiConfiguration={{ apiProvider: "requesty" }}
				setApiConfigurationField={setApiConfigurationField}
				selectedModelInfo={modelInfo}
			/>,
		)

		fireEvent.click(screen.getByText("settings:providers.customModelInfo.title"))

		const maxTokensInput = screen.getByLabelText("settings:providers.customModelInfo.maxTokens.label")
		fireEvent.input(maxTokensInput, { target: { value: "12abc" } })

		expect(maxTokensInput).toHaveValue("12abc")
		expect(maxTokensInput).toHaveAttribute("aria-invalid", "true")
		// Invalid non-empty input should NOT persist — the override callback is not called
		expect(setApiConfigurationField).not.toHaveBeenCalled()
	})

	it("does not delete an existing valid override when the user types invalid input", () => {
		const setApiConfigurationField = vi.fn()

		render(
			<CustomModelInfoSettings
				apiConfiguration={{
					apiProvider: "requesty",
					customModelInfo: { contextWindow: 64_000 },
				}}
				setApiConfigurationField={setApiConfigurationField}
				selectedModelInfo={modelInfo}
			/>,
		)

		fireEvent.click(screen.getByText("settings:providers.customModelInfo.title"))

		const contextWindowInput = screen.getByLabelText("settings:providers.customModelInfo.contextWindow.label")
		fireEvent.input(contextWindowInput, { target: { value: "12abc" } })

		expect(contextWindowInput).toHaveValue("12abc")
		expect(contextWindowInput).toHaveAttribute("aria-invalid", "true")
		// The existing 64000 override must NOT be deleted
		expect(setApiConfigurationField).not.toHaveBeenCalled()
	})

	it("clears the override when the user empties the input field", () => {
		const setApiConfigurationField = vi.fn()

		render(
			<CustomModelInfoSettings
				apiConfiguration={{
					apiProvider: "requesty",
					customModelInfo: { contextWindow: 64_000 },
				}}
				setApiConfigurationField={setApiConfigurationField}
				selectedModelInfo={modelInfo}
			/>,
		)

		fireEvent.click(screen.getByText("settings:providers.customModelInfo.title"))

		const contextWindowInput = screen.getByLabelText("settings:providers.customModelInfo.contextWindow.label")
		fireEvent.input(contextWindowInput, { target: { value: "" } })

		expect(setApiConfigurationField).toHaveBeenCalledWith("customModelInfo", undefined)
	})

	it("accumulates capability overrides across toggles with rerender", () => {
		const setApiConfigurationField = vi.fn()
		const baseConfig: ProviderSettings = {
			apiProvider: "unbound",
			customModelInfo: { contextWindow: 1000, maxTokens: 2000 },
		}

		const { rerender } = render(
			<CustomModelInfoSettings
				apiConfiguration={baseConfig}
				setApiConfigurationField={setApiConfigurationField}
				selectedModelInfo={modelInfo}
			/>,
		)

		fireEvent.click(screen.getByText("settings:providers.customModelInfo.title"))

		expect(screen.getByText("settings:providers.customModelInfo.maxTokensWarning")).toBeInTheDocument()

		// Toggle 1: enable supportsImages
		fireEvent.click(screen.getByText("settings:providers.customModelInfo.supportsImages.label"))
		expect(setApiConfigurationField).toHaveBeenCalledTimes(1)
		expect(setApiConfigurationField).toHaveBeenLastCalledWith("customModelInfo", {
			contextWindow: 1000,
			maxTokens: 2000,
			supportsImages: true,
		})

		// Re-render with the updated configuration so toggle 2 sees toggle 1's effect
		rerender(
			<CustomModelInfoSettings
				apiConfiguration={{
					...baseConfig,
					customModelInfo: setApiConfigurationField.mock.calls[0][1],
				}}
				setApiConfigurationField={setApiConfigurationField}
				selectedModelInfo={modelInfo}
			/>,
		)

		// Toggle 2: disable supportsPromptCache — should accumulate with supportsImages: true
		fireEvent.click(screen.getByText("settings:providers.customModelInfo.supportsPromptCache.label"))
		expect(setApiConfigurationField).toHaveBeenCalledTimes(2)
		expect(setApiConfigurationField).toHaveBeenLastCalledWith("customModelInfo", {
			contextWindow: 1000,
			maxTokens: 2000,
			supportsImages: true,
			supportsPromptCache: false,
		})
	})

	it("syncs externally updated numeric overrides into the inputs", () => {
		const setApiConfigurationField = vi.fn()

		const { rerender } = render(
			<CustomModelInfoSettings
				apiConfiguration={{ apiProvider: "openrouter" }}
				setApiConfigurationField={setApiConfigurationField}
				selectedModelInfo={modelInfo}
			/>,
		)

		fireEvent.click(screen.getByText("settings:providers.customModelInfo.title"))

		rerender(
			<CustomModelInfoSettings
				apiConfiguration={{ apiProvider: "openrouter", customModelInfo: { maxTokens: 200 } }}
				setApiConfigurationField={setApiConfigurationField}
				selectedModelInfo={modelInfo}
			/>,
		)

		expect(screen.getByLabelText("settings:providers.customModelInfo.maxTokens.label")).toHaveValue("200")
	})
})
