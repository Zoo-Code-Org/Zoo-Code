import { expect, test } from "../../../../playwright/coverage-fixture"
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

		// The URL wraps inside the row instead of overflowing or being cut off.
		const [urlBox, storyBox] = await Promise.all([url.boundingBox(), story.boundingBox()])
		expect(urlBox).not.toBeNull()
		expect(storyBox).not.toBeNull()
		expect(urlBox!.x + urlBox!.width).toBeLessThanOrEqual(storyBox!.x + storyBox!.width)
		const lineHeight = await url.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 16)
		expect(urlBox!.height).toBeGreaterThan(lineHeight * 1.5)

		await expect(story).toHaveScreenshot(`fetch-web-content-long-url-${theme.name}.png`)
	})
}
