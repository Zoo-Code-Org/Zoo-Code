import { describe, expect, it } from "vitest"

import { ALERT_TYPES, countMarkdownHeadings, hasComplexMarkdown, remarkGithubAlerts } from "../markdown"

// Minimal mdast builders so we can exercise the plugin without a full parser.
const text = (value: string) => ({ type: "text", value })
const paragraph = (...children: any[]) => ({ type: "paragraph", children })
const blockquote = (...children: any[]) => ({ type: "blockquote", children })
const root = (...children: any[]) => ({ type: "root", children })

const transform = (tree: any) => {
	remarkGithubAlerts()(tree)
	return tree
}

describe("markdown heading helpers", () => {
	it("returns 0 for empty or undefined", () => {
		expect(countMarkdownHeadings(undefined)).toBe(0)
		expect(countMarkdownHeadings("")).toBe(0)
	})

	it("counts single and multiple headings", () => {
		expect(countMarkdownHeadings("# One")).toBe(1)
		expect(countMarkdownHeadings("# One\nContent")).toBe(1)
		expect(countMarkdownHeadings("# One\n## Two")).toBe(2)
		expect(countMarkdownHeadings("# One\n## Two\n### Three")).toBe(3)
	})

	it("handles all heading levels", () => {
		const md = `# h1\n## h2\n### h3\n#### h4\n##### h5\n###### h6`
		expect(countMarkdownHeadings(md)).toBe(6)
	})

	it("ignores headings inside code fences", () => {
		const md = "# real\n```\n# not a heading\n```\n## real"
		expect(countMarkdownHeadings(md)).toBe(2)
	})

	it("hasComplexMarkdown requires at least two headings", () => {
		expect(hasComplexMarkdown("# One")).toBe(false)
		expect(hasComplexMarkdown("# One\n## Two")).toBe(true)
	})
})

describe("remarkGithubAlerts", () => {
	it.each(ALERT_TYPES)("annotates a [!%s] alert blockquote", (type) => {
		const upper = type.toUpperCase()
		const tree = root(blockquote(paragraph(text(`[!${upper}]\nBody text`))))

		transform(tree)

		const bq = tree.children[0]
		expect(bq.data.hProperties["data-alert-type"]).toBe(type)
		expect(bq.data.hProperties.className).toBe(`markdown-alert markdown-alert-${type}`)

		// Marker is stripped from the rendered content.
		expect(bq.children[0].children[0].value).toBe("Body text")
	})

	it("recognizes markers case-insensitively", () => {
		const tree = root(blockquote(paragraph(text("[!Note]\nhi"))))

		transform(tree)

		expect(tree.children[0].data.hProperties["data-alert-type"]).toBe("note")
		expect(tree.children[0].children[0].children[0].value).toBe("hi")
	})

	it("removes the marker paragraph when it has no following inline content", () => {
		// `> [!NOTE]` on its own line followed by a separate paragraph.
		const tree = root(blockquote(paragraph(text("[!NOTE]\n")), paragraph(text("Body on next line"))))

		transform(tree)

		const bq = tree.children[0]
		expect(bq.data.hProperties["data-alert-type"]).toBe("note")
		// The emptied marker paragraph is dropped; body paragraph remains.
		expect(bq.children).toHaveLength(1)
		expect(bq.children[0].children[0].value).toBe("Body on next line")
	})

	it("leaves a normal blockquote untouched", () => {
		const tree = root(blockquote(paragraph(text("Just a quote, not an alert."))))

		transform(tree)

		const bq = tree.children[0]
		expect(bq.data).toBeUndefined()
		expect(bq.children[0].children[0].value).toBe("Just a quote, not an alert.")
	})

	it("ignores unsupported markers and renders them as normal blockquotes", () => {
		const tree = root(blockquote(paragraph(text("[!INFO]\nNot a real alert type"))))

		transform(tree)

		const bq = tree.children[0]
		expect(bq.data).toBeUndefined()
		expect(bq.children[0].children[0].value).toBe("[!INFO]\nNot a real alert type")
	})

	it("does not treat a marker in the middle of text as an alert", () => {
		const tree = root(blockquote(paragraph(text("Some text [!NOTE] still a quote"))))

		transform(tree)

		expect(tree.children[0].data).toBeUndefined()
	})

	it("annotates nested alert blockquotes", () => {
		const tree = root(blockquote(blockquote(paragraph(text("[!TIP]\nnested")))))

		transform(tree)

		const inner = tree.children[0].children[0]
		expect(inner.data.hProperties["data-alert-type"]).toBe("tip")
	})
})
