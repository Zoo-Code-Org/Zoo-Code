import { useEffect } from "react"

import type { ExtensionMessage, WebviewThemeFixture } from "@roo-code/types"

import { vscode } from "./vscode"

function collectVSCodeProperties(style: CSSStyleDeclaration, properties: Set<string>): void {
	for (let index = 0; index < style.length; index++) {
		const property = style.item(index)
		if (property.startsWith("--vscode-")) {
			properties.add(property)
		}
	}
}

export function captureWebviewThemeFixture(): WebviewThemeFixture {
	const styles = getComputedStyle(document.body)
	const properties = new Set<string>()
	const variables: Record<string, string> = {}

	collectVSCodeProperties(document.documentElement.style, properties)
	collectVSCodeProperties(document.body.style, properties)
	for (const property of properties) {
		variables[property] = styles.getPropertyValue(property).trim()
	}

	return {
		themeId: document.body.dataset.vscodeThemeId ?? "",
		bodyClass: document.body.className,
		variables,
	}
}

export function useThemeFixtureProbe(): void {
	useEffect(() => {
		const animationFrames = new Set<number>()

		const onMessage = (event: MessageEvent<ExtensionMessage>) => {
			if (event.data.type !== "themeFixtureProbeRequest" || !event.data.requestId) {
				return
			}

			const requestId = event.data.requestId
			const firstFrame = requestAnimationFrame(() => {
				animationFrames.delete(firstFrame)
				const secondFrame = requestAnimationFrame(() => {
					animationFrames.delete(secondFrame)
					vscode.postMessage({
						type: "themeFixtureProbeResponse",
						requestId,
						themeFixture: captureWebviewThemeFixture(),
					})
				})
				animationFrames.add(secondFrame)
			})
			animationFrames.add(firstFrame)
		}

		window.addEventListener("message", onMessage)
		return () => {
			window.removeEventListener("message", onMessage)
			for (const animationFrame of animationFrames) {
				cancelAnimationFrame(animationFrame)
			}
			animationFrames.clear()
		}
	}, [])
}
