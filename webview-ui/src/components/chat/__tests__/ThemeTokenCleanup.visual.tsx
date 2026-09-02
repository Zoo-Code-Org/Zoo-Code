import { expect, test } from "../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../playwright/mounted-story"

const themes = [
	{
		name: "dark",
		bodyClass: "vscode-dark",
		themeId: "Default Dark Modern",
		expected: {
			hover: "rgba(90, 93, 94, 0.31)",
			active: "rgb(42, 45, 46)",
			description: "rgb(157, 157, 157)",
			background: "rgb(31, 31, 31)",
		},
	},
	{
		name: "light",
		bodyClass: "vscode-light",
		themeId: "Default Light Modern",
		expected: {
			hover: "rgba(184, 184, 184, 0.31)",
			active: "rgb(242, 242, 242)",
			description: "rgb(59, 59, 59)",
			background: "rgb(255, 255, 255)",
		},
	},
] as const

for (const theme of themes) {
	test(`renders remaining controls in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		const component = mountedStory(await mount("theme-token-cleanup"))
		await page.evaluate(({ bodyClass, themeId }) => {
			document.documentElement.className = bodyClass
			document.body.className = bodyClass
			document.body.dataset.vscodeThemeId = themeId
		}, theme)

		await component.evaluate(async () => {
			await document.fonts.ready
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
		})

		await expect(component).toHaveScreenshot(`remaining-controls-resting-${theme.name}.png`)

		const iconButton = component.getByRole("button", { name: "Settings" })
		await iconButton.hover()
		await expect(iconButton).toHaveCSS("background-color", theme.expected.hover)
		await iconButton.focus()
		await page.mouse.down()
		await expect(iconButton).toHaveCSS("background-color", theme.expected.active)
		await page.mouse.up()

		await expect(component).toHaveScreenshot(`remaining-controls-active-${theme.name}.png`)

		const checkbox = component.getByRole("checkbox", { name: "Include optional context" })
		await expect(checkbox).toHaveCSS("background-color", theme.expected.description)
		await expect(checkbox).toHaveCSS("color", theme.expected.background)
	})
}
