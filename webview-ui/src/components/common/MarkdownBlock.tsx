import React, { memo, useMemo } from "react"
import ReactMarkdown from "react-markdown"
import styled from "styled-components"
import { visit } from "unist-util-visit"
import rehypeKatex from "rehype-katex"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import remarkParse from "remark-parse"
import { unified } from "unified"

import { mentionRegexGlobal } from "@roo/context-mentions"

import { vscode } from "@src/utils/vscode"
import { type AlertType, remarkGithubAlerts } from "@src/utils/markdown"

import CodeBlock from "./CodeBlock"
import MermaidBlock from "./MermaidBlock"

// Control character that wraps a mention index in the preprocessed markdown.
// It cannot be typed into a prompt and carries no markdown meaning, so remark
// always keeps a whole placeholder inside a single text node. Built via
// `new RegExp` from a string constant (a template literal) so the control
// character does not appear in a regex literal (no-control-regex).
const MENTION_PLACEHOLDER_CHAR = "\u0001"
const MENTION_PLACEHOLDER_REGEX = new RegExp(`${MENTION_PLACEHOLDER_CHAR}(\\d+)${MENTION_PLACEHOLDER_CHAR}`, "g")

// mdast node types whose raw source regions must never be mention-rewritten:
// code blocks (fenced or indented), inline code, links, images, raw HTML, math,
// reference link definitions, and reference links/images all render as literal
// or non-text content. Rewriting a definition's destination would corrupt the
// reference link's href; rewriting a reference label or alt would leak the raw
// placeholder into the anchor text or img alt (rehypeMentions skips anchors),
// instead of producing a mention span.
const MENTION_MASK_NODE_TYPES = new Set([
	"code",
	"inlineCode",
	"link",
	"image",
	"html",
	"inlineMath",
	"math",
	"definition",
	"linkReference",
	"imageReference",
])

/**
 * Rewrite mention patterns in the RAW markdown string before remark tokenizes
 * it, replacing each match with an indexed placeholder.
 *
 * Matching on remark's tokenized text nodes truncates paths that contain
 * markdown-active characters: `@/src/__init__.py` is parsed as
 * `@/src/` + <strong>init</strong> + `.py`, so per-node matching would only
 * see `@/src/` and post the wrong path to `openMention`. Raw-string matching
 * is also the behavior of the collapsed <Mention> component, so this restores
 * it for the expanded view.
 *
 * Matching runs on the raw string so the shared regex's boundary rules apply
 * unchanged (replacing literal regions with spaces would turn a preceding `)`
 * or backtick into whitespace and make non-mentions actionable). Literal / non-
 * text regions (code, links, images, HTML, math, reference link definitions,
 * and reference links/images) are marked via a throwaway mdast parse with the
 * exact positions remark sees, and a match whose range intersects one of them
 * is discarded so mentions inside such regions stay inert.
 */
function prepareMentions(markdown: string): { preparedMarkdown: string; mentions: string[] } {
	if (!markdown) {
		return { preparedMarkdown: markdown, mentions: [] }
	}

	// A throwaway parse with the same extensions as the render pipeline, so the
	// reported positions match what remark will tokenize. Mark literal and
	// non-text regions (mdast positions carry absolute source offsets): a
	// mention inside any of them must stay inert, because code and links render
	// as literal/interactive content, images, raw HTML, and math keep their
	// source text unchanged, a reference link definition's destination becomes
	// the link's href, and a reference link/image label or alt renders as the
	// anchor text or img alt (rewriting any of them would corrupt the href/alt
	// or leak the raw placeholder into the rendered output).
	const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(markdown)

	const isMasked = new Array<boolean>(markdown.length).fill(false)
	visit(tree, (node: any) => {
		if (!MENTION_MASK_NODE_TYPES.has(node.type)) {
			return
		}
		const start = node.position?.start?.offset
		const end = node.position?.end?.offset
		if (typeof start !== "number" || typeof end !== "number") {
			return
		}
		for (let i = start; i < end && i < isMasked.length; i++) {
			isMasked[i] = true
		}
	})

	const mentions: string[] = []
	let preparedMarkdown = ""
	let lastIndex = 0
	for (const match of markdown.matchAll(mentionRegexGlobal)) {
		const start = match.index!
		const end = start + match[0].length
		// The raw string (not a masked copy) is what the shared regex's boundary
		// rules must see: masking would turn a preceding `)` or backtick into a
		// space and make a non-mention actionable (e.g. `[file](/src/a.ts)`@problems``).
		// Discard a match only when its range lands inside a masked literal region.
		if (isMasked.slice(start, end).some(Boolean)) {
			continue
		}
		preparedMarkdown += markdown.slice(lastIndex, start)
		mentions.push(markdown.slice(start, end))
		preparedMarkdown += `${MENTION_PLACEHOLDER_CHAR}${mentions.length - 1}${MENTION_PLACEHOLDER_CHAR}`
		lastIndex = end
	}
	preparedMarkdown += markdown.slice(lastIndex)

	return { preparedMarkdown, mentions }
}

