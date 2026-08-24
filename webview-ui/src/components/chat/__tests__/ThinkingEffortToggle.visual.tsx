import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"
import { ThinkingEffortToggleStory } from "./ThinkingEffortToggle.visual.fixture"

// DTE series 4/5: the toggle only renders for models that advertise per-request
// effort support, so the story pins such a model (see the fixture).
for (const theme of visualThemes.filter((candidate) => candidate.name === "dark" || candidate.name === "light")) {
	test(`renders the thinking effort toggle in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		await applyVisualTheme(page, theme)
		// The full provider bundle leaves a bare Zod reference after CT tree-shaking.
		await page.evaluate(() => Object.assign(globalThis, { z: undefined }))
		const component = await mount(<ThinkingEffortToggleStory />)
		const story = component.getByTestId("thinking-effort-toggle-story")
		const trigger = story.getByTestId("thinking-effort-toggle-trigger")
		await expect(trigger).toBeVisible()
		await expect(story).toHaveScreenshot(`thinking-effort-toggle-resting-${theme.name}.png`)

		await trigger.click()
		const menu = page.getByTestId("thinking-effort-toggle-menu")
		await expect(menu).toBeVisible()
		await expect(menu.getByTestId("thinking-effort-option-high")).toBeVisible()
		// The menu is a portal sibling of the story box (opened below the
		// trigger), so capture the menu element itself. Finish the portal
		// entrance animations first so the capture is pixel-stable.
		await page.evaluate(() => {
			document.getAnimations().forEach((animation) => animation.finish())
		})
		await expect(menu).toHaveScreenshot(`thinking-effort-toggle-menu-${theme.name}.png`)
	})
}
