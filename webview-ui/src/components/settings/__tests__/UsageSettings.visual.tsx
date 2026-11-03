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

// Real focus and key events, which the unit tests cannot cover because the unit test setup stubs `focus()`.
test("the time range is one tab stop and the arrow keys move between the ranges and select them", async ({
	mount,
	page,
}) => {
	await page.clock.setFixedTime(NOW)
	const component = mountedStory(await mount("usage-settings"))
	const story = component.getByTestId("usage-story")
	const range = (name: "today" | "7d" | "30d" | "all") => story.getByTestId(`usage-range-${name}`)

	await range("7d").focus()
	await expect(range("7d")).toHaveAttribute("aria-checked", "true")

	await page.keyboard.press("ArrowRight")
	await expect(range("30d")).toBeFocused()
	await expect(range("30d")).toHaveAttribute("aria-checked", "true")
	await page.keyboard.press("ArrowLeft")
	await expect(range("7d")).toBeFocused()
	await expect(range("7d")).toHaveAttribute("aria-checked", "true")

	// Only the selected range is a tab stop: Tab leaves the group instead of stepping through the ranges.
	await expect(range("7d")).toHaveAttribute("tabindex", "0")
	await expect(range("30d")).toHaveAttribute("tabindex", "-1")
	await page.keyboard.press("Tab")
	for (const name of ["today", "7d", "30d", "all"] as const) await expect(range(name)).not.toBeFocused()
})
