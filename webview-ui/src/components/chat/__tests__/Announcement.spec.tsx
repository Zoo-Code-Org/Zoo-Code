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
		version: "3.90.0",
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
				"chat:announcement.release.heading": "What is new in Zoo Code v3.90.0",
				"chat:announcement.release.highlight1":
					"✨ Providers and models: GitHub Copilot is now a provider: sign in and Zoo Code loads your Copilot models. IO Intelligence is a provider with its own API key. Gemini 4 Argon is on Gemini and Vertex. GPT-6 Luna is on OpenCode Go. Gemini 4 Argon and GPT-6 Luna are on Zoo Gateway as well.",
				"chat:announcement.release.highlight2":
					"🧭 Tool execution: Repeating the same tool call gets a warning, then Zoo Code stops that loop. Disabling attempt_completion no longer leaves a task unable to finish. Queued messages run the same command-protection checks as commands you send directly.",
				"chat:announcement.release.highlight3":
					"⚡ Reasoning and streaming: Anthropic adaptive thinking shows in chat, and thinking tokens are counted. The R1 toggle keeps reasoning from llama.cpp, Ollama, and LM Studio. Codex keeps encrypted reasoning with the summary you see. VS Code language-model streams use guarded recovery when a stream fails.",
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

		expect(screen.getByText("Zoo Code 3.90.0 Released")).toBeInTheDocument()
		expect(screen.getByText("What is new in Zoo Code v3.90.0")).toBeInTheDocument()
		expect(
			screen.getByText(
				"✨ Providers and models: GitHub Copilot is now a provider: sign in and Zoo Code loads your Copilot models. IO Intelligence is a provider with its own API key. Gemini 4 Argon is on Gemini and Vertex. GPT-6 Luna is on OpenCode Go. Gemini 4 Argon and GPT-6 Luna are on Zoo Gateway as well.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"🧭 Tool execution: Repeating the same tool call gets a warning, then Zoo Code stops that loop. Disabling attempt_completion no longer leaves a task unable to finish. Queued messages run the same command-protection checks as commands you send directly.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"⚡ Reasoning and streaming: Anthropic adaptive thinking shows in chat, and thinking tokens are counted. The R1 toggle keeps reasoning from llama.cpp, Ollama, and LM Studio. Codex keeps encrypted reasoning with the summary you see. VS Code language-model streams use guarded recovery when a stream fails.",
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
