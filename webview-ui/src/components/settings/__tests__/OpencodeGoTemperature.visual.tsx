import { expect, test } from "../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../playwright/mounted-story"

test("shows the temperature control only for supported OpenCode Go Responses states", async ({ mount }) => {
	const component = mountedStory(await mount("opencode-go-temperature"))
	const story = component.getByTestId("opencode-go-temperature-story")

	await expect(story).toHaveScreenshot("opencode-go-temperature.png")
})
