// pnpm --filter @roo-code/vscode-webview test src/components/settings/providers/__tests__/Anthropic.spec.tsx

import React from "react"

import { providerIdentifiers, type ModelInfo, type ProviderSettings } from "@roo-code/types"

import { fireEvent, render, screen } from "@/utils/test-utils"

import { Anthropic } from "../Anthropic"

const selectedModelInfo = vi.hoisted(() => ({ value: undefined as ModelInfo | undefined }))

vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({ id: "claude-sonnet-4-5", info: selectedModelInfo.value }),
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("vscrui", () => ({
	Checkbox: ({ children, checked, onChange }: any) => (
		<label>
			<input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
			{children}
		</label>
	),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, value, onInput, type }: any) => (
		<div>
			{children}
			<input type={type} value={value} onChange={(event) => onInput(event)} />
		</div>
	),
}))

vi.mock("@src/components/common/VSCodeButtonLink", () => ({
	VSCodeButtonLink: ({ children }: any) => <a>{children}</a>,
}))

// Radix Select renders its content in a portal and needs pointer events JSDOM
// does not provide, so the mock keeps the controlled value and the option list
// addressable through plain DOM.
vi.mock("@src/components/ui", () => ({
	Select: ({ children, value, onValueChange }: any) => (
		<select aria-label="prompt-cache-ttl" value={value} onChange={(event) => onValueChange(event.target.value)}>
			{children}
		</select>
	),
	SelectContent: ({ children }: any) => <>{children}</>,
	SelectItem: ({ children, value }: any) => <option value={value}>{children}</option>,
	SelectTrigger: () => null,
	SelectValue: () => null,
}))

const capableModel: ModelInfo = {
	contextWindow: 200_000,
	supportsPromptCache: true,
	promptCacheTtlSupport: ["5m", "1h"],
}

const fiveMinuteOnlyModel: ModelInfo = {
	contextWindow: 200_000,
	supportsPromptCache: true,
	promptCacheTtlSupport: ["5m"],
}

const baseConfiguration: ProviderSettings = {
	apiProvider: providerIdentifiers.anthropic,
	apiKey: "test-api-key",
}

const renderPanel = (apiConfiguration: ProviderSettings = baseConfiguration) => {
	const setApiConfigurationField = vi.fn()

	render(<Anthropic apiConfiguration={apiConfiguration} setApiConfigurationField={setApiConfigurationField} />)

	return { setApiConfigurationField }
}

describe("Anthropic prompt cache TTL control", () => {
	beforeEach(() => {
		selectedModelInfo.value = capableModel
	})

	it("renders the control for a model that advertises the 1h class", () => {
		renderPanel()

		expect(screen.getByTestId("prompt-cache-ttl")).toBeInTheDocument()
		expect(screen.getAllByRole("option").map((option) => option.getAttribute("value"))).toEqual(["5m", "1h"])
	})

	it.each([
		["the catalog advertises 5m only", fiveMinuteOnlyModel],
		["the catalog carries no capability metadata", { contextWindow: 200_000, supportsPromptCache: true }],
		["no model info resolved", undefined],
	])("hides the control when %s", (_label, info) => {
		selectedModelInfo.value = info
		renderPanel()

		expect(screen.queryByTestId("prompt-cache-ttl")).not.toBeInTheDocument()
	})

	it("shows the 5 minute default when the knob is unset", () => {
		renderPanel()

		expect(screen.getByRole("combobox", { name: "prompt-cache-ttl" })).toHaveValue("5m")
	})

	it("shows the stored 1h value rather than the default", () => {
		renderPanel({ ...baseConfiguration, promptCacheTtl: "1h" })

		expect(screen.getByRole("combobox", { name: "prompt-cache-ttl" })).toHaveValue("1h")
	})

	it("writes 1h when the user selects it", () => {
		const { setApiConfigurationField } = renderPanel()

		fireEvent.change(screen.getByRole("combobox", { name: "prompt-cache-ttl" }), { target: { value: "1h" } })

		expect(setApiConfigurationField).toHaveBeenCalledWith("promptCacheTtl", "1h")
	})

	it("clears the knob instead of storing an explicit 5m", () => {
		// An explicit "5m" would be a second way to say "default" and would make
		// the wire-shape guarantee depend on the resolver rather than on absence.
		const { setApiConfigurationField } = renderPanel({ ...baseConfiguration, promptCacheTtl: "1h" })

		fireEvent.change(screen.getByRole("combobox", { name: "prompt-cache-ttl" }), { target: { value: "5m" } })

		expect(setApiConfigurationField).toHaveBeenCalledWith("promptCacheTtl", undefined)
	})
})
