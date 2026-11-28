import { expect, test } from "../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

for (const theme of visualThemes) {
	test(`renders the expanded MCP tool status in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		const component = mountedStory(await mount("dynamic-tools-status"))
		await applyVisualTheme(page, theme)

		// A missing locale key would show the raw key instead.
		await component.getByRole("button", { name: "MCP tools attached this turn: 3 of 305" }).click()
		await expect(component.getByRole("listitem")).toHaveCount(3)
		// Remove the pointer state from the screenshot.
		await page.mouse.move(0, 0)
		await component.getByRole("button").blur()

		await expect(component).toHaveScreenshot(`dynamic-tools-status-${theme.name}.png`)
	})
}
