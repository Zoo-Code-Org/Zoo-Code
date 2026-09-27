export const themeFixtureDefinitions = [
	{
		name: "dark",
		themeId: "Default Dark Modern",
		bodyClass: "vscode-dark",
		colorScheme: "dark",
		kind: "dark",
	},
	{
		name: "light",
		themeId: "Default Light Modern",
		bodyClass: "vscode-light",
		colorScheme: "light",
		kind: "light",
	},
	{
		name: "high-contrast",
		themeId: "Default High Contrast",
		bodyClass: "vscode-high-contrast",
		colorScheme: "dark",
		kind: "high-contrast",
	},
	{
		name: "high-contrast-light",
		themeId: "Default High Contrast Light",
		bodyClass: "vscode-high-contrast-light",
		colorScheme: "light",
		kind: "high-contrast-light",
	},
] as const

export type ThemeFixtureDefinition = (typeof themeFixtureDefinitions)[number]

export function getThemeFixtureFileName(theme: ThemeFixtureDefinition): string {
	return `vscode-theme-${theme.name}.css`
}
