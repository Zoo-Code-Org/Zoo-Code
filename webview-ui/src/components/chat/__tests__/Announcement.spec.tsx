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
		version: "3.78.0",
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
					"Three major new models have arrived — use the brand-new Gemini 3.7 Flash, GLM 5.3, and Qwen3.8 Max models, plus updated DeepSeek V4 reasoning, pricing, and provider coverage.",
				"chat:announcement.release.highlight2":
					"Connect to NanoGPT — use dynamic model discovery, streaming and prompt completions, and routing preferences for speed, price, latency, throughput, tool support, and caching.",
				"chat:announcement.release.highlight3":
					"More reliable providers and tasks — fixes improve Azure OpenAI endpoint setup, Kimi Code output limits, task-history title preservation, and Zoo settings import/export.",
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

		expect(screen.getByText("Zoo Code 3.78.0 Released")).toBeInTheDocument()
		expect(
			screen.getByText(
				"Three major new models have arrived — use the brand-new Gemini 3.7 Flash, GLM 5.3, and Qwen3.8 Max models, plus updated DeepSeek V4 reasoning, pricing, and provider coverage.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Connect to NanoGPT — use dynamic model discovery, streaming and prompt completions, and routing preferences for speed, price, latency, throughput, tool support, and caching.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"More reliable providers and tasks — fixes improve Azure OpenAI endpoint setup, Kimi Code output limits, task-history title preservation, and Zoo settings import/export.",
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
