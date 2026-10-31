import { expect, test } from "../../../../playwright/coverage-fixture"
import { expectBoundedLayout } from "../../../../playwright/layout-contracts"
import { mountedStory } from "../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

for (const theme of visualThemes) {
	test(`renders the Language tab date and time settings in the VS Code ${theme.name} theme`, async ({
		mount,
		page,
	}) => {
		const component = mountedStory(await mount("language-settings"))
		await applyVisualTheme(page, theme)
		const story = component.getByTestId("language-settings-story")

		await expect(story.getByTestId("time-format-24h")).toBeVisible()
		await expect(story.getByTestId("date-format-select")).toBeVisible()
		await expect(story.getByTestId("time-format-preview")).toBeVisible()

		await expect(story).toHaveScreenshot(`language-settings-${theme.name}.png`)
		await expectBoundedLayout(page, story, { focusedControl: story.getByTestId("time-format-24h") })
	})
}

// Real focus and key events, which the unit tests cannot cover because the unit test setup stubs `focus()`. This
// only checks where the focus goes; what gets selected, and the saved value, are asserted in Vitest.
test("the time format is one tab stop and the arrow keys move the focus between the options", async ({
	mount,
	page,
}) => {
	const component = mountedStory(await mount("language-settings"))
	const story = component.getByTestId("language-settings-story")
	const option = (format: "auto" | "12h" | "24h") => story.getByTestId(`time-format-${format}`)

	// The story starts on 24-hour; the group is entered on the selected option.
	await option("24h").focus()
	await expect(option("24h")).toBeFocused()

	await page.keyboard.press("ArrowRight")
	await expect(option("auto")).toBeFocused() // wraps from the last option to the first
	await page.keyboard.press("ArrowRight")
	await expect(option("12h")).toBeFocused()
	await page.keyboard.press("ArrowLeft")
	await expect(option("auto")).toBeFocused()
	await page.keyboard.press("ArrowLeft")
	await expect(option("24h")).toBeFocused() // wraps from the first option to the last

	// Only the focused option is a tab stop: Tab leaves the group instead of stepping through its options.
	await expect(option("24h")).toHaveAttribute("tabindex", "0")
	await expect(option("auto")).toHaveAttribute("tabindex", "-1")
	await page.keyboard.press("Tab")
	for (const format of ["auto", "12h", "24h"] as const) await expect(option(format)).not.toBeFocused()
})
