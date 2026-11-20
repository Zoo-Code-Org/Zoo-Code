import { expect, test } from "../../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../../playwright/mounted-story"

// The MiMo settings surface gained a Refresh Models affordance: a button that swaps
// its icon for a spinner while loading and appends a status line for the loading,
// success, and error states. That changes the block's height and the button's
// disabled appearance, which JSDOM cannot verify — hence the snapshot.

test("renders the unconfigured MiMo settings in the VS Code dark theme", async ({ mount, page }) => {
	await page.setViewportSize({ width: 480, height: 480 })
	const component = mountedStory(await mount("mimo-settings"))
	const story = component.getByTestId("mimo-settings-story")

	// Unconfigured: no API key yet, so the "Get MiMo API Key" link renders and the
	// Refresh Models button is disabled.
	await expect(story.getByRole("button", { name: /Refresh Models/ })).toBeDisabled()
	await expect(story.getByText("Get MiMo API Key")).toBeVisible()

	await expect(story).toHaveScreenshot("mimo-settings-unconfigured-dark.png")
})

test("renders the configured MiMo settings with an enabled refresh affordance", async ({ mount, page }) => {
	await page.setViewportSize({ width: 480, height: 480 })
	const component = mountedStory(await mount("mimo-settings", { configured: true }))
	const story = component.getByTestId("mimo-settings-story")

	// Configured: the refresh button is actionable and the API key link is gone.
	await expect(story.getByRole("button", { name: /Refresh Models/ })).toBeEnabled()
	await expect(story.getByText("Get MiMo API Key")).toHaveCount(0)

	await expect(story).toHaveScreenshot("mimo-settings-configured-dark.png")
})
