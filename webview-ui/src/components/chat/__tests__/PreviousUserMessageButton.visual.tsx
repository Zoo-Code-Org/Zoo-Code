import { expect, test } from "../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../playwright/mounted-story"

const themes = [
	{ name: "dark", bodyClass: "vscode-dark", themeId: "Default Dark Modern" },
	{ name: "light", bodyClass: "vscode-light", themeId: "Default Light Modern" },
] as const

for (const theme of themes) {
	test(`renders previous-user-message navigation in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		const component = mountedStory(await mount("previous-user-message-button"))
		await page.evaluate(({ bodyClass, themeId }) => {
			document.documentElement.className = bodyClass
			document.body.className = bodyClass
			document.body.dataset.vscodeThemeId = themeId
		}, theme)

		await component.evaluate(async () => {
			await document.fonts.ready
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
		})

		await expect(component).toHaveScreenshot(`previous-user-message-button-${theme.name}.png`)
	})
}
