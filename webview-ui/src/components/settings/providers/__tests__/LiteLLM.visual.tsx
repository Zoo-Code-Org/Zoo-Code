import { expect, test } from "../../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../../playwright/themes"

for (const theme of visualThemes) {
	test(`renders LiteLLM reasoning settings in ${theme.name}`, async ({ mount, page }) => {
		await page.setViewportSize({ width: 480, height: 900 })
		const component = mountedStory(await mount("litellm-reasoning-settings"))
		await applyVisualTheme(page, theme)
		await page.evaluate(() => customElements.whenDefined("vscode-dropdown"))
		// The control lives in the collapsed-by-default Advanced settings section.
		await component.getByText("Advanced settings", { exact: true }).click()
		await expect(component.getByText("Send reasoning back to the model", { exact: true })).toBeVisible()
		await expect(component).toHaveScreenshot(`litellm-reasoning-settings-${theme.name}.png`)
	})
}
