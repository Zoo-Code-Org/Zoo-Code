import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"
import { type ProviderSettings, type RouterModels, friendliModels } from "@roo-code/types"

import { Friendli } from "../Friendli"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, value, onInput }: any) => (
		<div data-testid="friendli-api-key-field">
			{children}
			<input type="password" value={value || ""} data-testid="friendli-api-key-input" onInput={onInput} />
		</div>
	),
}))

vi.mock("@src/components/common/VSCodeButtonLink", () => ({
	VSCodeButtonLink: ({ href, children }: any) => (
		<a data-testid="friendli-get-key-link" href={href}>
			{children}
		</a>
	),
}))

type ModelPickerMockProps = {
	defaultModelId: string
	models: Record<string, unknown>
	modelIdKey: string
	serviceName: string
	serviceUrl: string
	errorMessage?: string
	apiConfiguration: unknown
	setApiConfigurationField: (field: string, value: unknown) => void
}

let mockModelPickerProps: ModelPickerMockProps = {} as ModelPickerMockProps

vi.mock("../../ModelPicker", () => ({
	ModelPicker: (props: ModelPickerMockProps) => {
		mockModelPickerProps = props
		return <div data-testid="friendli-model-picker-mock" />
	},
}))

describe("Friendli provider settings", () => {
	it("renders the 'Get Friendli API Key' link when no key is set", () => {
		render(
			<Friendli
				apiConfiguration={{ apiProvider: "friendli" } as ProviderSettings}
				setApiConfigurationField={vi.fn()}
			/>,
		)
		expect(screen.getByTestId("friendli-get-key-link")).toHaveAttribute("href", "https://friendli.ai/")
	})

	it("hides the 'Get Friendli API Key' link once a key is set", () => {
		render(
			<Friendli
				apiConfiguration={{ apiProvider: "friendli", friendliApiKey: "stored-key" } as ProviderSettings}
				setApiConfigurationField={vi.fn()}
			/>,
		)
		expect(screen.queryByTestId("friendli-get-key-link")).not.toBeInTheDocument()
		expect(screen.getByTestId("friendli-api-key-field")).toBeInTheDocument()
	})

	it("calls setApiConfigurationField with the API key when the input changes", () => {
		const mockSetApiConfigurationField = vi.fn()
		render(
			<Friendli
				apiConfiguration={{ apiProvider: "friendli" } as ProviderSettings}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)
		fireEvent.input(screen.getByTestId("friendli-api-key-input"), { target: { value: "new-key" } })
		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("friendliApiKey", "new-key")
	})

	it("passes correct props to ModelPicker (default model, static fallback, error message)", () => {
		const mockSetApiConfigurationField = vi.fn()
		const apiConfig = { apiProvider: "friendli" } as ProviderSettings
		render(
			<Friendli
				apiConfiguration={apiConfig}
				setApiConfigurationField={mockSetApiConfigurationField}
				modelValidationError="test error"
			/>,
		)
		expect(screen.getByTestId("friendli-model-picker-mock")).toBeInTheDocument()
		expect(mockModelPickerProps).toMatchObject({
			defaultModelId: "zai-org/GLM-5.2",
			modelIdKey: "apiModelId",
			serviceName: "Friendli",
			serviceUrl: "https://friendli.ai",
			errorMessage: "test error",
		})
		// When routerModels is not provided, ModelPicker should receive the static fallback
		expect(mockModelPickerProps.models).toEqual(friendliModels)
	})

	it("passes the router catalog to ModelPicker when routerModels.friendli is non-empty", () => {
		const dynamicModels = {
			"zai-org/GLM-5.2": { ...friendliModels["zai-org/GLM-5.2"], description: "Dynamic GLM-5.2" },
			"deepseek-ai/DeepSeek-V3.2": { ...friendliModels["zai-org/GLM-5.2"], description: "Dynamic DeepSeek" },
		}
		const apiConfig = { apiProvider: "friendli" } as ProviderSettings
		render(
			<Friendli
				apiConfiguration={apiConfig}
				setApiConfigurationField={vi.fn()}
				routerModels={{ friendli: dynamicModels } as Partial<RouterModels> as RouterModels}
			/>,
		)
		expect(mockModelPickerProps.models).toEqual(dynamicModels)
		expect(mockModelPickerProps.models).not.toEqual(friendliModels)
	})

	it("falls back to static models when routerModels.friendli is an empty record", () => {
		// requestRouterModels posts {} for a failed/empty Friendli fetch; {}
		// is non-nullish, so a ?? guard alone would hand the picker zero
		// models. The settings component must treat the empty record as
		// "no dynamic list" and keep the static fallback.
		const apiConfig = { apiProvider: "friendli" } as ProviderSettings
		render(
			<Friendli
				apiConfiguration={apiConfig}
				setApiConfigurationField={vi.fn()}
				routerModels={{ friendli: {} } as Partial<RouterModels> as RouterModels}
			/>,
		)
		expect(mockModelPickerProps.models).toEqual(friendliModels)
	})
})
