import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { getMermaidBackgroundColor, getMermaidConfig, useMermaidTheme } from "../mermaidTheme"

function applyTheme(
	className: string,
	colors: { background: string; foreground: string; surface: string; border: string; link: string },
) {
	document.body.className = className
	document.body.style.setProperty("--vscode-editor-background", colors.background)
	document.body.style.setProperty("--vscode-editor-foreground", colors.foreground)
	document.body.style.setProperty("--vscode-input-background", colors.surface)
	document.body.style.setProperty("--vscode-input-border", colors.border)
	document.body.style.setProperty("--vscode-textLink-foreground", colors.link)
}

describe("Mermaid theme", () => {
	beforeEach(() => {
		document.body.dataset.vscodeThemeId = "Default Light Modern"
		applyTheme("vscode-light", {
			background: "#ffffff",
			foreground: "#333333",
			surface: "#f3f3f3",
			border: "#717171",
			link: "#006ab1",
		})
	})

	afterEach(() => {
		document.body.className = ""
		document.body.removeAttribute("style")
		delete document.body.dataset.vscodeThemeId
		delete document.body.dataset.vscodeThemeKind
	})

	it("builds a light base theme from VS Code colors", () => {
		const config = getMermaidConfig("light")

		expect(config).toMatchObject({
			securityLevel: "strict",
			theme: "base",
			themeVariables: {
				darkMode: false,
				background: "#ffffff",
				primaryColor: "#f3f3f3",
				primaryTextColor: "#333333",
				primaryBorderColor: "#717171",
				linkColor: "#006ab1",
			},
		})
		expect(getMermaidBackgroundColor()).toBe("#ffffff")
	})

	it("builds a dark theme and normalizes translucent colors", () => {
		applyTheme("vscode-dark", {
			background: "rgb(30, 30, 30)",
			foreground: "rgb(212, 212, 212)",
			surface: "rgba(60, 60, 60, 0.5)",
			border: "#8888",
			link: "#3794ff",
		})

		const config = getMermaidConfig("dark")

		expect(config.themeVariables).toMatchObject({
			darkMode: true,
			background: "#1e1e1e",
			primaryColor: "#2d2d2d",
			primaryTextColor: "#d4d4d4",
			primaryBorderColor: "#575757",
		})
	})

	it("updates when the host switches themes", async () => {
		const { result } = renderHook(() => useMermaidTheme())
		expect(result.current.kind).toBe("light")

		act(() => {
			document.body.className = "vscode-high-contrast"
			document.body.dataset.vscodeThemeId = "Default High Contrast"
			document.body.style.setProperty("--vscode-editor-background", "#000000")
			document.body.style.setProperty("--vscode-editor-foreground", "#ffffff")
		})

		await waitFor(() => expect(result.current.kind).toBe("high-contrast"))
		expect(result.current.signature).toContain("Default High Contrast")
	})
})
