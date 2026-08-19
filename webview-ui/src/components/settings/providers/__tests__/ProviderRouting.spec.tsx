import { fireEvent, render, screen } from "@testing-library/react"

import { providerIdentifiers, type OrganizationAllowList, type RouterModels } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

import { Unbound } from "../Unbound"
import { VercelAiGateway } from "../VercelAiGateway"

const { modelPickerMock } = vi.hoisted(() => ({ modelPickerMock: vi.fn(() => null) }))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock("@src/components/ui", () => ({
	Button: ({ children, onClick }: React.ComponentProps<"button">) => <button onClick={onClick}>{children}</button>,
}))

vi.mock("../../ModelPicker", () => ({ ModelPicker: modelPickerMock }))
vi.mock("@src/components/common/VSCodeButtonLink", () => ({ VSCodeButtonLink: () => null }))

describe("provider model routing", () => {
	const organizationAllowList: OrganizationAllowList = { allowAll: true, providers: {} }

	beforeEach(() => vi.clearAllMocks())

	it("requests fresh Unbound models when the refresh button is clicked", () => {
		const postMessage = vi.spyOn(vscode, "postMessage").mockImplementation(() => undefined)

		render(
			<Unbound
				apiConfiguration={{ apiProvider: providerIdentifiers.unbound }}
				setApiConfigurationField={vi.fn()}
				refetchRouterModels={vi.fn()}
				organizationAllowList={organizationAllowList}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: "settings:providers.refreshModels.label" }))

		expect(postMessage).toHaveBeenCalledWith({
			type: "requestRouterModels",
			values: { provider: providerIdentifiers.unbound, refresh: true },
		})
	})

	it("passes Vercel AI Gateway models selected by its provider identifier to the model picker", () => {
		const models = { "anthropic/claude": { contextWindow: 1, supportsPromptCache: false } }
		const routerModels = Object.fromEntries(
			Object.values(providerIdentifiers).map((provider) => [provider, {}]),
		) as RouterModels
		routerModels[providerIdentifiers.vercelAiGateway] = models

		render(
			<VercelAiGateway
				apiConfiguration={{ apiProvider: providerIdentifiers.vercelAiGateway }}
				setApiConfigurationField={vi.fn()}
				routerModels={routerModels}
				organizationAllowList={organizationAllowList}
			/>,
		)

		expect(modelPickerMock).toHaveBeenCalledWith(expect.objectContaining({ models }), expect.anything())
	})

	it("passes an empty model set when Vercel AI Gateway models are unavailable", () => {
		render(
			<VercelAiGateway
				apiConfiguration={{ apiProvider: providerIdentifiers.vercelAiGateway }}
				setApiConfigurationField={vi.fn()}
				organizationAllowList={organizationAllowList}
			/>,
		)

		expect(modelPickerMock).toHaveBeenCalledWith(expect.objectContaining({ models: {} }), expect.anything())
	})
})
