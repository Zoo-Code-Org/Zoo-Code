import { expect, test } from "../../../../playwright/coverage-fixture"
import { expectContrast } from "../../../../playwright/contrast"
import { mountedStory } from "../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

for (const theme of visualThemes) {
	test(`renders Mermaid sections in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		const component = mountedStory(await mount("mermaid-gantt"))
		await applyVisualTheme(page, theme)
		const svg = component.locator("svg")
		await expect(svg).toBeVisible({ timeout: 10_000 })
		await expect(svg.locator("..")).toHaveCSS("opacity", "1")

		await expectContrast(component.locator(".sectionTitle0"), {
			background: component.locator(".section0"),
			foregroundProperty: "fill",
			backgroundProperty: "fill",
			minimum: 4.5,
			label: `${theme.name} Mermaid section title`,
		})

		await expect(component).toHaveScreenshot(`mermaid-gantt-${theme.name}.png`)
	})
}
