import React from "react"

import { render, screen } from "@/utils/test-utils"
import { EXTERNAL_LINKS } from "@/constants/externalLinks"

import Announcement from "../Announcement"

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@roo/package", () => ({
	Package: {
		version: "3.55.0",
	},
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children, href, onClick, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
		<a href={href} onClick={onClick} {...props}>
			{children}
		</a>
	),
}))

vi.mock("react-i18next", () => ({
	Trans: ({ i18nKey, components }: { i18nKey: string; components?: Record<string, React.ReactElement> }) => {
		if (i18nKey === "chat:announcement.support" && components?.githubLink) {
			return React.cloneElement(components.githubLink, undefined, "GitHub")
		}

		return <span>{i18nKey}</span>
	},
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: { version?: string }) => {
			const translations: Record<string, string> = {
				"chat:announcement.release.heading": "What's New:",
				"chat:announcement.release.highlight1":
					"Xiaomi MiMo provider: Added Xiaomi MiMo as a first-class API provider so you can configure MiMo models directly in Zoo Code.",
				"chat:announcement.release.highlight2":
					"Upstream Zoo Code handoff: Pulled in the latest upstream sunset merge and related platform updates to keep Zoo Code aligned with the community handoff work.",
				"chat:announcement.release.highlight3":
					"Stability fixes across chat and providers: Fixed MCP sign-in copy, Gemini full-tool requests, OpenAI temperature handling, and Markdown single-tilde rendering.",
				"chat:announcement.handoff.heading": "The Roo Code plugin is not going away.",
			}

			if (key === "chat:announcement.title" || key === "chat:announcement.finalRelease.title") {
				return `Zoo Code ${options?.version ?? ""} Released`
			}

			return translations[key] ?? key
		},
	}),
}))

describe("Announcement", () => {
	it("renders the announcement title and highlights", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		expect(screen.getByText("Zoo Code 3.55.0 Released")).toBeInTheDocument()
		expect(
			screen.getByText(
				"Xiaomi MiMo provider: Added Xiaomi MiMo as a first-class API provider so you can configure MiMo models directly in Zoo Code.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Upstream Zoo Code handoff: Pulled in the latest upstream sunset merge and related platform updates to keep Zoo Code aligned with the community handoff work.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Stability fixes across chat and providers: Fixed MCP sign-in copy, Gemini full-tool requests, OpenAI temperature handling, and Markdown single-tilde rendering.",
			),
		).toBeInTheDocument()
	})

	it("renders exactly three release highlight bullets", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		expect(screen.getAllByRole("listitem")).toHaveLength(3)
	})

	it("links support users to the Zoo Code GitHub repository", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		expect(screen.getByRole("link", { name: "GitHub" })).toHaveAttribute("href", EXTERNAL_LINKS.GITHUB_REPO)
	})
})
