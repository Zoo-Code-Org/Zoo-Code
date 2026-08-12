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
		version: "3.74.0",
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
					"More OpenAI controls — use Fast priority mode with OpenAI Codex and choose higher reasoning effort for OpenAI-compatible models.",
				"chat:announcement.release.highlight2":
					"More reliable providers and models — improved router metadata handling, Ollama model refresh, Bedrock proxy support, and Friendli reasoning controls.",
				"chat:announcement.release.highlight3":
					"Smoother settings and developer workflows — settings now preserve unsaved edits, short terminal commands complete cleanly, architect plans use workspace-relative paths, and remaining user-facing Roo branding is updated to Zoo.",
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

		expect(screen.getByText("Zoo Code 3.74.0 Released")).toBeInTheDocument()
		expect(
			screen.getByText(
				"More OpenAI controls — use Fast priority mode with OpenAI Codex and choose higher reasoning effort for OpenAI-compatible models.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"More reliable providers and models — improved router metadata handling, Ollama model refresh, Bedrock proxy support, and Friendli reasoning controls.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Smoother settings and developer workflows — settings now preserve unsaved edits, short terminal commands complete cleanly, architect plans use workspace-relative paths, and remaining user-facing Roo branding is updated to Zoo.",
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
