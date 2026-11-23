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
		version: "3.98.2",
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
				"chat:announcement.release.heading": "What is new in Zoo Code v3.98.2",
				"chat:announcement.release.highlight0":
					"💫Preview the Zoo Pass with unlimited GLM-5.3-Flash free until Dec 1 with any amount of money on your Zoo Gateway account.",
				"chat:announcement.release.highlight0Url": "https://zoocode.dev/pass",
				"chat:announcement.release.highlight1":
					"🔌 Models: Use Gemini 3.8 Flash and the new Gemini 4 Carbon, Hydrogen, and Neon models. Set xhigh thinking on Gemini.",
				"chat:announcement.release.highlight2":
					"🌐 Responses API: Turn on Responses API support for OpenAI Compatible providers. Reasoning with tool use works on endpoints that require it.",
				"chat:announcement.release.highlight3":
					"🔧 Fixes: Vertex Gemini requests no longer end on a model turn. Gemini thought signatures stay intact through LiteLLM. Ollama tasks condense at the configured context limit.",
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

		expect(screen.getByText("Zoo Code 3.98.2 Released")).toBeInTheDocument()
		expect(screen.getByText("What is new in Zoo Code v3.98.2")).toBeInTheDocument()
		const zooPassHighlight = screen.getAllByRole("listitem")[0]
		expect(zooPassHighlight).toHaveTextContent(
			"💫Preview the Zoo Pass with unlimited GLM-5.3-Flash free until Dec 1 with any amount of money on your Zoo Gateway account.",
		)
		expect(zooPassHighlight).toHaveTextContent("https://zoocode.dev/pass")
		expect(
			screen.getByText(
				"🔌 Models: Use Gemini 3.8 Flash and the new Gemini 4 Carbon, Hydrogen, and Neon models. Set xhigh thinking on Gemini.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"🌐 Responses API: Turn on Responses API support for OpenAI Compatible providers. Reasoning with tool use works on endpoints that require it.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"🔧 Fixes: Vertex Gemini requests no longer end on a model turn. Gemini thought signatures stay intact through LiteLLM. Ollama tasks condense at the configured context limit.",
			),
		).toBeInTheDocument()
	})

	it("renders four release highlight bullets with Zoo Pass first", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		const highlights = screen.getAllByRole("listitem")
		expect(screen.getByRole("list")).toHaveClass("list-none", "p-0")
		expect(highlights).toHaveLength(4)
		expect(highlights[0]).toHaveTextContent(
			"💫Preview the Zoo Pass with unlimited GLM-5.3-Flash free until Dec 1 with any amount of money on your Zoo Gateway account.https://zoocode.dev/pass",
		)
	})

	it("links support users to the Zoo Code GitHub repository", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		expect(screen.getByRole("link", { name: "GitHub" })).toHaveAttribute("href", EXTERNAL_LINKS.GITHUB_REPO)
	})

	it("posts each announcement link to the extension host exactly once", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		fireEvent.click(screen.getByRole("link", { name: "https://zoocode.dev/pass" }))
		fireEvent.click(screen.getByRole("link", { name: "GitHub" }))
		fireEvent.click(screen.getByRole("link", { name: "X" }))
		fireEvent.click(screen.getByRole("link", { name: "Discord" }))
		fireEvent.click(screen.getByRole("link", { name: "Reddit" }))

		expect(vscode.postMessage).toHaveBeenCalledTimes(5)
		expect(vscode.postMessage).toHaveBeenNthCalledWith(1, {
			type: "openExternal",
			url: "https://zoocode.dev/pass",
		})
		expect(vscode.postMessage).toHaveBeenNthCalledWith(2, { type: "openExternal", url: EXTERNAL_LINKS.GITHUB_REPO })
		expect(vscode.postMessage).toHaveBeenNthCalledWith(3, { type: "openExternal", url: "https://x.com/ZooCodeDev" })
		expect(vscode.postMessage).toHaveBeenNthCalledWith(4, {
			type: "openExternal",
			url: "https://discord.gg/VxfP4Vx3gX",
		})
		expect(vscode.postMessage).toHaveBeenNthCalledWith(5, {
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
