import { render, screen, fireEvent } from "@/utils/test-utils"

import MarkdownBlock from "../MarkdownBlock"

const { mockPostMessage } = vi.hoisted(() => ({
	mockPostMessage: vi.fn(),
}))

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: mockPostMessage,
	},
}))

beforeEach(() => {
	mockPostMessage.mockClear()
})

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		theme: "dark",
	}),
}))

describe("MarkdownBlock", () => {
	it("should correctly handle URLs with trailing punctuation", async () => {
		const markdown = "Check out this link: https://example.com."
		const { container } = render(<MarkdownBlock markdown={markdown} />)

		// Wait for the content to be processed
		await screen.findByText(/Check out this link/, { exact: false })

		// Check for nested links - this should not happen
		const nestedLinks = container.querySelectorAll("a a")
		expect(nestedLinks.length).toBe(0)

		// Should have exactly one link
		const linkElement = screen.getByRole("link")
		expect(linkElement).toHaveAttribute("href", "https://example.com")
		expect(linkElement.textContent).toBe("https://example.com")

		// Check that the period is outside the link
		const paragraph = container.querySelector("p")
		expect(paragraph?.textContent).toBe("Check out this link: https://example.com.")
	}, 10000)

	it("should not strikethrough text wrapped in a single tilde (#154)", async () => {
		const markdown = "1. Lorem ~10 ipsum dolor sit 1~3 amet."
		const { container } = render(<MarkdownBlock markdown={markdown} />)

		await screen.findByText(/Lorem/, { exact: false })

		// Single tildes around numbers must NOT become strikethrough.
		expect(container.querySelectorAll("del").length).toBe(0)
		const listItem = container.querySelector("li")
		expect(listItem?.textContent).toContain("~10")
		expect(listItem?.textContent).toContain("1~3")
	}, 10000)

	it("should still strikethrough text wrapped in double tildes", async () => {
		const markdown = "This is ~~struck~~ text."
		const { container } = render(<MarkdownBlock markdown={markdown} />)

		await screen.findByText(/struck/, { exact: false })

		const del = container.querySelector("del")
		expect(del).not.toBeNull()
		expect(del?.textContent).toBe("struck")
	}, 10000)

	it("should render unordered lists with proper styling", async () => {
		const markdown = `Here are some items:
- First item
- Second item
  - Nested item
  - Another nested item`

		const { container } = render(<MarkdownBlock markdown={markdown} />)

		// Wait for the content to be processed
		await screen.findByText(/Here are some items/, { exact: false })

		// Check that ul elements exist
		const ulElements = container.querySelectorAll("ul")
		expect(ulElements.length).toBeGreaterThan(0)

		// Check that list items exist
		const liElements = container.querySelectorAll("li")
		expect(liElements.length).toBe(4)

		// Verify the text content
		expect(screen.getByText("First item")).toBeInTheDocument()
		expect(screen.getByText("Second item")).toBeInTheDocument()
		expect(screen.getByText("Nested item")).toBeInTheDocument()
		expect(screen.getByText("Another nested item")).toBeInTheDocument()
	})

	it("should render ordered lists with proper styling", async () => {
		const markdown = `And a numbered list:
1. Step one
2. Step two
3. Step three`

		const { container } = render(<MarkdownBlock markdown={markdown} />)

		// Wait for the content to be processed
		await screen.findByText(/And a numbered list/, { exact: false })

		// Check that ol elements exist
		const olElements = container.querySelectorAll("ol")
		expect(olElements.length).toBe(1)

		// Check that list items exist
		const liElements = container.querySelectorAll("li")
		expect(liElements.length).toBe(3)

		// Verify the text content
		expect(screen.getByText("Step one")).toBeInTheDocument()
		expect(screen.getByText("Step two")).toBeInTheDocument()
		expect(screen.getByText("Step three")).toBeInTheDocument()
	})

	it.each([
		["NOTE", "note", "codicon-info"],
		["TIP", "tip", "codicon-lightbulb"],
		["IMPORTANT", "important", "codicon-report"],
		["WARNING", "warning", "codicon-warning"],
		["CAUTION", "caution", "codicon-flame"],
	])(
		"renders a [!%s] GitHub-style alert (#258)",
		async (marker, type, iconClass) => {
			const markdown = `> [!${marker}]\n> Body content here.`
			const { container } = render(<MarkdownBlock markdown={markdown} />)

			await screen.findByText(/Body content here/, { exact: false })

			const alert = container.querySelector(`blockquote[data-alert-type="${type}"]`)
			expect(alert).not.toBeNull()
			expect(alert?.classList.contains("markdown-alert")).toBe(true)
			expect(alert?.classList.contains(`markdown-alert-${type}`)).toBe(true)

			// Distinct icon for the alert type.
			expect(alert?.querySelector(`.${iconClass}`)).not.toBeNull()

			// The raw "[!TYPE]" marker must not leak into the rendered text.
			expect(alert?.textContent).not.toContain(`[!${marker}]`)
			expect(alert?.textContent).toContain("Body content here.")
		},
		10000,
	)

	it("recognizes alert markers case-insensitively", async () => {
		const markdown = `> [!note]\n> lowercase marker`
		const { container } = render(<MarkdownBlock markdown={markdown} />)

		await screen.findByText(/lowercase marker/, { exact: false })

		expect(container.querySelector('blockquote[data-alert-type="note"]')).not.toBeNull()
	}, 10000)

	it("renders alert content with inline markdown (bold, code, links)", async () => {
		const markdown = `> [!WARNING]\n> Be **careful** with \`rm -rf\` and see [docs](https://example.com).`
		const { container } = render(<MarkdownBlock markdown={markdown} />)

		await screen.findByText(/careful/, { exact: false })

		const alert = container.querySelector('blockquote[data-alert-type="warning"]')
		expect(alert).not.toBeNull()
		expect(alert?.querySelector("strong")?.textContent).toBe("careful")
		expect(alert?.querySelector("code")?.textContent).toBe("rm -rf")
		expect(alert?.querySelector("a")).toHaveAttribute("href", "https://example.com")
	}, 10000)

	it("keeps a normal blockquote rendering unchanged", async () => {
		const markdown = `> Just an ordinary quote.\n> Second line.`
		const { container } = render(<MarkdownBlock markdown={markdown} />)

		await screen.findByText(/ordinary quote/, { exact: false })

		const blockquote = container.querySelector("blockquote")
		expect(blockquote).not.toBeNull()
		expect(blockquote?.hasAttribute("data-alert-type")).toBe(false)
		expect(blockquote?.classList.contains("markdown-alert")).toBe(false)
		// No injected alert title/icon for normal blockquotes.
		expect(blockquote?.querySelector(".markdown-alert-title")).toBeNull()
		expect(blockquote?.querySelector(".codicon")).toBeNull()
	}, 10000)

	it("treats an unsupported marker as a normal blockquote", async () => {
		const markdown = `> [!INFO]\n> Not a supported alert type.`
		const { container } = render(<MarkdownBlock markdown={markdown} />)

		await screen.findByText(/Not a supported alert type/, { exact: false })

		const blockquote = container.querySelector("blockquote")
		expect(blockquote?.hasAttribute("data-alert-type")).toBe(false)
		// The raw marker text remains visible since it was not recognized.
		expect(blockquote?.textContent).toContain("[!INFO]")
	}, 10000)

	it("should render nested lists with proper hierarchy", async () => {
		const markdown = `Complex list:
1. First level ordered
   - Second level unordered
   - Another second level
     1. Third level ordered
     2. Another third level
2. Back to first level`

		const { container } = render(<MarkdownBlock markdown={markdown} />)

		// Wait for the content to be processed
		await screen.findByText(/Complex list/, { exact: false })

		// Check nested structure
		const olElements = container.querySelectorAll("ol")
		const ulElements = container.querySelectorAll("ul")

		expect(olElements.length).toBeGreaterThan(0)
		expect(ulElements.length).toBeGreaterThan(0)

		// Verify all text is rendered
		expect(screen.getByText("First level ordered")).toBeInTheDocument()
		expect(screen.getByText("Second level unordered")).toBeInTheDocument()
		expect(screen.getByText("Third level ordered")).toBeInTheDocument()
		expect(screen.getByText("Back to first level")).toBeInTheDocument()
	})

	describe("Context mentions (#559)", () => {
		it("renders @/path/file.ts as a clickable mention span", async () => {
			const markdown = "Check out @/src/components/chat/TaskHeader.tsx for details."
			const { container } = render(<MarkdownBlock markdown={markdown} />)

			await screen.findByText(/Check out/, { exact: false })

			// The mention should be wrapped in a span with the mention-context-highlight class.
			const mentions = container.querySelectorAll("span.mention-context-highlight")
			expect(mentions.length).toBe(1)
			expect(mentions[0].textContent).toBe("@/src/components/chat/TaskHeader.tsx")

			// The trailing period must remain outside the mention span.
			expect(container.querySelector("p")?.textContent).toBe(
				"Check out @/src/components/chat/TaskHeader.tsx for details.",
			)
		})

		it("renders @problems as a clickable mention span", async () => {
			const markdown = "Review the issues listed in @problems before proceeding."
			const { container } = render(<MarkdownBlock markdown={markdown} />)

			await screen.findByText(/Review/, { exact: false })

			const mentions = container.querySelectorAll("span.mention-context-highlight")
			expect(mentions.length).toBe(1)
			expect(mentions[0].textContent).toBe("@problems")
		})

		it("renders @terminal as a clickable mention span", async () => {
			const markdown = "See the output captured in @terminal."
			const { container } = render(<MarkdownBlock markdown={markdown} />)

			await screen.findByText(/See/, { exact: false })

			const mentions = container.querySelectorAll("span.mention-context-highlight")
			expect(mentions.length).toBe(1)
			expect(mentions[0].textContent).toBe("@terminal")
		})

		it("renders multiple mentions in the same paragraph", async () => {
			const markdown = "Check @/src/file.ts and @problems, then review @terminal."
			const { container } = render(<MarkdownBlock markdown={markdown} />)

			await screen.findByText(/Check/, { exact: false })

			const mentions = container.querySelectorAll("span.mention-context-highlight")
			expect(mentions.length).toBe(3)
			expect(mentions[0].textContent).toBe("@/src/file.ts")
			expect(mentions[1].textContent).toBe("@problems")
			expect(mentions[2].textContent).toBe("@terminal")
		})

		it("posts openMention message when a mention span is clicked", async () => {
			const markdown = "See @/src/components/chat/TaskHeader.tsx."
			const { container } = render(<MarkdownBlock markdown={markdown} />)

			await screen.findByText(/See/, { exact: false })

			const mentionSpan = container.querySelector("span.mention-context-highlight")!
			fireEvent.click(mentionSpan)

			expect(mockPostMessage).toHaveBeenCalledWith({
				type: "openMention",
				text: "/src/components/chat/TaskHeader.tsx",
			})
		})

		it("does not match @ in the middle of a word or log entry", async () => {
			const markdown = "Error: Failed@localhost/status code 404."
			const { container } = render(<MarkdownBlock markdown={markdown} />)

			await screen.findByText(/Error/, { exact: false })

			const mentions = container.querySelectorAll("span.mention-context-highlight")
			expect(mentions.length).toBe(0)
		})

		it("keeps mention patterns literal inside fenced code blocks", async () => {
			const markdown = "```bash\necho hello @problems\n```"
			const { container } = render(<MarkdownBlock markdown={markdown} />)

			await screen.findByText(/echo/, { exact: false })

			// Code is literal content: the mention must stay plain text, not become a
			// clickable span (which would also make the text vanish from CodeBlock).
			expect(container.querySelector("code")?.textContent).toBe("echo hello @problems\n")
			expect(container.querySelectorAll("span.mention-context-highlight").length).toBe(0)
		})

		it("keeps mention patterns literal inside inline code", async () => {
			const markdown = "Use `@problems` carefully."
			const { container } = render(<MarkdownBlock markdown={markdown} />)

			await screen.findByText(/Use/, { exact: false })

			expect(container.querySelector("code")?.textContent).toBe("@problems")
			expect(container.querySelectorAll("span.mention-context-highlight").length).toBe(0)
		})

		it("makes mentions keyboard operable (role=button, tabIndex, Enter/Space)", async () => {
			const markdown = "See @terminal."
			const { container } = render(<MarkdownBlock markdown={markdown} />)

			await screen.findByText(/See/, { exact: false })

			const mention = container.querySelector("span.mention-context-highlight")!
			expect(mention.getAttribute("role")).toBe("button")
			expect(mention.getAttribute("tabindex")).toBe("0")

			fireEvent.keyDown(mention, { key: "Enter" })
			expect(mockPostMessage).toHaveBeenCalledWith({ type: "openMention", text: "terminal" })

			mockPostMessage.mockClear()
			fireEvent.keyDown(mention, { key: " " })
			expect(mockPostMessage).toHaveBeenCalledWith({ type: "openMention", text: "terminal" })

			mockPostMessage.mockClear()
			fireEvent.keyDown(mention, { key: "a" })
			expect(mockPostMessage).not.toHaveBeenCalled()
		})

		it("preserves regular text around mentions", async () => {
			const markdown = "Before @problems middle after"
			const { container } = render(<MarkdownBlock markdown={markdown} />)

			await screen.findByText(/Before/, { exact: false })

			const paragraph = container.querySelector("p")
			expect(paragraph?.textContent).toBe("Before @problems middle after")

			// The mention span should only contain the mention itself.
			const mentions = container.querySelectorAll("span.mention-context-highlight")
			expect(mentions.length).toBe(1)
			expect(mentions[0].textContent).toBe("@problems")
		})
	})
})
