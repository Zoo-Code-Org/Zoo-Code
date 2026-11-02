import { expect, test } from "../../../../playwright/coverage-fixture"
import { expectBoundedLayout } from "../../../../playwright/layout-contracts"
import { mountedStory } from "../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

// Matches the stories in MessageTimestamps.visual.fixture.tsx. Not imported: this file runs in Node, the fixture in the browser.
const TIMESTAMP_STORY_NOW = new Date("2026-06-01T12:00:00Z").getTime()

// The times are shown in the browser's time zone, so both it and the clock are fixed.
test.use({ timezoneId: "UTC", locale: "en-US" })

for (const theme of visualThemes) {
	test(`renders the time under a user message, an assistant reply and a completion in the VS Code ${theme.name} theme`, async ({
		mount,
		page,
	}) => {
		await page.clock.setFixedTime(new Date(TIMESTAMP_STORY_NOW))
		const component = mountedStory(await mount("chat-row-timestamps"))
		await applyVisualTheme(page, theme)
		const story = component.getByTestId("chat-row-timestamps-story")

		await expect(story.getByTestId("message-timestamp")).toHaveCount(3)
		await expect(story).toHaveScreenshot(`chat-row-timestamps-${theme.name}.png`)
	})

	test(`renders the start time in the expanded task header in the VS Code ${theme.name} theme`, async ({
		mount,
		page,
	}) => {
		await page.clock.setFixedTime(new Date(TIMESTAMP_STORY_NOW))
		const component = mountedStory(await mount("task-header-timestamp"))
		await applyVisualTheme(page, theme)
		const story = component.getByTestId("task-header-timestamp-story")

		await expect(story.getByTestId("message-timestamp")).toHaveCount(0) // collapsed: no time
		await story.getByText("Fix the login bug in the session store").first().click()
		await expect(story.getByTestId("message-timestamp")).toBeVisible()

		await expect(story).toHaveScreenshot(`task-header-timestamp-${theme.name}.png`)
		await expectBoundedLayout(page, story, { focusedControl: story.getByRole("button").first() })
	})

	test(`renders the absolute date and time in the history item footer in the VS Code ${theme.name} theme`, async ({
		mount,
		page,
	}) => {
		await page.clock.setFixedTime(new Date(TIMESTAMP_STORY_NOW))
		const component = mountedStory(await mount("task-item-footer-absolute"))
		await applyVisualTheme(page, theme)
		const story = component.getByTestId("task-item-footer-story")

		await expect(story.getByText("2026-05-31, 10:00")).toBeVisible()

		await expect(story).toHaveScreenshot(`task-item-footer-absolute-${theme.name}.png`)
		await expectBoundedLayout(page, story, { focusedControl: story.getByRole("button").first() })
	})
}
