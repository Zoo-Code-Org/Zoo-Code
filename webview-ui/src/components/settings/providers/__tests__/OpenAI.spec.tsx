import React from "react"

import { OpenAiServiceTier, providerIdentifiers, type ModelInfo, type ProviderSettings } from "@roo-code/types"

import { fireEvent, render, screen } from "@/utils/test-utils"

import { OpenAI } from "../OpenAI"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("vscrui", () => ({
	Checkbox: ({
		children,
		checked,
		onChange,
	}: {
		children: React.ReactNode
		checked?: boolean
		onChange?: (checked: boolean) => void
	}) => (
		<label>
			<input type="checkbox" checked={checked} onChange={(event) => onChange?.(event.target.checked)} />
			{children}
		</label>
	),
}))

vi.mock("@src/components/ui", () => ({
	Select: ({ children, value, onValueChange }: any) => (
		<select aria-label="Service tier" value={value} onChange={(event) => onValueChange(event.target.value)}>
			{children}
		</select>
	),
	SelectContent: ({ children }: any) => <>{children}</>,
	SelectItem: ({ children, value }: any) => <option value={value}>{children}</option>,
	SelectTrigger: () => null,
	SelectValue: () => null,
	StandardTooltip: ({ children, content }: any) => <span title={content}>{children}</span>,
}))

const baseModelInfo: ModelInfo = {
	contextWindow: 128_000,
	supportsPromptCache: true,
}

describe("OpenAI service tier selector", () => {
	it("shows supported service tiers and persists the selected tier", () => {
		const setApiConfigurationField = vi.fn()
		const selectedModelInfo: ModelInfo = {
			...baseModelInfo,
			tiers: [
				{ name: OpenAiServiceTier.Default, contextWindow: 128_000 },
				{ contextWindow: 128_000 },
				{ name: OpenAiServiceTier.Flex, contextWindow: 128_000 },
				{ name: OpenAiServiceTier.Priority, contextWindow: 128_000 },
			],
		}
		const apiConfiguration: ProviderSettings = {
			apiProvider: providerIdentifiers.openaiNative,
			openAiNativeApiKey: "test-api-key",
		}

		render(
			<OpenAI
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				selectedModelInfo={selectedModelInfo}
			/>,
		)

		expect(screen.getByText("settings:serviceTier.label")).toBeInTheDocument()
		const selector = screen.getByRole("combobox", { name: "Service tier" })
		expect(selector).toHaveValue(OpenAiServiceTier.Default)
		expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
			"settings:serviceTier.standard",
			"settings:serviceTier.flex",
			"settings:serviceTier.priority",
		])

		fireEvent.change(selector, { target: { value: OpenAiServiceTier.Flex } })
		expect(setApiConfigurationField).toHaveBeenLastCalledWith("openAiNativeServiceTier", OpenAiServiceTier.Flex)

		fireEvent.change(selector, { target: { value: OpenAiServiceTier.Priority } })
		expect(setApiConfigurationField).toHaveBeenLastCalledWith("openAiNativeServiceTier", OpenAiServiceTier.Priority)
	})

	it("hides the selector when the model only exposes the default tier", () => {
		render(
			<OpenAI
				apiConfiguration={{
					apiProvider: providerIdentifiers.openaiNative,
					openAiNativeApiKey: "test-api-key",
				}}
				setApiConfigurationField={vi.fn()}
				selectedModelInfo={{
					...baseModelInfo,
					tiers: [{ name: OpenAiServiceTier.Default, contextWindow: 128_000 }],
				}}
			/>,
		)

		expect(screen.queryByTestId("openai-service-tier")).not.toBeInTheDocument()
	})
})

describe("OpenAI custom deployment name", () => {
	const baseConfiguration: ProviderSettings = {
		apiProvider: providerIdentifiers.openaiNative,
		openAiNativeApiKey: "sk-test-key",
	}

	it("keeps the input hidden until the checkbox is checked", () => {
		render(
			<OpenAI
				apiConfiguration={baseConfiguration}
				setApiConfigurationField={vi.fn()}
				selectedModelInfo={baseModelInfo}
			/>,
		)

		expect(screen.queryByTestId("openai-native-deployment-name-input")).not.toBeInTheDocument()

		fireEvent.click(screen.getByRole("checkbox", { name: "settings:providers.useCustomDeploymentName" }))

		expect(screen.getByTestId("openai-native-deployment-name-input")).toBeInTheDocument()
		expect(screen.getByText("settings:providers.openAiNativeDeploymentNameDescription")).toBeInTheDocument()
	})

	it("persists typed deployment names and clears the saved value when the checkbox is unchecked", () => {
		const setApiConfigurationField = vi.fn()
		render(
			<OpenAI
				apiConfiguration={{ ...baseConfiguration, openAiNativeDeploymentName: "existing-deployment" }}
				setApiConfigurationField={setApiConfigurationField}
				selectedModelInfo={baseModelInfo}
			/>,
		)

		// A saved deployment name selects the checkbox and fills the input.
		const input = screen.getByTestId("openai-native-deployment-name-input")
		expect(input).toHaveValue("existing-deployment")

		fireEvent.input(input, { target: { value: "my-azure-deployment" } })
		expect(setApiConfigurationField).toHaveBeenLastCalledWith("openAiNativeDeploymentName", "my-azure-deployment")

		fireEvent.click(screen.getByRole("checkbox", { name: "settings:providers.useCustomDeploymentName" }))
		expect(setApiConfigurationField).toHaveBeenLastCalledWith("openAiNativeDeploymentName", "")
	})
})
