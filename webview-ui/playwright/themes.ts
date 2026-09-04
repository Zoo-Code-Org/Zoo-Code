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

/**
 * Apply a theme with color transitions temporarily disabled (see the
 * `.visual-theme-applying` rule in `vscode-theme-base.css`). Without this,
 * the theme class swap starts ~150ms color transitions and assertions run
 * right after can sample intermediate colors and fail contrast checks.
 */
export async function applyVisualTheme(page: Page, theme: VisualTheme) {
	await page.evaluate(({ bodyClass, themeId }) => {
		const root = document.documentElement
		const body = document.body
		root.className = `${bodyClass} visual-theme-applying`
		body.className = `${bodyClass} visual-theme-applying`
		root.removeAttribute("style")
		body.removeAttribute("style")
		body.dataset.vscodeThemeId = themeId
		// Force a style flush while transitions are disabled so every animated
		// property snaps to its final value, then re-enable transitions.
		void root.offsetHeight
		root.classList.remove("visual-theme-applying")
		body.classList.remove("visual-theme-applying")
	}, theme)
}
