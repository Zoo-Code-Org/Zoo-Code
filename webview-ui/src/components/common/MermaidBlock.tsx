import { useEffect, useRef, useState } from "react"
import mermaid from "mermaid"
import styled from "styled-components"
import { useDebounceEffect } from "@src/utils/useDebounceEffect"
import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useCopyToClipboard } from "@src/utils/clipboard"
import CodeBlock from "./CodeBlock"
import { MermaidButton } from "@/components/common/MermaidButton"
import { getMermaidBackgroundColor, getMermaidConfig, useMermaidTheme } from "./mermaidTheme"

interface MermaidBlockProps {
	code: string
}

export default function MermaidBlock({ code }: MermaidBlockProps) {
	const containerRef = useRef<HTMLDivElement>(null)
	const [isLoading, setIsLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [isErrorExpanded, setIsErrorExpanded] = useState(false)
	const renderVersionRef = useRef(0)
	const theme = useMermaidTheme()
	const { showCopyFeedback, copyWithFeedback } = useCopyToClipboard()
	const { t } = useAppTranslation()

	// Whenever the source or host theme changes, invalidate in-flight rendering.
	useEffect(() => {
		renderVersionRef.current += 1
		setIsLoading(true)
		setError(null)
	}, [code, theme.signature])

	useDebounceEffect(
		() => {
			const renderVersion = renderVersionRef.current
			if (containerRef.current) {
				containerRef.current.innerHTML = ""
			}

			mermaid.initialize(getMermaidConfig(theme.kind))
			mermaid
				.parse(code)
				.then(() => {
					const id = `mermaid-${Math.random().toString(36).substring(2)}`
					return mermaid.render(id, code)
				})
				.then(({ svg }) => {
					if (containerRef.current && renderVersion === renderVersionRef.current) {
						containerRef.current.innerHTML = svg
					}
				})
				.catch((err) => {
					if (renderVersion === renderVersionRef.current) {
						console.warn("Mermaid parse/render failed:", err)
						setError(err.message || "Failed to render Mermaid diagram")
					}
				})
				.finally(() => {
					if (renderVersion === renderVersionRef.current) {
						setIsLoading(false)
					}
				})
		},
		500,
		[code, theme.signature],
	)

	/**
	 * Called when user clicks the rendered diagram.
	 * Converts the <svg> to a PNG and sends it to the extension.
	 */
	const handleClick = async () => {
		if (!containerRef.current) return
		const svgEl = containerRef.current.querySelector("svg")
		if (!svgEl) return

		try {
			const pngDataUrl = await svgToPng(svgEl)
			vscode.postMessage({
				type: "openImage",
				text: pngDataUrl,
			})
		} catch (err) {
			console.error("Error converting SVG to PNG:", err)
		}
	}

	// Copy functionality handled directly through the copyWithFeedback utility

	return (
		<MermaidBlockContainer>
			{isLoading && <LoadingMessage>{t("common:mermaid.loading")}</LoadingMessage>}

			{error ? (
				<div style={{ marginTop: "0px", overflow: "hidden", marginBottom: "8px" }}>
					<div
						style={{
							borderBottom: isErrorExpanded ? "1px solid var(--vscode-editorGroup-border)" : "none",
							fontWeight: "normal",
							fontSize: "var(--vscode-font-size)",
							color: "var(--vscode-editor-foreground)",
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							cursor: "pointer",
						}}
						onClick={() => setIsErrorExpanded(!isErrorExpanded)}>
						<div
							style={{
								display: "flex",
								alignItems: "center",
								gap: "10px",
								flexGrow: 1,
							}}>
							<span
								className="codicon codicon-warning"
								style={{
									color: "var(--vscode-editorWarning-foreground)",
									opacity: 0.8,
									fontSize: 16,
									marginBottom: "-1.5px",
								}}></span>
							<span style={{ fontWeight: "bold" }}>{t("common:mermaid.render_error")}</span>
						</div>
						<div style={{ display: "flex", alignItems: "center" }}>
							<CopyButton
								onClick={(e) => {
									e.stopPropagation()
									const combinedContent = `Error: ${error}\n\n\`\`\`mermaid\n${code}\n\`\`\``
									copyWithFeedback(combinedContent, e)
								}}>
								<span className={`codicon codicon-${showCopyFeedback ? "check" : "copy"}`}></span>
							</CopyButton>
							<span className={`codicon codicon-chevron-${isErrorExpanded ? "up" : "down"}`}></span>
						</div>
					</div>
					{isErrorExpanded && (
						<div
							style={{
								padding: "8px",
								backgroundColor: "var(--vscode-editor-background)",
								borderTop: "none",
							}}>
							<div style={{ marginBottom: "8px", color: "var(--vscode-descriptionForeground)" }}>
								{error}
							</div>
							<CodeBlock language="mermaid" source={code} />
						</div>
					)}
				</div>
			) : (
				<MermaidButton containerRef={containerRef} code={code} isLoading={isLoading} svgToPng={svgToPng}>
					<SvgContainer onClick={handleClick} ref={containerRef} $isLoading={isLoading}></SvgContainer>
				</MermaidButton>
			)}
		</MermaidBlockContainer>
	)
}

async function svgToPng(svgEl: SVGElement): Promise<string> {
	const backgroundColor = getMermaidBackgroundColor()
	// Clone the SVG to avoid modifying the original
	const svgClone = svgEl.cloneNode(true) as SVGElement

	// Get the original viewBox
	const viewBox = svgClone.getAttribute("viewBox")?.split(" ").map(Number) || []
	const originalWidth = viewBox[2] || svgClone.clientWidth
	const originalHeight = viewBox[3] || svgClone.clientHeight

	// Calculate the scale factor to fit editor width while maintaining aspect ratio

	// Unless we can find a way to get the actual editor window dimensions through the VS Code API (which might be possible but would require changes to the extension side),
	// the fixed width seems like a reliable approach.
	const editorWidth = 3_600

	const scale = editorWidth / originalWidth
	const scaledHeight = originalHeight * scale

	// Update SVG dimensions
	svgClone.setAttribute("width", `${editorWidth}`)
	svgClone.setAttribute("height", `${scaledHeight}`)

	const serializer = new XMLSerializer()
	const svgString = serializer.serializeToString(svgClone)

	// Create a data URL directly
	// First, ensure the SVG string is properly encoded
	const encodedSvg = encodeURIComponent(svgString).replace(/'/g, "%27").replace(/"/g, "%22")

	const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodedSvg}`

	return new Promise((resolve, reject) => {
		const img = new Image()

		img.onload = () => {
			const canvas = document.createElement("canvas")
			canvas.width = editorWidth
			canvas.height = scaledHeight

			const ctx = canvas.getContext("2d")
			if (!ctx) return reject("Canvas context not available")

			ctx.fillStyle = backgroundColor
			ctx.fillRect(0, 0, canvas.width, canvas.height)

			ctx.imageSmoothingEnabled = true
			ctx.imageSmoothingQuality = "high"

			ctx.drawImage(img, 0, 0, editorWidth, scaledHeight)
			resolve(canvas.toDataURL("image/png", 1.0))
		}
		img.onerror = reject
		img.src = svgDataUrl
	})
}

const MermaidBlockContainer = styled.div`
	position: relative;
	margin: 8px 0;
`

const LoadingMessage = styled.div`
	padding: 8px 0;
	color: var(--vscode-descriptionForeground);
	font-style: italic;
	font-size: 0.9em;
`

const CopyButton = styled.button`
	padding: 3px;
	height: 24px;
	margin-right: 4px;
	color: var(--vscode-editor-foreground);
	display: flex;
	align-items: center;
	justify-content: center;
	background: transparent;
	border: none;
	cursor: pointer;

	&:hover {
		opacity: 0.8;
	}
`

interface SvgContainerProps {
	$isLoading: boolean
}

const SvgContainer = styled.div<SvgContainerProps>`
	opacity: ${(props) => (props.$isLoading ? 0.3 : 1)};
	min-height: 20px;
	transition: opacity 0.2s ease;
	cursor: pointer;
	display: flex;
	justify-content: center;
	max-height: 400px;

	/* Ensure the SVG scales within the container */
	& > svg {
		display: block; /* Ensure block layout */
		width: 100%;
		max-height: 100%; /* Respect container's max-height */
	}
`
