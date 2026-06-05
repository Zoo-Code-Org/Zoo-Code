import React, { memo, useMemo } from "react"
import ReactMarkdown from "react-markdown"
import styled from "styled-components"
import { visit } from "unist-util-visit"
import rehypeKatex from "rehype-katex"
import remarkMath from "remark-math"
import remarkGfm from "remark-gfm"

import { vscode } from "@src/utils/vscode"
import { type AlertType, remarkGithubAlerts } from "@src/utils/markdown"

import CodeBlock from "./CodeBlock"
import MermaidBlock from "./MermaidBlock"

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

const MarkdownBlock = memo(({ markdown }: MarkdownBlockProps) => {
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

	return (
		<StyledMarkdown>
			<ReactMarkdown
				remarkPlugins={[
					// singleTilde: false so a single "~" around text (e.g. "1~3", "~10") is not
					// rendered as strikethrough; only "~~text~~" is. Matches VS Code's markdown. (#154)
					[remarkGfm, { singleTilde: false }],
					remarkMath,
					remarkGithubAlerts,
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
				rehypePlugins={[rehypeKatex as any]}
				components={components}>
				{markdown || ""}
			</ReactMarkdown>
		</StyledMarkdown>
	)
})

export default MarkdownBlock
