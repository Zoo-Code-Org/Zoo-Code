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
		version: "3.53.0",
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
				"chat:announcement.release.gpt55":
					"GPT-5.5 via OpenAI Codex: Added GPT-5.5 support in the OpenAI Codex provider so you can use the latest model straight from Zoo Code.",
				"chat:announcement.release.claudeOpus47":
					"Claude Opus 4.7 on Vertex AI: Added Claude Opus 4.7 to the Vertex AI provider for Anthropic's newest flagship reasoning model.",
				"chat:announcement.release.checkpointNav":
					"Previous Checkpoint Navigation: Added controls in chat to jump back through prior checkpoints, with full i18n support.",
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
	it("renders the v3.53.0 announcement title and highlights", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		expect(screen.getByText("Zoo Code 3.53.0 Released")).toBeInTheDocument()
		expect(
			screen.getByText(
				"GPT-5.5 via OpenAI Codex: Added GPT-5.5 support in the OpenAI Codex provider so you can use the latest model straight from Zoo Code.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Claude Opus 4.7 on Vertex AI: Added Claude Opus 4.7 to the Vertex AI provider for Anthropic's newest flagship reasoning model.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Previous Checkpoint Navigation: Added controls in chat to jump back through prior checkpoints, with full i18n support.",
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
