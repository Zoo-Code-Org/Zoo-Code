import React from "react"

import { render, screen, fireEvent } from "@/utils/test-utils"
import type { ProviderSettings } from "@roo-code/types"

import { Novita } from "../Novita"

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, value, onInput, placeholder, type, className }: any) => (
		<label className={className}>
			{children}
			<input
				type={type ?? "text"}
				value={value}
				onChange={(event) => onInput?.(event)}
				placeholder={placeholder}
			/>
		</label>
	),
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

vi.mock("@src/components/common/VSCodeButtonLink", () => ({
	VSCodeButtonLink: ({ children, href }: any) => <a href={href}>{children}</a>,
}))

describe("Novita provider settings", () => {
	it("renders defaults and API key link when no key is configured", () => {
		render(<Novita apiConfiguration={{} as ProviderSettings} setApiConfigurationField={vi.fn()} />)

		expect(screen.getByLabelText("settings:providers.novitaBaseUrl")).toHaveValue("https://api.novita.ai/openai")
		expect(screen.getByLabelText("settings:providers.novitaApiKey")).toHaveValue("")
		expect(screen.getByRole("link", { name: "settings:providers.getNovitaApiKey" })).toHaveAttribute(
			"href",
			"https://novita.ai/settings/key-management",
		)
	})

	it("updates Novita provider fields", () => {
		const setApiConfigurationField = vi.fn()

		render(
			<Novita
				apiConfiguration={
					{
						novitaBaseUrl: "https://api.novita.ai/openai",
						novitaApiKey: "existing-key",
					} as ProviderSettings
				}
				setApiConfigurationField={setApiConfigurationField}
			/>,
		)

		fireEvent.change(screen.getByLabelText("settings:providers.novitaBaseUrl"), {
			target: { value: "https://example.test/openai" },
		})
		fireEvent.change(screen.getByLabelText("settings:providers.novitaApiKey"), {
			target: { value: "new-key" },
		})

		expect(setApiConfigurationField).toHaveBeenCalledWith("novitaBaseUrl", "https://example.test/openai")
		expect(setApiConfigurationField).toHaveBeenCalledWith("novitaApiKey", "new-key")
		expect(screen.queryByRole("link", { name: "settings:providers.getNovitaApiKey" })).not.toBeInTheDocument()
	})
})
