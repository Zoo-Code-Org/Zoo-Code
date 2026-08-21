import type { Page } from "@playwright/test"

export interface VisualTheme {
	name: "dark" | "light" | "high-contrast" | "high-contrast-light"
	bodyClass: string
	themeId: string
	colors?: Record<string, string>
}

export const visualThemes: VisualTheme[] = [
	{ name: "dark", bodyClass: "vscode-dark", themeId: "Default Dark Modern" },
	{ name: "light", bodyClass: "vscode-light", themeId: "Default Light Modern" },
	{
		name: "high-contrast",
		bodyClass: "vscode-high-contrast",
		themeId: "Default High Contrast",
		colors: {
			"--vscode-foreground": "#ffffff",
			"--vscode-descriptionForeground": "#ffffff",
			"--vscode-errorForeground": "#ff8080",
			"--vscode-focusBorder": "#f38518",
			"--vscode-editor-foreground": "#ffffff",
			"--vscode-editor-background": "#000000",
			"--vscode-editorGroup-border": "#6fc3df",
			"--vscode-button-foreground": "#ffffff",
			"--vscode-button-background": "#0f4a85",
			"--vscode-button-hoverBackground": "#0f4a85",
			"--vscode-dropdown-foreground": "#ffffff",
			"--vscode-dropdown-background": "#000000",
			"--vscode-dropdown-border": "#6fc3df",
			"--vscode-input-foreground": "#ffffff",
			"--vscode-input-background": "#000000",
			"--vscode-input-border": "#6fc3df",
			"--vscode-list-hoverForeground": "#ffffff",
			"--vscode-list-hoverBackground": "#000000",
			"--vscode-list-activeSelectionBackground": "#0f4a85",
			"--vscode-list-activeSelectionForeground": "#ffffff",
			"--vscode-toolbar-hoverBackground": "#000000",
			"--vscode-panel-border": "#6fc3df",
			"--vscode-textLink-foreground": "#6fc3df",
			"--vscode-badge-background": "#0f4a85",
			"--vscode-badge-foreground": "#ffffff",
		},
	},
	{
		name: "high-contrast-light",
		bodyClass: "vscode-high-contrast-light",
		themeId: "Default High Contrast Light",
		colors: {
			"--vscode-foreground": "#000000",
			"--vscode-descriptionForeground": "#000000",
			"--vscode-errorForeground": "#b5200d",
			"--vscode-focusBorder": "#0066bf",
			"--vscode-editor-foreground": "#000000",
			"--vscode-editor-background": "#ffffff",
			"--vscode-editorGroup-border": "#0044cc",
			"--vscode-button-foreground": "#ffffff",
			"--vscode-button-background": "#005fb8",
			"--vscode-button-hoverBackground": "#005fb8",
			"--vscode-dropdown-foreground": "#000000",
			"--vscode-dropdown-background": "#ffffff",
			"--vscode-dropdown-border": "#0044cc",
			"--vscode-input-foreground": "#000000",
			"--vscode-input-background": "#ffffff",
			"--vscode-input-border": "#0044cc",
			"--vscode-list-hoverForeground": "#000000",
			"--vscode-list-hoverBackground": "#ffffff",
			"--vscode-list-activeSelectionBackground": "#005fb8",
			"--vscode-list-activeSelectionForeground": "#ffffff",
			"--vscode-toolbar-hoverBackground": "#ffffff",
			"--vscode-panel-border": "#0044cc",
			"--vscode-textLink-foreground": "#0044cc",
			"--vscode-badge-background": "#005fb8",
			"--vscode-badge-foreground": "#ffffff",
		},
	},
]

export async function applyVisualTheme(page: Page, theme: VisualTheme) {
	await page.evaluate(({ bodyClass, themeId, colors }) => {
		document.documentElement.className = bodyClass
		document.documentElement.removeAttribute("style")
		document.body.className = bodyClass
		document.body.removeAttribute("style")
		document.body.dataset.vscodeThemeId = themeId
		for (const [property, value] of Object.entries(colors ?? {})) {
			document.documentElement.style.setProperty(property, value)
			document.body.style.setProperty(property, value)
		}
	}, theme)
}
