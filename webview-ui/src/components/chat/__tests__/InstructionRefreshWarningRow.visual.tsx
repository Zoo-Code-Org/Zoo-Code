import { expect, test } from "../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

for (const theme of visualThemes) {
	test(`renders the instruction refresh warning in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		const component = mountedStory(await mount("instruction-refresh-warning"))
		await applyVisualTheme(page, theme)

		await expect(component.getByText("Some instructions could not be reloaded", { exact: true })).toBeVisible()
		await expect(component.getByText(/\/workspace\/\.roorules \(EACCES\)/)).toBeVisible()

		await expect(component).toHaveScreenshot(`instruction-refresh-warning-${theme.name}.png`)
	})
}
