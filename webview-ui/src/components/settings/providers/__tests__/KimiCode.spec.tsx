import { fireEvent, render, screen } from "@testing-library/react"

import { kimiCodeModels, providerIdentifiers, type ModelRecord } from "@roo-code/types"

import { KimiCode } from "../KimiCode"

const { mockUseRouterModels } = vi.hoisted(() => ({
	mockUseRouterModels: vi.fn(),
}))

vi.mock("@src/components/ui/hooks/useRouterModels", () => ({
	useRouterModels: mockUseRouterModels,
}))

vi.mock("../../ModelPicker", () => ({
	ModelPicker: ({ models }: { models: ModelRecord }) => (
		<div data-testid="kimi-code-model-picker" data-model-ids={JSON.stringify(Object.keys(models))} />
	),
}))

describe("KimiCode settings", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockUseRouterModels.mockReturnValue({
			data: { [providerIdentifiers.kimiCode]: {} },
			refetch: vi.fn(),
			isFetching: false,
		})
	})

	it("defaults to OAuth when no authentication method is configured", () => {
		render(
			<KimiCode
				apiConfiguration={{ apiProvider: providerIdentifiers.kimiCode }}
				setApiConfigurationField={vi.fn()}
			/>,
		)

		expect(screen.getByText("settings:providers.kimiCode.signIn")).toBeInTheDocument()
		expect(screen.queryByTestId("kimi-code-api-key")).not.toBeInTheDocument()
		expect(mockUseRouterModels).toHaveBeenCalledWith({
			provider: providerIdentifiers.kimiCode,
			enabled: false,
		})
	})

	it("uses discovered Kimi Code models when the extension returns models", () => {
		mockUseRouterModels.mockReturnValue({
			data: { [providerIdentifiers.kimiCode]: { "discovered-model": {} } },
			refetch: vi.fn(),
			isFetching: false,
		})

		render(
			<KimiCode
				apiConfiguration={{ apiProvider: providerIdentifiers.kimiCode }}
				setApiConfigurationField={vi.fn()}
			/>,
		)

		expect(screen.getByTestId("kimi-code-model-picker")).toHaveAttribute(
			"data-model-ids",
			JSON.stringify(["discovered-model"]),
		)
	})

	it("falls back to static Kimi Code models when no models are discovered", () => {
		render(
			<KimiCode
				apiConfiguration={{ apiProvider: providerIdentifiers.kimiCode }}
				setApiConfigurationField={vi.fn()}
			/>,
		)

		expect(screen.getByTestId("kimi-code-model-picker")).toHaveAttribute(
			"data-model-ids",
			JSON.stringify(Object.keys(kimiCodeModels)),
		)
	})

	it("binds the API key input through the buffered settings setter", () => {
		const setField = vi.fn()
		render(
			<KimiCode
				apiConfiguration={{ apiProvider: providerIdentifiers.kimiCode, kimiCodeAuthMethod: "api-key" }}
				setApiConfigurationField={setField}
			/>,
		)
		fireEvent.input(screen.getByTestId("kimi-code-api-key"), { target: { value: "new-key" } })
		expect(setField).toHaveBeenCalledWith("kimiCodeApiKey", "new-key")
		expect(screen.getByTestId("kimi-code-model-picker")).toBeInTheDocument()
	})

	it("shows device-code polling state", () => {
		render(
			<KimiCode
				apiConfiguration={{ apiProvider: providerIdentifiers.kimiCode, kimiCodeAuthMethod: "oauth" }}
				setApiConfigurationField={vi.fn()}
				kimiCodeOAuthState={{
					status: "polling",
					userCode: "ABCD-EFGH",
					verificationUri: "https://auth.kimi.com/device",
				}}
			/>,
		)
		expect(screen.getByTestId("kimi-code-device-code")).toHaveTextContent("ABCD-EFGH")
	})
})
