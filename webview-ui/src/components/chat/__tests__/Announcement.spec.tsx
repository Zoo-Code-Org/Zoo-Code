import React from "react"

import { fireEvent, render, screen } from "@/utils/test-utils"
import { EXTERNAL_LINKS } from "@/constants/externalLinks"
import { vscode } from "@/utils/vscode"

import Announcement from "../Announcement"

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@roo/package", () => ({
	Package: {
		version: "3.88.0",
	},
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
				"chat:announcement.release.heading": "What is new in Zoo Code v3.88.0",
				"chat:announcement.release.highlight1":
					"✨ Provider and model support: Use Grok Build and improved custom-model support. This release also fixes Bedrock model limits and sends the Codex verbosity setting.",
				"chat:announcement.release.highlight2":
					"🧭 Task reliability: This release fixes cancellation handling, tool-turn continuation, and task-message saving.",
				"chat:announcement.release.highlight3":
					"⚡ Faster editing and chat: File writes no longer use artificial delays by default. Chat messages carry less file data, and code actions reach the last active chat.",
			}

			if (key === "chat:announcement.title") {
				return `Zoo Code ${options?.version ?? ""} Released`
			}

			return translations[key] ?? key
		},
	}),
}))

describe("Announcement", () => {
	it("renders the announcement title and highlights", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		expect(screen.getByText("Zoo Code 3.88.0 Released")).toBeInTheDocument()
		expect(screen.getByText("What is new in Zoo Code v3.88.0")).toBeInTheDocument()
		expect(
			screen.getByText(
				"✨ Provider and model support: Use Grok Build and improved custom-model support. This release also fixes Bedrock model limits and sends the Codex verbosity setting.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"🧭 Task reliability: This release fixes cancellation handling, tool-turn continuation, and task-message saving.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"⚡ Faster editing and chat: File writes no longer use artificial delays by default. Chat messages carry less file data, and code actions reach the last active chat.",
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

	it("posts each announcement link to the extension host exactly once", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		fireEvent.click(screen.getByRole("link", { name: "GitHub" }))
		fireEvent.click(screen.getByRole("link", { name: "X" }))
		fireEvent.click(screen.getByRole("link", { name: "Discord" }))
		fireEvent.click(screen.getByRole("link", { name: "Reddit" }))

		expect(vscode.postMessage).toHaveBeenCalledTimes(4)
		expect(vscode.postMessage).toHaveBeenNthCalledWith(1, { type: "openExternal", url: EXTERNAL_LINKS.GITHUB_REPO })
		expect(vscode.postMessage).toHaveBeenNthCalledWith(2, { type: "openExternal", url: "https://x.com/ZooCodeDev" })
		expect(vscode.postMessage).toHaveBeenNthCalledWith(3, {
			type: "openExternal",
			url: "https://discord.gg/VxfP4Vx3gX",
		})
		expect(vscode.postMessage).toHaveBeenNthCalledWith(4, {
			type: "openExternal",
			url: "https://www.reddit.com/r/ZooCode/",
		})
	})

	// VS Code's webview bootstrap intercepts clicks on any anchor with an href
	// at the document level and never checks defaultPrevented, so the
	// announcement links must stop propagation to avoid opening twice.
	it("keeps announcement link clicks from reaching the document level", () => {
		const documentClick = vi.fn()
		document.addEventListener("click", documentClick)

		try {
			render(
				<div>
					<a href="#control">control</a>
					<Announcement hideAnnouncement={vi.fn()} />
				</div>,
			)

			fireEvent.click(screen.getByRole("link", { name: "GitHub" }))
			expect(documentClick).not.toHaveBeenCalled()

			fireEvent.click(screen.getByText("control"))
			expect(documentClick).toHaveBeenCalledTimes(1)
		} finally {
			document.removeEventListener("click", documentClick)
		}
	})

	it("hides the announcement when the dialog closes", () => {
		const hideAnnouncement = vi.fn()
		render(<Announcement hideAnnouncement={hideAnnouncement} />)

		fireEvent.keyDown(document.body, { key: "Escape" })

		expect(hideAnnouncement).toHaveBeenCalledTimes(1)
	})
})
