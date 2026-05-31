import { visit } from "unist-util-visit"

/**
 * Counts the number of markdown headings in the given text.
 * Matches headings from level 1 to 6 (e.g. #, ##, ###, etc.).
 * Code fences are stripped before matching to avoid false positives.
 */
export function countMarkdownHeadings(text: string | undefined): number {
	if (!text) return 0

	// Remove fenced code blocks to avoid counting headings inside code
	const withoutCodeBlocks = text.replace(/```[\s\S]*?```/g, "")

	// Up to 3 leading spaces are allowed before the hashes per the markdown spec
	const headingRegex = /^\s{0,3}#{1,6}\s+.+$/gm
	const matches = withoutCodeBlocks.match(headingRegex)
	return matches ? matches.length : 0
}

/**
 * Returns true if the markdown contains at least two headings.
 */
export function hasComplexMarkdown(text: string | undefined): boolean {
	return countMarkdownHeadings(text) >= 2
}

/**
 * GitHub-style Markdown alert types, mapped to their lower-cased identifiers.
 * @see https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#alerts
 */
export const ALERT_TYPES = ["note", "tip", "important", "warning", "caution"] as const

export type AlertType = (typeof ALERT_TYPES)[number]

// Matches a leading alert marker like "[!NOTE]" (case-insensitive) optionally
// followed by trailing whitespace/newline on the first line of a blockquote.
const ALERT_MARKER_REGEX = new RegExp(`^\\[!(${ALERT_TYPES.join("|")})\\][^\\S\\r\\n]*\\r?\\n?`, "i")

/**
 * remark plugin that detects GitHub-style alerts inside blockquotes
 * (e.g. `> [!NOTE]`) and annotates the blockquote node so it can be rendered
 * as a distinct alert block.
 *
 * The marker text is stripped from the rendered content and the recognized
 * alert type is exposed via the `data-alert-type` attribute plus matching
 * `markdown-alert*` class names on the emitted `<blockquote>` element.
 *
 * Blockquotes that do not begin with a supported marker are left untouched, so
 * normal blockquotes continue to render exactly as before.
 */
export function remarkGithubAlerts() {
	return (tree: Parameters<typeof visit>[0]) => {
		visit(tree, "blockquote", annotateAlertBlockquote)
	}
}

function annotateAlertBlockquote(node: any): void {
	const firstChild = node.children?.[0]

	// The marker must live in the first paragraph's first text node.
	if (!firstChild || firstChild.type !== "paragraph") {
		return
	}

	const firstText = firstChild.children?.[0]

	if (!firstText || firstText.type !== "text" || typeof firstText.value !== "string") {
		return
	}

	const match = firstText.value.match(ALERT_MARKER_REGEX)

	if (!match) {
		return
	}

	const alertType = match[1].toLowerCase() as AlertType

	// Strip the marker (and the following newline) from the rendered content.
	firstText.value = firstText.value.slice(match[0].length)

	// Drop the now-empty leading text node so the alert body starts cleanly.
	if (firstText.value === "") {
		firstChild.children.shift()
	}

	// If the paragraph became empty (marker was on its own line with no inline
	// content following it), remove it entirely.
	if (firstChild.children.length === 0) {
		node.children.shift()
	}

	node.data = node.data || {}
	const hProperties = (node.data.hProperties = node.data.hProperties || {})
	hProperties.className = `markdown-alert markdown-alert-${alertType}`
	hProperties["data-alert-type"] = alertType
}
