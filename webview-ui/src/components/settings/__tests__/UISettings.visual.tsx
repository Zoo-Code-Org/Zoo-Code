import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"
import { UISettingsStory } from "./UISettings.visual.fixture"

for (const theme of visualThemes) {
	test(`renders the production UI settings in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		await applyVisualTheme(page, theme)
		// The full provider bundle leaves a bare Zod reference after CT tree-shaking.
		await page.evaluate(() => Object.assign(globalThis, { z: undefined }))
		const component = await mount(<UISettingsStory />)
		const story = component.getByTestId("ui-settings-story")
		await expect(story.getByRole("heading", { name: "UI" })).toBeVisible()
		await expect(story).toHaveScreenshot(`ui-settings-${theme.name}.png`)
	})
}
