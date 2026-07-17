import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"
import type { ProviderSettings } from "@roo-code/types"

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
})
