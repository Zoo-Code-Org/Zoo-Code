import { expect, test } from "../../../../playwright/coverage-fixture"
import { expectBoundedLayout } from "../../../../playwright/layout-contracts"
import { mountedStory } from "../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

const NOW = new Date("2026-06-01T12:00:00Z")

for (const theme of visualThemes) {
	test(`renders the Usage tab with provider limits and history in the VS Code ${theme.name} theme`, async ({
		mount,
		page,
	}) => {
		await page.clock.setFixedTime(NOW)
		const component = mountedStory(await mount("usage-settings"))
		await applyVisualTheme(page, theme)
		const story = component.getByTestId("usage-story")

		// Limits arrive from the (fake) host; wait for them so the screenshot is the settled state.
		await expect(story.getByTestId(`provider-limit-github-copilot`)).toBeVisible()
		await expect(story.getByTestId("usage-stats")).toBeVisible()
		await expect(story.getByTestId("usage-daily-chart")).toBeVisible()

		await expect(story).toHaveScreenshot(`usage-settings-${theme.name}.png`)
		const exportButton = story.getByTestId("usage-export-csv")
		await expectBoundedLayout(page, story, { focusedControl: exportButton })
	})
}

test("shows quiet statuses for provider limits that cannot be read, and keeps the history", async ({ mount, page }) => {
	await page.clock.setFixedTime(NOW)
	const component = mountedStory(await mount("usage-settings-degraded"))
	await applyVisualTheme(page, visualThemes[0])
	const story = component.getByTestId("usage-story")

	await expect(story.getByTestId("provider-limit-github-copilot")).toBeVisible()
	await expect(story.getByTestId("provider-limit-openrouter")).toBeVisible()
	await expect(story.getByTestId("provider-limit-deepseek")).toBeVisible()
	// No bars for providers that report nothing, but the usage history is unaffected.
	await expect(story.locator("[role=progressbar]")).toHaveCount(0)
	await expect(story.getByTestId("usage-stats")).toBeVisible()

	await expect(story).toHaveScreenshot("usage-settings-degraded.png")
})

test("shows the empty state, and hides the limits section when no provider has a usage API", async ({
	mount,
	page,
}) => {
	await page.clock.setFixedTime(NOW)
	const component = mountedStory(await mount("usage-settings-empty"))
	await applyVisualTheme(page, visualThemes[0])
	const story = component.getByTestId("usage-story")

	await expect(story.getByTestId("usage-empty")).toBeVisible()
	await expect(story.getByTestId("provider-limits")).toHaveCount(0)
	await expect(story.getByTestId("usage-export-csv")).toHaveCount(0)

	await expect(story).toHaveScreenshot("usage-settings-empty.png")
})
