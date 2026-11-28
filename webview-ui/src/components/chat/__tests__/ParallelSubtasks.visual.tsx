import { expect, test } from "../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

for (const theme of visualThemes) {
	test(`renders the parallel-subtasks approval preview in the VS Code ${theme.name} theme`, async ({
		mount,
		page,
	}) => {
		const component = mountedStory(await mount("parallel-subtasks-approval"))
		await applyVisualTheme(page, theme)

		await expect(component).toHaveScreenshot(`parallel-subtasks-approval-${theme.name}.png`)
	})

	test(`renders the parallel-subtasks progress panel in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		// Matches the "parallel-subtasks-progress" story's reference time so the
		// running row's elapsed badge stays stable.
		await page.clock.setFixedTime(new Date("2026-06-01T12:00:45Z"))
		const component = mountedStory(await mount("parallel-subtasks-progress"))
		await applyVisualTheme(page, theme)

		await expect(component).toHaveScreenshot(`parallel-subtasks-progress-${theme.name}.png`)
	})
}
