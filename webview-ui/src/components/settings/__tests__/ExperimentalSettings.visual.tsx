import { expect, test } from "../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

for (const theme of visualThemes) {
	test(`renders the experimental settings section in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		const component = mountedStory(await mount("experimental-settings"))
		await applyVisualTheme(page, theme)
		const story = component.getByTestId("experimental-settings-story")
		await expect(story).toHaveScreenshot(`experimental-settings-${theme.name}.png`)
	})
}
