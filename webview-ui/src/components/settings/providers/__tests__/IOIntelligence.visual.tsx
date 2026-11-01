import { expect, test } from "../../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../../playwright/mounted-story"

test("renders the IO Intelligence settings for an unconfigured profile", async ({ mount, page }) => {
	await page.setViewportSize({ width: 480, height: 480 })
	const component = mountedStory(await mount("io-intelligence-settings"))
	const story = component.getByTestId("io-intelligence-settings-story")

	await expect(story).toHaveScreenshot("io-intelligence-settings.png")
})
