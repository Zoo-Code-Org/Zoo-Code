import { expect, test } from "../../../../playwright/coverage-fixture"
import { expectBoundedLayout } from "../../../../playwright/layout-contracts"
import { mountedStory } from "../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

for (const theme of visualThemes) {
	test(`renders the production chat composer in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		const component = mountedStory(await mount("chat-text-area"))
		await applyVisualTheme(page, theme)
		// The full provider bundle leaves a bare Zod reference after gallery tree-shaking.
		await page.evaluate(() => Object.assign(globalThis, { z: undefined }))
		const story = component.getByTestId("chat-text-area-story")
		const editor = story.getByRole("textbox")
		await expect(editor).toBeVisible()
		await expect(story).toHaveScreenshot(`chat-composer-resting-${theme.name}.png`)

		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
		for (
			let index = 0;
			index < 10 && !(await editor.evaluate((element) => element === document.activeElement));
			index++
		) {
			await page.keyboard.press("Tab")
		}
		await expect(editor).toBeFocused()
		await expect(story).toHaveScreenshot(`chat-composer-focus-${theme.name}.png`)
		await expectBoundedLayout(page, story, {
			actionRows: [story.locator(".flex.items-center.gap-2").last()],
			focusedControl: editor,
		})
	})
}
