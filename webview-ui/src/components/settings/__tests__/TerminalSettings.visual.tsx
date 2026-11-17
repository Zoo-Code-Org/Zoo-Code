import { expect, test } from "../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

for (const theme of visualThemes) {
	test(`renders terminal settings in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		const component = mountedStory(await mount("terminal-settings"))
		await applyVisualTheme(page, theme)
		const story = component.getByTestId("terminal-settings-story")
		await expect(story.getByTestId("terminal-collapse-command-output-checkbox")).toBeVisible()
		await expect(story).toHaveScreenshot(`terminal-settings-${theme.name}.png`)
	})
}
