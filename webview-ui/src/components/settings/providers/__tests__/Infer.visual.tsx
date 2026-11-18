import { expect, test } from "../../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../../playwright/mounted-story"

test("renders the Infer settings for an unconfigured profile", async ({ mount, page }) => {
	await page.setViewportSize({ width: 480, height: 480 })
	const component = mountedStory(await mount("infer-settings"))
	const story = component.getByTestId("infer-settings-story")

	await expect(story).toHaveScreenshot("infer-settings.png")
})
