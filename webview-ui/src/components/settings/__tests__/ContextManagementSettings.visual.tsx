import { expect, test } from "../../../../playwright/coverage-fixture"
import { collectBoundedLayoutFailures, REFLOW_VIEWPORT_WIDTH } from "../../../../playwright/layout-contracts"
import { mountedStory } from "../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

// Declared in webview-ui/src/i18n/locales/en/settings.json under
// settings:contextManagement.idleCondensing.name; the checkbox takes its accessible
// name from that label text, so the two must stay in sync.
const idleCondenseLabel = "Idle condensing"

for (const theme of visualThemes) {
	test(`renders the enabled idle condensing panel in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		const component = mountedStory(await mount("context-management-settings"))
		await applyVisualTheme(page, theme)
		const story = component.getByTestId("context-management-settings-story")
		const checkbox = story.getByRole("checkbox", { name: idleCondenseLabel })
		await expect(checkbox).toBeVisible()
		await expect(checkbox).toBeChecked()
		await expect(story.getByTestId("idle-condense-threshold-slider")).toBeVisible()
		await expect(story.getByTestId("idle-condense-time-input")).toBeVisible()
		await expect(story).toHaveScreenshot(`context-management-settings-${theme.name}.png`)
	})
}

test("keeps the enabled idle panel readable at narrow editor widths", async ({ mount, page }) => {
	await page.setViewportSize({ width: REFLOW_VIEWPORT_WIDTH, height: 640 })
	const component = mountedStory(await mount("context-management-settings"))
	const story = component.getByTestId("context-management-settings-story")

	await expect(story.getByTestId("idle-condense-threshold-slider")).toBeVisible()
	await expect(story.getByTestId("idle-condense-time-input")).toBeVisible()
	await expect(story).toHaveScreenshot("context-management-settings-320.png")
	await expect.poll(() => story.evaluate(collectBoundedLayoutFailures)).toEqual([])
})
