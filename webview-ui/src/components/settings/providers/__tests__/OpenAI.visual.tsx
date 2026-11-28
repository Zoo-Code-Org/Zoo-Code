import { expect, test } from "../../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../../playwright/themes"

for (const theme of visualThemes) {
	test(`renders the custom deployment name row in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		const component = mountedStory(await mount("openai-native-deployment-name"))
		await applyVisualTheme(page, theme)

		await expect(component.getByTestId("openai-native-deployment-name-input")).toBeVisible()

		await component.evaluate(async () => {
			await document.fonts.ready
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
		})

		await expect(component).toHaveScreenshot(`openai-native-deployment-name-${theme.name}.png`)
	})
}
