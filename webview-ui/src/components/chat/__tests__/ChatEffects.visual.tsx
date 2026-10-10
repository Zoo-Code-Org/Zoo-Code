import { expect, test } from "../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

for (const theme of visualThemes) {
	test(`streaming reasoning and striped markdown in ${theme.name}`, async ({ mount, page }) => {
		await page.clock.setFixedTime(new Date("2026-01-01T00:00:00Z"))
		const component = mountedStory(await mount("chat-effects"))
		await applyVisualTheme(page, theme)
		const story = component.getByTestId("chat-effects-story")
		const label = story.locator(".animate-thinking-shine")
		await expect(label).toHaveCSS("animation-name", "thinking-shine")
		await label.evaluate((element) => {
			for (const animation of element.getAnimations()) {
				animation.pause()
				// At 500 ms the highlight band crosses the middle of the label.
				animation.currentTime = 500
			}
		})
		await expect(story.getByRole("table")).toBeVisible()
		const rows = story.locator("tbody tr")
		const firstBackground = await rows.nth(0).evaluate((element) => getComputedStyle(element).backgroundColor)
		await expect(rows.nth(1)).not.toHaveCSS("background-color", firstBackground)
		await expect(story).toHaveScreenshot(`chat-effects-${theme.name}.png`, { animations: "allow" })

		await page.emulateMedia({ reducedMotion: "reduce" })
		await expect(label).toHaveCSS("animation-name", "none")
		await expect(label).toHaveCSS("background-image", "none")
		const foreground = await story.evaluate((element) => getComputedStyle(element).color)
		await expect(label).toHaveCSS("-webkit-text-fill-color", foreground)
	})
}
