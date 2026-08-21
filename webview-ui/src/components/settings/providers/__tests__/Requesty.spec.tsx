import { fireEvent, render, screen } from "@testing-library/react"

import { providerIdentifiers, type OrganizationAllowList } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

import { Requesty } from "../Requesty"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	VSCodeCheckbox: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock("@src/components/ui", () => ({
	Button: ({ children, onClick }: React.ComponentProps<"button">) => (
		<button data-testid="refresh-button" onClick={onClick}>
			{children}
		</button>
	),
}))

vi.mock("../../ModelPicker", () => ({ ModelPicker: () => null }))
vi.mock("../RequestyBalanceDisplay", () => ({ RequestyBalanceDisplay: () => null }))

describe("Requesty", () => {
	const organizationAllowList: OrganizationAllowList = { allowAll: true, providers: {} }

	it("uses the canonical Requesty identifier for OAuth and model refresh", () => {
		const postMessage = vi.spyOn(vscode, "postMessage").mockImplementation(() => undefined)

		render(
			<Requesty
				apiConfiguration={{ apiProvider: providerIdentifiers.requesty }}
				setApiConfigurationField={vi.fn()}
				refetchRouterModels={vi.fn()}
				organizationAllowList={organizationAllowList}
				uriScheme="vscode"
			/>,
		)

		const href = screen.getByRole("link").getAttribute("href")
		expect(href).not.toBeNull()
		const callbackUrl = new URL(href!).searchParams.get("callback_url")
		expect(callbackUrl).not.toBeNull()
		expect(new URL(callbackUrl!).pathname).toMatch(new RegExp(`/${providerIdentifiers.requesty}$`))

		fireEvent.click(screen.getByTestId("refresh-button"))
		expect(postMessage).toHaveBeenCalledWith({
			type: "requestRouterModels",
			values: { provider: providerIdentifiers.requesty, refresh: true },
		})
	})
})