/**
 * Rehype plugin that replaces the mention placeholders produced by
 * prepareMentions with clickable spans matching the styling used by the
 * collapsed Mention component.
 */
function rehypeMentions(mentions: string[]) {
	return (tree: any) => {
		visit(tree, "text", (node: any, index: number | undefined, parent: any) => {
			if (index === undefined || !parent) {
				return
			}

			// Skip text inside spans we already created (the visitor may revisit
			// children inserted during the same pass).
			if (parent?.tagName === "span" && parent.properties?.className?.includes("mention-context-highlight")) {
				return
			}

			// prepareMentions already masks code and link regions, but keep these
			// guards so the plugin stays safe on any tree: inside <a> a role=button
			// span would be invalid nested interactive content (WHATWG) and its
			// stopPropagation would block the anchor's own openFile handler; inside
			// code it would corrupt the CodeBlock text extraction, which only keeps
			// string children (the mention text would silently disappear).
			if (parent?.tagName === "code" || parent?.tagName === "pre" || parent?.tagName === "a") {
				return
			}

			const originalValue = String(node.value)
			const matches = Array.from(originalValue.matchAll(MENTION_PLACEHOLDER_REGEX))

			if (matches.length === 0) {
				return
			}

			// If any placeholder fails to resolve (should not happen), leave the
			// text untouched instead of rendering the control characters verbatim.
			if (matches.some((match) => mentions[Number(match[1])] === undefined)) {
				return
			}

			const children: any[] = []
			let lastIndex = 0

			for (const match of matches) {
				const mentionText = mentions[Number(match[1])]
				// The raw mention includes the leading "@"; the posted value is the
				// full path/word after it, matching the collapsed Mention component.
				const mentionValue = mentionText.slice(1)
				const mentionStart = match.index!

				if (mentionStart > lastIndex) {
					children.push({ type: "text", value: originalValue.slice(lastIndex, mentionStart) })
				}

				children.push({
					type: "element",
					tagName: "span",
					properties: {
						className: ["mention-context-highlight", "text-[0.9em]", "cursor-pointer"],
						role: "button",
						tabIndex: 0,
						onClick: (event: React.MouseEvent<HTMLSpanElement>) => {
							// Keep mention clicks from bubbling to the TaskHeader toggle, which
							// would collapse the expanded panel right after opening the mention.
							event.stopPropagation()
							vscode.postMessage({ type: "openMention", text: mentionValue })
						},
						// Keyboard parity with the click handler (a role=button span is not a
						// native button, so Enter/Space must be handled explicitly).
						// preventDefault keeps Space from also scrolling the expanded task panel,
						// which otherwise receives the key's default action when a mention has
						// focus.
						onKeyDown: (event: React.KeyboardEvent<HTMLSpanElement>) => {
							if (event.key !== "Enter" && event.key !== " ") {
								return
							}
							event.preventDefault()
							event.stopPropagation()
							vscode.postMessage({ type: "openMention", text: mentionValue })
						},
					},
					children: [{ type: "text", value: mentionText }],
				})

				lastIndex = mentionStart + match[0].length
			}

			if (lastIndex < originalValue.length) {
				children.push({ type: "text", value: originalValue.slice(lastIndex) })
			}

			parent.children.splice(index, 1, ...children)
		})
	}
}

