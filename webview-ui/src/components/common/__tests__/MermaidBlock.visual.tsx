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

// The label of a diagram that cannot be drawn is text like the rest of the interface: it follows the interface scale.
for (const theme of visualThemes) {
	test(`sizes the Mermaid error label with the interface scale, set and unset, in the VS Code ${theme.name} theme`, async ({
		mount,
		page,
	}) => {
		const component = mountedStory(await mount("mermaid-error"))
		await applyVisualTheme(page, theme)
		// The row of the label: the warning icon sits in a flex row inside it.
		const label = component.locator(".codicon-warning").locator("xpath=../..")
		await expect(label).toBeVisible({ timeout: 10_000 })
		const fontSize = (locator: typeof label) =>
			locator.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))
		const vscodeFontSize = await page.evaluate(() =>
			Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--vscode-font-size")),
		)

		// Unset: the historical size, VS Code's.
		await page.evaluate(() => document.documentElement.style.removeProperty("--zoo-ui-scale"))
		expect(await fontSize(label)).toBe(vscodeFontSize)
		await expect(component).toHaveScreenshot(`mermaid-error-${theme.name}-unset.png`)

		// Set: 150% of it.
		await page.evaluate(() => document.documentElement.style.setProperty("--zoo-ui-scale", "1.5"))
		expect(await fontSize(label)).toBeCloseTo(vscodeFontSize * 1.5, 5)
		await expect(component).toHaveScreenshot(`mermaid-error-${theme.name}-set.png`)

		await page.evaluate(() => document.documentElement.style.removeProperty("--zoo-ui-scale"))
	})
}
