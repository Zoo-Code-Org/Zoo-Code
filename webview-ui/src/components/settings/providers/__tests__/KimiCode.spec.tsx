import { fireEvent, render, screen } from "@testing-library/react"

import { KimiCode } from "../KimiCode"

vi.mock("@src/components/ui/hooks/useRouterModels", () => ({
	useRouterModels: () => ({ data: { "kimi-code": {} }, refetch: vi.fn(), isFetching: false }),
}))

vi.mock("../../ModelPicker", () => ({
	ModelPicker: () => <div data-testid="kimi-code-model-picker" />,
}))

describe("KimiCode settings", () => {
	it("binds the API key input through the buffered settings setter", () => {
		const setField = vi.fn()
		render(
			<KimiCode
				apiConfiguration={{ apiProvider: "kimi-code", kimiCodeAuthMethod: "api-key" }}
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
				apiConfiguration={{ apiProvider: "kimi-code", kimiCodeAuthMethod: "oauth" }}
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
