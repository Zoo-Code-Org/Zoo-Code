import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"
import { expectContrast } from "../../../../playwright/contrast"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"
import MermaidBlock from "../MermaidBlock"

const diagram = `gantt
    title Project plan
    dateFormat YYYY-MM-DD
    section Planning
    Define scope :done, scope, 2026-08-01, 3d
    section Delivery
    Ship release :active, release, after scope, 3d`

for (const theme of visualThemes) {
	test(`renders Mermaid sections in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		await applyVisualTheme(page, theme)

		const component = await mount(<MermaidBlock code={diagram} />)
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
