import type { Page } from "@playwright/test"

export interface VisualTheme {
	name: "dark" | "light" | "high-contrast" | "high-contrast-light"
	bodyClass: string
	themeId: string
}

export const visualThemes: VisualTheme[] = [
	{ name: "dark", bodyClass: "vscode-dark", themeId: "Default Dark Modern" },
	{ name: "light", bodyClass: "vscode-light", themeId: "Default Light Modern" },
	{ name: "high-contrast", bodyClass: "vscode-high-contrast", themeId: "Default High Contrast" },
	{
		name: "high-contrast-light",
		bodyClass: "vscode-high-contrast-light",
		themeId: "Default High Contrast Light",
	},
]

export async function applyVisualTheme(page: Page, theme: VisualTheme) {
	await page.evaluate(({ bodyClass, themeId }) => {
		document.documentElement.className = bodyClass
		document.documentElement.removeAttribute("style")
		document.body.className = bodyClass
		document.body.removeAttribute("style")
		document.body.dataset.vscodeThemeId = themeId
		// Contrast and layout assertions sample computed styles immediately
		// after the theme flip. Remove transitions so a sampled color is the
		// settled theme value, never mid-flight interpolation.
		let styleElement = document.getElementById("visual-theme-disable-transitions")
		if (!styleElement) {
			styleElement = document.createElement("style")
			styleElement.id = "visual-theme-disable-transitions"
			document.head.appendChild(styleElement)
		}
		styleElement.textContent = "*, *::before, *::after { transition: none !important; }"
	}, theme)
}
