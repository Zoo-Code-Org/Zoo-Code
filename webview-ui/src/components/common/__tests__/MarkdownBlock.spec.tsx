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
		it("keeps mention patterns inert when the mentions prop is not set", async () => {
			// Mentions are only actionable where text is user-authored. Assistant
			// content rendered through the default MarkdownBlock must keep mention
			// patterns as plain, non-interactive text.
			const markdown = "Check @/src/file.ts and @problems."
			const { container } = render(<MarkdownBlock markdown={markdown} />)

			await screen.findByText(/Check/, { exact: false })

			expect(container.querySelectorAll("span.mention-context-highlight").length).toBe(0)
			expect(container.querySelector("p")?.textContent).toBe("Check @/src/file.ts and @problems.")
		})

		it("renders @/path/file.ts as a clickable mention span", async () => {
			const markdown = "Check out @/src/components/chat/TaskHeader.tsx for details."
			const { container } = render(<MarkdownBlock markdown={markdown} mentions />)

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
			const { container } = render(<MarkdownBlock markdown={markdown} mentions />)

			await screen.findByText(/Review/, { exact: false })

			const mentions = container.querySelectorAll("span.mention-context-highlight")
			expect(mentions.length).toBe(1)
			expect(mentions[0].textContent).toBe("@problems")
		})

		it("renders @terminal as a clickable mention span", async () => {
			const markdown = "See the output captured in @terminal."
			const { container } = render(<MarkdownBlock markdown={markdown} mentions />)

			await screen.findByText(/See/, { exact: false })

			const mentions = container.querySelectorAll("span.mention-context-highlight")
			expect(mentions.length).toBe(1)
			expect(mentions[0].textContent).toBe("@terminal")
		})

		it("renders multiple mentions in the same paragraph", async () => {
			const markdown = "Check @/src/file.ts and @problems, then review @terminal."
			const { container } = render(<MarkdownBlock markdown={markdown} mentions />)

			await screen.findByText(/Check/, { exact: false })

			const mentions = container.querySelectorAll("span.mention-context-highlight")
			expect(mentions.length).toBe(3)
			expect(mentions[0].textContent).toBe("@/src/file.ts")
			expect(mentions[1].textContent).toBe("@problems")
			expect(mentions[2].textContent).toBe("@terminal")
		})

		it("posts openMention message when a mention span is clicked", async () => {
			const markdown = "See @/src/components/chat/TaskHeader.tsx."
			const { container } = render(<MarkdownBlock markdown={markdown} mentions />)

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
			const { container } = render(<MarkdownBlock markdown={markdown} mentions />)

			await screen.findByText(/echo/, { exact: false })

			// Code is literal content: the mention must stay plain text, not become a
			// clickable span (which would also make the text vanish from CodeBlock).
			expect(container.querySelector("code")?.textContent).toBe("echo hello @problems\n")
			expect(container.querySelectorAll("span.mention-context-highlight").length).toBe(0)
		})

		it("keeps mention patterns literal inside inline code", async () => {
			const markdown = "Use `@problems` carefully."
			const { container } = render(<MarkdownBlock markdown={markdown} mentions />)

			await screen.findByText(/Use/, { exact: false })

			expect(container.querySelector("code")?.textContent).toBe("@problems")
			expect(container.querySelectorAll("span.mention-context-highlight").length).toBe(0)
		})

		it("keeps mention patterns literal inside link text even when enabled", async () => {
			// A mention inside <a> must not become a nested role=button span: that
			// is invalid interactive content (WHATWG) and would block the anchor's
			// own openFile handler via stopPropagation.
			const markdown = "see [open @/src/main.ts](/src/main.ts) please"
			const { container } = render(<MarkdownBlock markdown={markdown} mentions />)

			await screen.findByText(/please/, { exact: false })

			const anchor = container.querySelector("a")!
			expect(container.querySelectorAll("a span.mention-context-highlight").length).toBe(0)
			expect(anchor.textContent).toBe("open @/src/main.ts")

			// The anchor's own handler still fires (nothing swallows the click).
			fireEvent.click(anchor)
			expect(mockPostMessage).toHaveBeenCalledWith({ type: "openFile", text: "/src/main.ts" })
			expect(mockPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "openMention" }))
		})

		it("keeps reference link destinations inert and preserves the original href", async () => {
			// A reference definition's destination renders as the reference link's
			// href, so rewriting it to a mention placeholder would corrupt the href
			// (control characters instead of the original path) rather than produce
			// a mention span. The whole definition region must stay masked.
			const markdown = "[docs]: @/docs/readme.md\n\nSee [docs] and @problems."
			const { container } = render(<MarkdownBlock markdown={markdown} mentions />)

			await screen.findByText(/See/, { exact: false })

			// The reference link keeps its original href, untouched by mention
			// preprocessing, and the destination never becomes a mention span.
			const anchor = container.querySelector("a")!
			expect(anchor).toHaveAttribute("href", "@/docs/readme.md")
			expect(anchor.textContent).toBe("docs")
			expect(container.querySelectorAll("a span.mention-context-highlight").length).toBe(0)

			// Masking the definition must not affect a real mention in the body.
			const mentions = container.querySelectorAll("span.mention-context-highlight")
			expect(mentions.length).toBe(1)
			expect(mentions[0].textContent).toBe("@problems")

			// No placeholder control characters leak into the rendered output.
			expect(container.textContent).not.toContain("\u0001")
			expect(anchor.getAttribute("href")).not.toContain("\u0001")
		})

		it("keeps the shared regex boundary rules when a mention directly follows a link or inline code", async () => {
			// Matching must run on the raw string so the shared regex's start boundary
			// sees the real characters: with no whitespace after a closing `)` or a
			// backtick, `@problems` is not a mention (the collapsed <Mention>
			// component rejects it too). Replacing the literal regions with spaces
			// before matching would make them actionable.
			const markdown = "[file](/src/a.ts)@problems and `x`@problems"
			const { container } = render(<MarkdownBlock markdown={markdown} mentions />)

			// The anchor text is a stable, unique wait target.
			await screen.findByText("file")

			expect(container.querySelectorAll("span.mention-context-highlight").length).toBe(0)
			// The text still renders verbatim (link + plain text, no spans).
			expect(container.querySelector("p")?.textContent).toBe("file@problems and x@problems")
		})

		it("keeps a whitespace-separated mention after a link or inline code actionable", async () => {
			// The space is a legitimate boundary for the shared regex, so these
			// mentions stay clickable: the masked regions end before the spaces and
			// the match ranges do not intersect them.
			const markdown = "[file](/src/a.ts) @problems and `x` @problems"
			const { container } = render(<MarkdownBlock markdown={markdown} mentions />)

			// The anchor text is a stable, unique wait target.
			await screen.findByText("file")

			const mentions = container.querySelectorAll("span.mention-context-highlight")
			expect(mentions).toHaveLength(2)
			expect(mentions[0].textContent).toBe("@problems")
			expect(mentions[1].textContent).toBe("@problems")

			fireEvent.click(mentions[0])
			expect(mockPostMessage).toHaveBeenCalledWith({ type: "openMention", text: "problems" })
		})

		it("renders a standalone mention with no surrounding text", async () => {
			// A mention that both starts and ends the text node exercises the
			// no-leading-text and no-trailing-text branches of the splitter.
			const markdown = "@problems"
			const { container } = render(<MarkdownBlock markdown={markdown} mentions />)

			await screen.findByText("@problems")

			const mentions = container.querySelectorAll("span.mention-context-highlight")
			expect(mentions.length).toBe(1)
			expect(mentions[0].textContent).toBe("@problems")

			// No leading/trailing text: the paragraph is exactly the mention.
			expect(container.querySelector("p")?.textContent).toBe("@problems")
		})

		it("makes mentions keyboard operable (role=button, tabIndex, Enter/Space)", async () => {
			const markdown = "See @terminal."
			const { container } = render(<MarkdownBlock markdown={markdown} mentions />)

			await screen.findByText(/See/, { exact: false })

			const mention = container.querySelector("span.mention-context-highlight")!
			expect(mention.getAttribute("role")).toBe("button")
			expect(mention.getAttribute("tabindex")).toBe("0")

			// Enter/Space must both post and be default-prevented: dispatching a
			// cancelable event returns false once preventDefault has run, and Space's
			// default action would otherwise scroll the expanded task panel while a
			// mention has focus.
			expect(fireEvent.keyDown(mention, { key: "Enter" })).toBe(false)
			expect(mockPostMessage).toHaveBeenCalledWith({ type: "openMention", text: "terminal" })

			mockPostMessage.mockClear()
			expect(fireEvent.keyDown(mention, { key: " " })).toBe(false)
			expect(mockPostMessage).toHaveBeenCalledWith({ type: "openMention", text: "terminal" })

			mockPostMessage.mockClear()
			// An unrelated key neither posts nor prevents the default action.
			expect(fireEvent.keyDown(mention, { key: "a" })).toBe(true)
			expect(mockPostMessage).not.toHaveBeenCalled()
		})

		it("preserves regular text around mentions", async () => {
			const markdown = "Before @problems middle after"
			const { container } = render(<MarkdownBlock markdown={markdown} mentions />)

			await screen.findByText(/Before/, { exact: false })

			const paragraph = container.querySelector("p")
			expect(paragraph?.textContent).toBe("Before @problems middle after")

			// The mention span should only contain the mention itself.
			const mentions = container.querySelectorAll("span.mention-context-highlight")
			expect(mentions.length).toBe(1)
			expect(mentions[0].textContent).toBe("@problems")
		})

		it("matches the full mention path when it contains markdown-active characters", async () => {
			// remark tokenizes `@/src/__init__.py` as `@/src/` + <strong>init</strong> + `.py`,
			// so matching on tokenized text nodes would truncate the mention to `@/src/` and
			// post the wrong path. Mention matching must run on the raw string instead.
			const markdown = "Run the tests for @/src/__init__.py now."
			const { container } = render(<MarkdownBlock markdown={markdown} mentions />)

			await screen.findByText(/Run the tests/, { exact: false })

			const mentions = container.querySelectorAll("span.mention-context-highlight")
			expect(mentions.length).toBe(1)
			expect(mentions[0].textContent).toBe("@/src/__init__.py")

			// No stray <strong> for the `__init__` part: the whole path is one mention.
			expect(container.querySelector("p")?.querySelector("strong")).toBeNull()

			// Clicking must post the FULL path, not the truncated `@/src/` prefix.
			fireEvent.click(mentions[0])
			expect(mockPostMessage).toHaveBeenCalledWith({ type: "openMention", text: "/src/__init__.py" })
		})

		it("matches mentions containing asterisks on the raw string", async () => {
			// `*files*` would tokenize as emphasis, splitting the path across text nodes.
			const markdown = "Check @/src/*files* before shipping."
			const { container } = render(<MarkdownBlock markdown={markdown} mentions />)

			await screen.findByText(/Check/, { exact: false })

			const mentions = container.querySelectorAll("span.mention-context-highlight")
			expect(mentions.length).toBe(1)
			expect(mentions[0].textContent).toBe("@/src/*files*")

			fireEvent.click(mentions[0])
			expect(mockPostMessage).toHaveBeenCalledWith({ type: "openMention", text: "/src/*files*" })
		})

		it("resolves mentions and line breaks together in the same prompt", async () => {
			// The raw-string mention preprocessing and remark-breaks both rewrite the
			// paragraph; they must compose: the mention stays a single span and the
			// soft break between the lines renders as one <br>.
			const markdown = "Check @/src/file.ts\nthen review @problems"
			const { container } = render(<MarkdownBlock markdown={markdown} mentions breaks />)

			await screen.findByText(/then review/, { exact: false })

			const mentions = container.querySelectorAll("span.mention-context-highlight")
			expect(mentions).toHaveLength(2)
			expect(mentions[0].textContent).toBe("@/src/file.ts")
			expect(mentions[1].textContent).toBe("@problems")

			const paragraph = container.querySelector("p")
			expect(paragraph?.querySelectorAll("br")).toHaveLength(1)
			expect(paragraph?.textContent).toBe("Check @/src/file.tsthen review @problems")
		})

		it("keeps placeholder-free output when the prompt contains no mentions", async () => {
			// Preprocessing must not leak placeholder control characters into rendered
			// text when the (raw) text happens to contain mention-like patterns that do
			// not match (e.g. @ not preceded by whitespace).
			const markdown = "Failed@localhost/status code 404."
			const { container } = render(<MarkdownBlock markdown={markdown} mentions />)

			await screen.findByText(/Failed/, { exact: false })

			expect(container.querySelectorAll("span.mention-context-highlight").length).toBe(0)
			expect(container.querySelector("p")?.textContent).toBe("Failed@localhost/status code 404.")
		})
	})

	describe("line breaks (breaks prop)", () => {
		it("renders a soft line break as <br> when breaks is set", async () => {
			const markdown = "line one\nline two"
			const { container } = render(<MarkdownBlock markdown={markdown} breaks />)

			await screen.findByText(/line one/)

			const paragraph = container.querySelector("p")
			expect(paragraph).not.toBeNull()
			// remark-breaks turns the single newline into a real <br> so the line
			// break is structural instead of relying on CSS white-space.
			expect(paragraph?.querySelector("br")).not.toBeNull()
			expect(paragraph?.textContent).toBe("line oneline two")
		})

		it("keeps soft line breaks as text by default", async () => {
			const markdown = "line one\nline two"
			const { container } = render(<MarkdownBlock markdown={markdown} />)

			// The text matcher must be inexact: by default the newline stays inside
			// the single text node, so "line one" is not a standalone node.
			await screen.findByText(/line one/, { exact: false })

			const paragraph = container.querySelector("p")
			expect(paragraph?.querySelector("br")).toBeNull()
			expect(paragraph?.textContent).toBe("line one\nline two")
		})

		it("keeps blank lines as paragraph breaks when breaks is set", async () => {
			const markdown = "first paragraph\n\nsecond paragraph"
			const { container } = render(<MarkdownBlock markdown={markdown} breaks />)

			await screen.findByText("first paragraph")

			// Two separate paragraphs (the blank line is a hard break, not a soft one).
			expect(container.querySelectorAll("p")).toHaveLength(2)
			expect(container.querySelector("p")?.querySelector("br")).toBeNull()
		})
	})
})
