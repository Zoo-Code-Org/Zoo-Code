import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"
import MermaidBlock from "../MermaidBlock"

const diagram = `gantt
    title Project plan
    dateFormat YYYY-MM-DD
    section Planning
    Define scope :done, scope, 2026-08-01, 3d
    section Delivery
    Ship release :active, release, after scope, 3d`

const themes = [
	{
		name: "dark",
		bodyClass: "vscode-dark",
		themeId: "Default Dark Modern",
		colors: {},
	},
	{
		name: "light",
		bodyClass: "vscode-light",
		themeId: "Default Light Modern",
		colors: {},
	},
	{
		name: "high-contrast",
		bodyClass: "vscode-high-contrast",
		themeId: "Default High Contrast",
		colors: {
			"--vscode-editor-background": "#000000",
			"--vscode-editor-foreground": "#ffffff",
			"--vscode-input-background": "#000000",
			"--vscode-input-border": "#ffffff",
			"--vscode-textLink-foreground": "#6fc3df",
		},
	},
	{
		name: "high-contrast-light",
		bodyClass: "vscode-high-contrast-light",
		themeId: "Default High Contrast Light",
		colors: {
			"--vscode-editor-background": "#ffffff",
			"--vscode-editor-foreground": "#000000",
			"--vscode-input-background": "#ffffff",
			"--vscode-input-border": "#000000",
			"--vscode-textLink-foreground": "#0044cc",
		},
	},
] as const

for (const theme of themes) {
	test(`renders Mermaid sections in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		await page.evaluate(({ bodyClass, themeId, colors }) => {
			document.documentElement.className = bodyClass
			document.body.className = bodyClass
			document.body.dataset.vscodeThemeId = themeId
			for (const [property, value] of Object.entries(colors)) {
				document.body.style.setProperty(property, value)
			}
		}, theme)

		const component = await mount(<MermaidBlock code={diagram} />)
		await expect(component.locator("svg")).toBeVisible({ timeout: 10_000 })

		const contrastRatio = await component.locator("svg").evaluate((svg) => {
			const section = svg.querySelector(".section0")!
			const title = svg.querySelector(".sectionTitle0")!
			const sectionStyles = getComputedStyle(section)
			const titleStyles = getComputedStyle(title)
			const fill = sectionStyles.fill
				.match(/\d+(?:\.\d+)?/g)!
				.slice(0, 3)
				.map(Number)
			const foreground = titleStyles.fill
				.match(/\d+(?:\.\d+)?/g)!
				.slice(0, 3)
				.map(Number)
			const body = getComputedStyle(document.body)
				.backgroundColor.match(/\d+(?:\.\d+)?/g)!
				.slice(0, 3)
				.map(Number)
			const alpha = Number(sectionStyles.opacity) * Number(sectionStyles.fillOpacity)
			const background = fill.map((channel, index) => Math.round(channel * alpha + body[index] * (1 - alpha)))
			const luminance = (rgb: number[]) => {
				const channels = rgb.map((channel) => {
					const value = channel / 255
					return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
				})
				return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
			}
			const lighter = Math.max(luminance(background), luminance(foreground))
			const darker = Math.min(luminance(background), luminance(foreground))
			return (lighter + 0.05) / (darker + 0.05)
		})

		expect(contrastRatio).toBeGreaterThanOrEqual(4.5)

		await expect(component).toHaveScreenshot(`mermaid-gantt-${theme.name}.png`)
	})
}