/**
 * Rehype plugin that drops the lone "\n" text node mdast-util-to-hast emits
 * right after every <br> (its hardBreak handler returns [<br>, "\n"]).
 *
 * The paragraph styling in this webview uses `white-space: pre-wrap`, where a
 * literal newline is significant. Without this, every remark-breaks <br> would
 * be followed by an extra pre-wrap line break, inserting a blank line between
 * each soft-broken line. Removing the node leaves exactly one line break per
 * soft break, independent of CSS white-space handling.
 */
function rehypeStripBreakNewlines() {
	return (tree: any) => {
		visit(tree, "element", (node: any, index: number | undefined, parent: any) => {
			if (node.tagName !== "br" || index === undefined || !parent) {
				return
			}
			const next = parent.children[index + 1]
			if (next?.type === "text" && next.value === "\n") {
				parent.children.splice(index + 1, 1)
			}
		})
	}
}

// Codicon glyphs used as the leading icon for each GitHub-style alert type.
const ALERT_ICONS: Record<AlertType, string> = {
	note: "codicon-info",
	tip: "codicon-lightbulb",
	important: "codicon-report",
	warning: "codicon-warning",
	caution: "codicon-flame",
}

// Human-readable label shown in the alert header.
const ALERT_LABELS: Record<AlertType, string> = {
	note: "Note",
	tip: "Tip",
	important: "Important",
	warning: "Warning",
	caution: "Caution",
}

interface MarkdownBlockProps {
	markdown?: string
	/**
	 * Render context mentions (@/path, @problems, @terminal, ...) as clickable
	 * spans that post `openMention`. Off by default: mentions are only
	 * actionable where the text is user-authored (the expanded task prompt).
	 * Assistant-generated content (messages, reasoning, tool output, todos)
	 * keeps mention patterns as inert text.
	 */
	mentions?: boolean
	/**
	 * Render single newlines as <br> (remark-breaks) instead of collapsing them
	 * to spaces per CommonMark. Off by default so the shared pipeline keeps its
	 * CommonMark soft-break behavior for assistant-generated content. The
	 * expanded task prompt (user-authored text) enables it so plain multi-line
	 * prompts keep their line breaks while markdown still parses.
	 */
	breaks?: boolean
}

