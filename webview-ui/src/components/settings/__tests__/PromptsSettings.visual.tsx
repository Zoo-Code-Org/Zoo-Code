import { expect, test } from "../../../../playwright/coverage-fixture"
import { expectContrast } from "../../../../playwright/contrast"
import { expectBoundedLayout } from "../../../../playwright/layout-contracts"
import { mountedStory } from "../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

for (const theme of visualThemes) {
	test(`renders the task title prompt settings in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		const component = mountedStory(await mount("prompts-settings"))
		await applyVisualTheme(page, theme)
		// The option list is taller than the default viewport, which would leave the last option unclickable.
		await page.setViewportSize({ width: 800, height: 1400 })
		const story = component.getByTestId("prompts-settings-story")
		await story.getByTestId("support-prompt-select-trigger").click()
		await page.getByTestId("TASK_TITLE-option").click()

		const toggle = story.getByTestId("task-title-enabled-checkbox")
		await expect(toggle).toBeVisible()
		const profileSelect = story.getByTestId("task-title-api-config-select")
		await expect(profileSelect).toBeVisible()
		await expectContrast(profileSelect, {
			background: profileSelect.locator(".."),
			label: `${theme.name} task title profile selector`,
		})
		await expect(story).toHaveScreenshot(`prompts-settings-task-title-${theme.name}.png`)
		await expectBoundedLayout(page, story, { focusedControl: profileSelect })
	})
}
