import type { FormEvent, ReactNode } from "react"

import { providerIdentifiers, type ProviderSettings } from "@roo-code/types"

import { render, screen, fireEvent } from "@/utils/test-utils"

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
	onInput: (event: FormEvent<HTMLInputElement>) => void
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
	VSCodeTextField: ({ children, value, onInput, "data-testid": testId }: TextFieldMockProps) => (
		<label>
			{children}
			<input defaultValue={value} onInput={onInput} data-testid={testId} />
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

	it("stores Other as an explicit choice", () => {
		const setApiConfigurationField = renderCustomArn({ awsCustomArnBaseModelId: "anthropic.claude-opus-5-5" })

		fireEvent.change(screen.getByTestId("base-model-select"), { target: { value: "other" } })

		expect(setApiConfigurationField).toHaveBeenCalledWith("awsCustomArnBaseModelId", "other")
	})

	it("keeps an explicit Other choice for an ARN that names a model", () => {
		renderCustomArn({
			awsCustomArn: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-8",
			awsCustomArnBaseModelId: "other",
		})

		expect(screen.getByTestId("base-model-select")).toHaveValue("other")
		expect(screen.getByTestId("custom-arn-context-window")).toBeInTheDocument()
	})

	it("shows the named model and locks the selector for a foundation-model ARN", () => {
		renderCustomArn({
			awsCustomArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0",
			awsCustomArnBaseModelId: "anthropic.claude-opus-5-5",
		})

		const select = screen.getByTestId("base-model-select")
		expect(select).toHaveValue("anthropic.claude-3-5-sonnet-20241022-v2:0")
		expect(select).toBeDisabled()
	})

	it("leaves the selector enabled for ARNs that don't invoke a fixed model", () => {
		renderCustomArn()

		expect(screen.getByTestId("base-model-select")).toBeEnabled()
	})

	it("clears the base model and per-ARN limits when the ARN changes", () => {
		const setApiConfigurationField = renderCustomArn({
			awsCustomArnBaseModelId: "anthropic.claude-opus-5-5",
			awsModelContextWindow: 32_000,
			modelMaxTokens: 2048,
		})
		const otherArn = "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/other1234567"

		fireEvent.input(screen.getByTestId("custom-arn-input"), { target: { value: otherArn } })

		expect(setApiConfigurationField).toHaveBeenCalledWith("awsCustomArn", otherArn)
		expect(setApiConfigurationField).toHaveBeenCalledWith("awsCustomArnBaseModelId", "")
		expect(setApiConfigurationField).toHaveBeenCalledWith("awsModelContextWindow", undefined)
		expect(setApiConfigurationField).toHaveBeenCalledWith("modelMaxTokens", undefined)
		expect(setApiConfigurationField).toHaveBeenCalledWith("modelMaxThinkingTokens", undefined)
		expect(setApiConfigurationField).toHaveBeenCalledWith("reasoningEffort", undefined)
	})

	it("stores the first ARN entered when none is set yet", () => {
		const setApiConfigurationField = renderCustomArn({ awsCustomArn: undefined })

		fireEvent.input(screen.getByTestId("custom-arn-input"), { target: { value: appProfileArn } })

		expect(setApiConfigurationField).toHaveBeenCalledWith("awsCustomArn", appProfileArn)
		expect(setApiConfigurationField).toHaveBeenCalledWith("awsCustomArnBaseModelId", "")
	})

	it("keeps the base model when the ARN input doesn't change the ARN", () => {
		const setApiConfigurationField = renderCustomArn({ awsCustomArnBaseModelId: "anthropic.claude-opus-5-5" })

		fireEvent.input(screen.getByTestId("custom-arn-input"), { target: { value: appProfileArn } })

		expect(setApiConfigurationField).not.toHaveBeenCalled()
	})

	it("stores positive integer limits and clears invalid input", () => {
		const setApiConfigurationField = renderCustomArn()

		fireEvent.input(screen.getByTestId("custom-arn-context-window"), { target: { value: "32000" } })
		fireEvent.input(screen.getByTestId("custom-arn-max-tokens"), { target: { value: "2048" } })
		fireEvent.input(screen.getByTestId("custom-arn-max-tokens"), { target: { value: "abc" } })

		expect(setApiConfigurationField).toHaveBeenCalledWith("awsModelContextWindow", 32000)
		expect(setApiConfigurationField).toHaveBeenCalledWith("modelMaxTokens", 2048)
		expect(setApiConfigurationField).toHaveBeenLastCalledWith("modelMaxTokens", undefined)
	})
})