const StyledMarkdown = styled.div`
	* {
		font-weight: 400;
	}

	strong {
		font-weight: 600;
	}

	code:not(pre > code) {
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: 0.85em;
		filter: saturation(110%) brightness(95%);
		color: var(--vscode-textPreformat-foreground) !important;
		background-color: var(--vscode-textPreformat-background) !important;
		padding: 1px 2px;
		white-space: pre-line;
		word-break: break-word;
		overflow-wrap: anywhere;
	}

	/* Target only Dark High Contrast theme using the data attribute VS Code adds to the body */
	body[data-vscode-theme-kind="vscode-high-contrast"] & code:not(pre > code) {
		color: var(
			--vscode-editorInlayHint-foreground,
			var(--vscode-symbolIcon-stringForeground, var(--vscode-charts-orange, #e9a700))
		);
	}

	/* KaTeX styling */
	.katex {
		font-size: 1.1em;
		color: var(--vscode-editor-foreground);
		font-family: KaTeX_Main, "Times New Roman", serif;
		line-height: 1.2;
		white-space: normal;
		text-indent: 0;
	}

	.katex-display {
		display: block;
		margin: 1em 0;
		text-align: center;
		padding: 0.5em;
		overflow-x: auto;
		overflow-y: hidden;
		background-color: var(--vscode-textCodeBlock-background);
		border-radius: 3px;
	}

	.katex-error {
		color: var(--vscode-errorForeground);
	}

	font-family:
		var(--vscode-font-family),
		system-ui,
		-apple-system,
		BlinkMacSystemFont,
		"Segoe UI",
		Roboto,
		Oxygen,
		Ubuntu,
		Cantarell,
		"Open Sans",
		"Helvetica Neue",
		sans-serif;

	font-size: var(--zoo-chat-font-size, var(--vscode-font-size, 13px));

	p,
	li,
	ol,
	ul {
		line-height: 1.35em;
	}

	li {
		margin: 0.5em 0;
	}

	ol,
	ul {
		padding-left: 2em;
		margin-left: 0;
	}

	ol {
		list-style-type: decimal;
	}

	ul {
		list-style-type: disc;
	}

	ol ol {
		list-style-type: lower-alpha;
	}

	ol ol ol {
		list-style-type: lower-roman;
	}

	p {
		white-space: pre-wrap;
		margin: 1em 0 0.25em;
	}

	/* Prevent layout shifts during streaming */
	pre {
		min-height: 3em;
		transition: height 0.2s ease-out;
	}

	/* Code block container styling */
	div:has(> pre) {
		position: relative;
		contain: layout style;
		padding: 0.5em 1em;
	}

	a {
		color: var(--vscode-textLink-foreground);
		text-decoration: none;
		text-decoration-color: var(--vscode-textLink-foreground);
		&:hover {
			color: var(--vscode-textLink-activeForeground);
			text-decoration: underline;
		}
	}

	h1 {
		font-size: 1.65em;
		font-weight: 700;
		margin: 1.35em 0 0.5em;
	}

	h2 {
		font-size: 1.35em;
		font-weight: 500;
		margin: 1.35em 0 0.5em;
	}

	h3 {
		font-size: 1.2em;
		font-weight: 500;
	}

	/* Table styles for remark-gfm */
	table {
		border-collapse: collapse;
		margin: 1em 0;
		width: auto;
		min-width: 50%;
		max-width: 100%;
		table-layout: fixed;
	}

	/* Table wrapper for horizontal scrolling */
	.table-wrapper {
		overflow-x: auto;
		margin: 1em 0;
	}

	th,
	td {
		border: 1px solid var(--vscode-panel-border);
		padding: 8px 12px;
		text-align: left;
		word-wrap: break-word;
		overflow-wrap: break-word;
	}

	th {
		background-color: var(--vscode-editor-background);
		font-weight: 600;
		color: var(--vscode-foreground);
	}

	tr:nth-child(even) {
		background-color: var(--vscode-editor-inactiveSelectionBackground);
	}

	tr:hover {
		background-color: var(--vscode-list-hoverBackground);
	}

	/* GitHub-style Markdown alerts (#258). The accent color per type is set via
	   the --alert-accent custom property on the element itself. */
	.markdown-alert {
		margin: 1em 0;
		padding: 0.5em 1em;
		border-left: 0.25em solid var(--alert-accent, var(--vscode-textBlockQuote-border));
		border-radius: 3px;
		background-color: var(--vscode-textBlockQuote-background);
	}

	.markdown-alert > :first-child {
		margin-top: 0;
	}

	.markdown-alert > :last-child {
		margin-bottom: 0;
	}

	.markdown-alert-title {
		display: flex;
		align-items: center;
		gap: 0.5em;
		font-weight: 600;
		color: var(--alert-accent, var(--vscode-foreground));
		margin-bottom: 0.25em;
	}

	.markdown-alert-title .codicon {
		font-size: 1em;
	}

	.markdown-alert-note {
		--alert-accent: var(--vscode-charts-blue, var(--vscode-textLink-foreground));
	}

	.markdown-alert-tip {
		--alert-accent: var(--vscode-charts-green, var(--vscode-terminal-ansiGreen));
	}

	.markdown-alert-important {
		--alert-accent: var(--vscode-charts-purple, var(--vscode-textLink-foreground));
	}

	.markdown-alert-warning {
		--alert-accent: var(--vscode-charts-yellow, var(--vscode-editorWarning-foreground));
	}

	.markdown-alert-caution {
		--alert-accent: var(--vscode-charts-red, var(--vscode-editorError-foreground));
	}
`

