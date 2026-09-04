import { providerIdentifiers } from "@roo-code/types"
import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"
import type { ProviderSettings } from "@roo-code/types"

import { NeuronPool } from "../NeuronPool"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, value, onInput, type, placeholder }: any) => {
		const testId = type === "password" ? "neuronpool-api-key" : "neuronpool-base-url"
		return (
			<div data-testid={`${testId}-field`}>
				{children}
				<input
					type={type || "text"}
					value={value || ""}
					placeholder={placeholder}
					data-testid={`${testId}-input`}
					onInput={onInput}
				/>
			</div>
		)
	},
}))

vi.mock("@src/components/common/VSCodeButtonLink", () => ({
	VSCodeButtonLink: ({ href, children }: any) => (
		<a data-testid="neuronpool-get-key-link" href={href}>
			{children}
		</a>
	),
}))

describe("NeuronPool provider settings", () => {
	it("renders labels, placeholders, and the get-key link when no key is set", () => {
		render(
			<NeuronPool
				apiConfiguration={{ apiProvider: providerIdentifiers.neuronpool } as ProviderSettings}
				setApiConfigurationField={vi.fn()}
			/>,
		)
		expect(screen.getByTestId("neuronpool-get-key-link")).toHaveAttribute(
			"href",
			"https://neuronpool.damnknee.workers.dev/dashboard",
		)
		expect(screen.getByText("settings:providers.apiKey")).toBeInTheDocument()
		expect(screen.getByText("settings:providers.apiKeyStorageNotice")).toBeInTheDocument()
		expect(screen.getByTestId("neuronpool-api-key-input")).toHaveAttribute(
			"placeholder",
			"settings:placeholders.apiKey",
		)
		expect(screen.getByTestId("neuronpool-base-url-input")).toHaveAttribute(
			"placeholder",
			"https://neuronpool.damnknee.workers.dev/v1",
		)
	})

	it("treats a missing apiConfiguration as empty fields without throwing", () => {
		render(
			<NeuronPool
				apiConfiguration={undefined as unknown as ProviderSettings}
				setApiConfigurationField={vi.fn()}
			/>,
		)
		expect(screen.getByTestId("neuronpool-api-key-input")).toHaveValue("")
		expect(screen.getByTestId("neuronpool-base-url-input")).toHaveValue("")
		expect(screen.getByTestId("neuronpool-get-key-link")).toBeInTheDocument()
	})

	it("shows the get-key link when the stored key is an empty string", () => {
		render(
			<NeuronPool
				apiConfiguration={
					{ apiProvider: providerIdentifiers.neuronpool, neuronpoolApiKey: "" } as ProviderSettings
				}
				setApiConfigurationField={vi.fn()}
			/>,
		)
		expect(screen.getByTestId("neuronpool-get-key-link")).toBeInTheDocument()
	})

	it("hides the 'Get NeuronPool API Key' link once a key is set", () => {
		render(
			<NeuronPool
				apiConfiguration={
					{
						apiProvider: providerIdentifiers.neuronpool,
						neuronpoolApiKey: "stored-key",
						neuronpoolBaseUrl: "http://127.0.0.1:8787/v1",
					} as ProviderSettings
				}
				setApiConfigurationField={vi.fn()}
			/>,
		)
		expect(screen.queryByTestId("neuronpool-get-key-link")).not.toBeInTheDocument()
		expect(screen.getByTestId("neuronpool-api-key-input")).toHaveValue("stored-key")
		expect(screen.getByTestId("neuronpool-base-url-input")).toHaveValue("http://127.0.0.1:8787/v1")
	})

	it("calls the latest setApiConfigurationField after a rerender", () => {
		const first = vi.fn()
		const second = vi.fn()
		const { rerender } = render(
			<NeuronPool
				apiConfiguration={{ apiProvider: providerIdentifiers.neuronpool } as ProviderSettings}
				setApiConfigurationField={first}
			/>,
		)
		rerender(
			<NeuronPool
				apiConfiguration={{ apiProvider: providerIdentifiers.neuronpool } as ProviderSettings}
				setApiConfigurationField={second}
			/>,
		)
		fireEvent.input(screen.getByTestId("neuronpool-api-key-input"), { target: { value: "new-key" } })
		expect(second).toHaveBeenCalledWith("neuronpoolApiKey", "new-key")
		expect(first).not.toHaveBeenCalled()
	})

	it("calls setApiConfigurationField with the base URL when the input changes", () => {
		const mockSetApiConfigurationField = vi.fn()
		render(
			<NeuronPool
				apiConfiguration={{ apiProvider: providerIdentifiers.neuronpool } as ProviderSettings}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)
		fireEvent.input(screen.getByTestId("neuronpool-base-url-input"), {
			target: { value: "http://127.0.0.1:8787/v1" },
		})
		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("neuronpoolBaseUrl", "http://127.0.0.1:8787/v1")
	})
})
