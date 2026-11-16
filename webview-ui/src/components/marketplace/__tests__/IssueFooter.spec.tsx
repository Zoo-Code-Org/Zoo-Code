import React from "react"
import { screen } from "@/utils/test-utils"

import i18next from "@src/i18n/setup"
import { renderTranslated } from "@src/i18n/__tests__/renderTranslated"
import { EXTERNAL_LINKS } from "@/constants/externalLinks"

import { IssueFooter } from "../IssueFooter"

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
		<a href={href} {...props}>
			{children}
		</a>
	),
}))

describe("IssueFooter", () => {
	beforeEach(async () => {
		await i18next.changeLanguage("en")
	})

	it("links marketplace issue reporting to the Zoo Code repository", () => {
		renderTranslated(<IssueFooter />)

		expect(screen.getByRole("link", { name: "Open a GitHub issue" })).toHaveAttribute(
			"href",
			EXTERNAL_LINKS.MARKETPLACE_ISSUE,
		)
	})

	it("resolves the footer text and follows a UI language change", async () => {
		const { container, setLanguage } = renderTranslated(<IssueFooter />)

		expect(container.textContent).toBe(
			"Found a problem with a marketplace item or have suggestions for new ones? Open a GitHub issue to let us know!",
		)

		await setLanguage("es")

		expect(container.textContent).toBe(
			"¿Encontraste un problema con un elemento del marketplace o tienes sugerencias para nuevos? ¡Abre un issue en GitHub para hacérnoslo saber!",
		)
		expect(screen.getByRole("link", { name: "Abre un issue en GitHub" })).toHaveAttribute(
			"href",
			EXTERNAL_LINKS.MARKETPLACE_ISSUE,
		)
	})
})
