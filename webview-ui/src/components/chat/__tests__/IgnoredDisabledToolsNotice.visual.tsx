import { expect, test } from "../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

for (const theme of visualThemes) {
	test(`renders the ignored disabled-tools warning in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		const component = mountedStory(await mount("ignored-disabled-tools-warning"))
		await applyVisualTheme(page, theme)

		// Lock in that the locale bundle actually resolved (a missing key would
		// render the raw "chat:ignoredDisabledTools.title" string instead).
		await expect(component.getByText("Disabled tool ignored", { exact: true })).toBeVisible()
		await expect(
			component.getByText(
				"The following tools cannot be disabled, so their disabledTools entries were ignored: attempt_completion.",
			),
		).toBeVisible()

		await expect(component).toHaveScreenshot(`ignored-disabled-tools-warning-${theme.name}.png`)
	})
}
