import React from "react"
import { render, screen } from "@/utils/test-utils"

import { EXTERNAL_LINKS } from "@/constants/externalLinks"

import { IssueFooter } from "../IssueFooter"

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
		<a href={href} {...props}>
			{children}
		</a>
	),
}))

vi.mock("react-i18next", () => ({
	Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

describe("IssueFooter", () => {
	it("links marketplace issue reporting to the Zoo Code repository", () => {
		render(<IssueFooter />)

		expect(screen.getByRole("link", { name: "Open a GitHub issue" })).toHaveAttribute(
			"href",
			EXTERNAL_LINKS.MARKETPLACE_ISSUE,
		)
	})
})
