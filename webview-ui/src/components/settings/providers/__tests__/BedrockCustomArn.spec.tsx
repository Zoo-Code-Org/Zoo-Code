import type { ChangeEvent, ReactNode } from "react"

import { providerIdentifiers, type ProviderSettings } from "@roo-code/types"

import { render, screen, fireEvent } from "@/utils/test-utils"

import { BedrockCustomArn } from "../BedrockCustomArn"

type SelectMockProps = { children: ReactNode; value: string; onValueChange: (value: string) => void }
type TextFieldMockProps = {
	children: ReactNode
	value: string
	onInput: (event: ChangeEvent<HTMLInputElement>) => void
	"data-testid"?: string
}

vi.mock("@src/components/ui", () => ({
	Select: ({ children, value, onValueChange }: SelectMockProps) => (
		<select data-testid="base-model-select" value={value} onChange={(e) => onValueChange(e.target.value)}>
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
	VSCodeTextField: ({ children, value, onInput, "data-testid": testId }: TextFieldMockProps) => (
		<label>
			{children}
			<input value={value} onChange={onInput} data-testid={testId} />
		</label>
	),
}))

describe("BedrockCustomArn base model", () => {
	const appProfileArn = "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/abcd1234efgh"

	const renderCustomArn = (settings: Partial<ProviderSettings> = {}) => {
		const setApiConfigurationField = vi.fn()
		render(
			<BedrockCustomArn
				apiConfiguration={{
					apiProvider: providerIdentifiers.bedrock,
					apiModelId: "custom-arn",
					awsCustomArn: appProfileArn,
					...settings,
				}}
				setApiConfigurationField={setApiConfigurationField}
			/>,
		)
		return setApiConfigurationField
	}

	it("defaults to Other with context window and max output fields for an ARN that doesn't name its model", () => {
		renderCustomArn()

		expect(screen.getByTestId("base-model-select")).toHaveValue("other")
		expect(screen.getByTestId("custom-arn-context-window")).toBeInTheDocument()
		expect(screen.getByTestId("custom-arn-max-tokens")).toBeInTheDocument()
	})

	it("stores the selected base model and resets model-specific limits", () => {
		const setApiConfigurationField = renderCustomArn()

		fireEvent.change(screen.getByTestId("base-model-select"), { target: { value: "anthropic.claude-opus-5-5" } })

		expect(setApiConfigurationField).toHaveBeenCalledWith("awsCustomArnBaseModelId", "anthropic.claude-opus-5-5")
		expect(setApiConfigurationField).toHaveBeenCalledWith("modelMaxTokens", undefined)
		expect(setApiConfigurationField).toHaveBeenCalledWith("awsModelContextWindow", undefined)
	})

	it("hides the manual limits when a listed base model is selected", () => {
		renderCustomArn({ awsCustomArnBaseModelId: "anthropic.claude-opus-5-5" })

		expect(screen.getByTestId("base-model-select")).toHaveValue("anthropic.claude-opus-5-5")
		expect(screen.queryByTestId("custom-arn-context-window")).not.toBeInTheDocument()
	})

	it("shows a model detected from the ARN as the selected base model", () => {
		renderCustomArn({
			awsCustomArn: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-8",
		})

		expect(screen.getByTestId("base-model-select")).toHaveValue("anthropic.claude-opus-4-8")
	})

	it("stores Other as an empty base model", () => {
		const setApiConfigurationField = renderCustomArn({ awsCustomArnBaseModelId: "anthropic.claude-opus-5-5" })

		fireEvent.change(screen.getByTestId("base-model-select"), { target: { value: "other" } })

		expect(setApiConfigurationField).toHaveBeenCalledWith("awsCustomArnBaseModelId", "")
	})

	it("stores positive integer limits and clears invalid input", () => {
		const setApiConfigurationField = renderCustomArn()

		fireEvent.change(screen.getByTestId("custom-arn-context-window"), { target: { value: "32000" } })
		fireEvent.change(screen.getByTestId("custom-arn-max-tokens"), { target: { value: "2048" } })
		fireEvent.change(screen.getByTestId("custom-arn-max-tokens"), { target: { value: "abc" } })

		expect(setApiConfigurationField).toHaveBeenCalledWith("awsModelContextWindow", 32000)
		expect(setApiConfigurationField).toHaveBeenCalledWith("modelMaxTokens", 2048)
		expect(setApiConfigurationField).toHaveBeenLastCalledWith("modelMaxTokens", undefined)
	})
})
