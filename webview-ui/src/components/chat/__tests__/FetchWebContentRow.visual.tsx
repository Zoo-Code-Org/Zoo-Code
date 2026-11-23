import { expect, test } from "../../../../playwright/coverage-fixture"
import { expectBoundedLayout } from "../../../../playwright/layout-contracts"
import { mountedStory } from "../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

for (const theme of visualThemes) {
	test(`wraps a long fetch approval URL in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		const component = mountedStory(await mount("fetch-web-content-long-url"))
		await applyVisualTheme(page, theme)
		const story = component.getByTestId("fetch-web-content-story")
		const url = story.getByTestId("fetch-url")

		await expect(story.getByText("Zoo wants to fetch web content", { exact: true })).toBeVisible()
		await expect(url).toContainText(".attacker.example/path")

		await expect(story).toHaveScreenshot(`fetch-web-content-long-url-${theme.name}.png`)
		// The whole URL wraps inside the row at 320px with WCAG text spacing: nothing overflows or is clipped. The
		// row is read-only, so there is no control to focus.
		await expectBoundedLayout(page, story)
	})
}
