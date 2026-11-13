import type { ReactNode } from "react"

import { providerIdentifiers, type ProviderSettings } from "@roo-code/types"

import { render, screen } from "@/utils/test-utils"

import { BedrockCustomArn } from "../BedrockCustomArn"

type SelectMockProps = {
	children: ReactNode
	value: string
	onValueChange: (value: string) => void
	disabled?: boolean
}
type TextFieldMockProps = {
	children: ReactNode
	value: string
	onInput: (event: { target: { value: string } }) => void
	placeholder?: string
	className?: string
	"data-testid"?: string
}

vi.mock("@src/components/ui", () => ({
	Select: ({ children, value, onValueChange, disabled }: SelectMockProps) => (
		<select
			data-testid="base-model-select"
			value={value}
			disabled={disabled}
			onChange={(e) => onValueChange(e.target.value)}>
			{children}
		</select>
	),
	SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
	SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
		<option value={value}>{children}</option>
	),
	SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
	SelectValue: () => null,
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, value, onInput, placeholder, "data-testid": testId }: TextFieldMockProps) => (
		<label>
			<input
				data-testid={testId ?? "text-field"}
				value={value}
				placeholder={placeholder}
				onChange={(e) => onInput({ target: { value: e.target.value } })}
			/>
			{children}
		</label>
	),
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options ? Object.entries(options).reduce((acc: string, [k, v]) => `${acc} ${k}=${String(v)}`, key) : key,
	}),
}))

describe("BedrockCustomArn - the memoised ARN validation", () => {
	it("reports no problem for a session with no ARN typed yet", () => {
		const apiConfiguration: ProviderSettings = {
			apiProvider: providerIdentifiers.bedrock,
			awsRegion: "us-east-1",
		}
		const setApiConfigurationField = vi.fn()

		render(
			<BedrockCustomArn
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
			/>,
		)

		expect(screen.queryByText("settings:providers.invalidArnFormat")).toBeNull()
		expect(screen.queryByText(/regionMismatch/)).toBeNull()
	})

	it("re-validates when a different ARN arrives, including a region that contradicts the setting", () => {
		const base: ProviderSettings = { apiProvider: providerIdentifiers.bedrock, awsRegion: "us-east-1" }
		const setApiConfigurationField = vi.fn()
		const mismatchedArn =
			"arn:aws:bedrock:eu-west-1:123456789012:inference-profile/eu.anthropic.claude-3-7-sonnet-20250219-v1:0"

		const { rerender } = render(
			<BedrockCustomArn apiConfiguration={base} setApiConfigurationField={setApiConfigurationField} />,
		)
		expect(screen.queryByText(/regionMismatch/)).toBeNull()

		rerender(
			<BedrockCustomArn
				apiConfiguration={{ ...base, awsCustomArn: mismatchedArn }}
				setApiConfigurationField={setApiConfigurationField}
			/>,
		)

		expect(
			screen.getByText("settings:validation.arn.regionMismatch arnRegion=eu-west-1 region=us-east-1"),
		).toBeDefined()
	})
})
