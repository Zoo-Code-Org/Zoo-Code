import { expect, test } from "../../../../playwright/coverage-fixture"
import { expectContrast } from "../../../../playwright/contrast"
import { expectBoundedLayout } from "../../../../playwright/layout-contracts"
import { mountedStory } from "../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

for (const theme of visualThemes) {
	test(`renders the production UI settings in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		const component = mountedStory(await mount("ui-settings"))
		await applyVisualTheme(page, theme)
		// The full provider bundle leaves a bare Zod reference after gallery tree-shaking.
		await page.evaluate(() => Object.assign(globalThis, { z: undefined }))
		const story = component.getByTestId("ui-settings-story")
		const heading = story.getByRole("heading", { name: "UI" })
		await expect(heading).toBeVisible()
		await expectContrast(heading, {
			background: heading.locator(".."),
			label: `${theme.name} UI settings heading`,
		})
		await expect(story).toHaveScreenshot(`ui-settings-${theme.name}.png`)
		const resetButton = story.getByTestId("chat-font-size-reset")
		await expectBoundedLayout(page, story, {
			actionRows: [resetButton.locator("..")],
			focusedControl: resetButton,
		})
	})
}

test("keeps long localized font-size controls bounded at the reflow width", async ({ mount, page }) => {
	const component = mountedStory(await mount("ui-settings-long-locale"))
	const story = component.getByTestId("ui-settings-story")
	const resetButton = story.getByTestId("chat-font-size-reset")

	await expectBoundedLayout(page, story, {
		actionRows: [resetButton.locator("..")],
		focusedControl: resetButton,
	})
})