const MarkdownBlock = memo(({ markdown, mentions = false, breaks = false }: MarkdownBlockProps) => {
	const components = useMemo(
		() => ({
			table: ({ children, ...props }: any) => {
				return (
					<div className="table-wrapper">
						<table {...props}>{children}</table>
					</div>
				)
			},
			a: ({ href, children, ...props }: any) => {
				const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
					// Only process file:// protocol or local file paths
					const isLocalPath = href?.startsWith("file://") || href?.startsWith("/") || !href?.includes("://")

					if (!isLocalPath) {
						return
					}

					e.preventDefault()

					// Handle absolute vs project-relative paths
					let filePath = href.replace("file://", "")

					// Extract line number if present
					const match = filePath.match(/(.*):(\d+)(-\d+)?$/)
					let values = undefined
					if (match) {
						filePath = match[1]
						values = { line: parseInt(match[2]) }
					}

					// Add ./ prefix if needed
					if (!filePath.startsWith("/") && !filePath.startsWith("./")) {
						filePath = "./" + filePath
					}

					vscode.postMessage({
						type: "openFile",
						text: filePath,
						values,
					})
				}

				return (
					<a {...props} href={href} onClick={handleClick}>
						{children}
					</a>
				)
			},
			pre: ({ children, ..._props }: any) => {
				// The structure from react-markdown v9 is: pre > code > text
				const codeEl = children as React.ReactElement

				if (!codeEl || !codeEl.props) {
					return <pre>{children}</pre>
				}

				const { className = "", children: codeChildren } = codeEl.props

				// Get the actual code text
				let codeString = ""
				if (typeof codeChildren === "string") {
					codeString = codeChildren
				} else if (Array.isArray(codeChildren)) {
					codeString = codeChildren.filter((child) => typeof child === "string").join("")
				}

				// Handle mermaid diagrams
				if (className.includes("language-mermaid")) {
					return (
						<div style={{ margin: "1em 0" }}>
							<MermaidBlock code={codeString} />
						</div>
					)
				}

				// Extract language from className
				const match = /language-(\w+)/.exec(className)
				const language = match ? match[1] : "text"

				// Wrap CodeBlock in a div to ensure proper separation
				return (
					<div style={{ margin: "1em 0" }}>
						<CodeBlock source={codeString} language={language} />
					</div>
				)
			},
			code: ({ children, className, ...props }: any) => {
				// This handles inline code
				return (
					<code className={className} {...props}>
						{children}
					</code>
				)
			},
			blockquote: ({ children, className, "data-alert-type": alertType, ..._rest }: any) => {
				// The remarkGithubAlerts plugin tags alert blockquotes with a
				// `data-alert-type` attribute and `markdown-alert*` classes.
				// Anything without that attribute is a normal blockquote and
				// must render unchanged.
				const typedAlertType = alertType as AlertType | undefined

				if (!typedAlertType || !(typedAlertType in ALERT_ICONS)) {
					return <blockquote className={className}>{children}</blockquote>
				}

				return (
					<blockquote className={className} data-alert-type={typedAlertType}>
						<div className="markdown-alert-title">
							<span className={`codicon ${ALERT_ICONS[typedAlertType]}`} aria-hidden="true" />
							<span>{ALERT_LABELS[typedAlertType]}</span>
						</div>
						{children}
					</blockquote>
				)
			},
		}),
		[],
	)

	// When mentions are actionable, rewrite the raw markdown before parsing so
	// mention matching runs on the untokenized string (see prepareMentions).
	const { preparedMarkdown, mentions: mentionList } = useMemo(
		() => (mentions ? prepareMentions(markdown || "") : { preparedMarkdown: markdown || "", mentions: [] }),
		[markdown, mentions],
	)

	return (
		<StyledMarkdown>
			<ReactMarkdown
				remarkPlugins={[
					// singleTilde: false so a single "~" around text (e.g. "1~3", "~10") is not
					// rendered as strikethrough; only "~~text~~" is. Matches VS Code's markdown. (#154)
					[remarkGfm, { singleTilde: false }],
					remarkMath,
					remarkGithubAlerts,
					...(breaks ? [remarkBreaks] : []),
					() => {
						return (tree: any) => {
							visit(tree, "code", (node: any) => {
								if (!node.lang) {
									node.lang = "text"
								} else if (node.lang.includes(".")) {
									node.lang = node.lang.split(".").slice(-1)[0]
								}
							})
						}
					},
				]}
				rehypePlugins={[
					...(mentions ? [[rehypeMentions, mentionList] as const] : []),
					...(breaks ? [rehypeStripBreakNewlines] : []),
					rehypeKatex as any,
				]}
				components={components}>
				{preparedMarkdown}
			</ReactMarkdown>
		</StyledMarkdown>
	)
})

export default MarkdownBlock
