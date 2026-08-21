import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"
import { expectContrast } from "../../../../playwright/contrast"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"
import { AccessibilityContrastGallery } from "./AccessibilityContrast.visual.fixture"

for (const theme of visualThemes) {
	test(`audits representative controls in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		await applyVisualTheme(page, theme)
		const component = await mount(<AccessibilityContrastGallery />)
		const gallery = component

		await expectContrast(component.getByRole("heading", { name: "New task" }), {
			background: gallery,
			label: `${theme.name} chat heading`,
		})
		await expectContrast(component.getByTestId("chat-description"), {
			background: gallery,
			label: `${theme.name} secondary chat text`,
		})
		const startButton = component.getByRole("button", { name: "Start task" })
		await expectContrast(startButton, {
			background: startButton,
			label: `${theme.name} primary button text`,
		})
		const input = component.getByRole("textbox", { name: "API endpoint" })
		await expectContrast(input, { background: input, label: `${theme.name} input text` })
		await expectContrast(input, {
			background: gallery,
			foregroundProperty: "border-color",
			minimum: 3,
			label: `${theme.name} input boundary`,
		})
		const textarea = component.getByRole("textbox", { name: "Task message" })
		await expectContrast(textarea, {
			background: gallery,
			foregroundProperty: "border-color",
			minimum: 3,
			label: `${theme.name} textarea boundary`,
		})
		const uncheckedCheckbox = component.getByRole("checkbox", { name: "Stream responses" })
		await expectContrast(uncheckedCheckbox, {
			background: gallery,
			foregroundProperty: "border-color",
			minimum: 3,
			label: `${theme.name} unchecked checkbox boundary`,
		})
		const checkedCheckbox = component.getByRole("checkbox", { name: "Include context" })
		await expectContrast(checkedCheckbox.locator("svg"), {
			background: checkedCheckbox,
			minimum: 3,
			label: `${theme.name} checked indicator`,
		})
		const unselectedRadio = component.getByRole("radio", { name: "Fast" })
		await expectContrast(unselectedRadio, {
			background: gallery,
			foregroundProperty: "border-color",
			minimum: 3,
			label: `${theme.name} radio boundary`,
		})
		await expectContrast(component.getByRole("radio", { name: "Balanced" }).locator("svg"), {
			background: gallery,
			foregroundProperty: "fill",
			minimum: 3,
			label: `${theme.name} selected radio indicator`,
		})
		const sliderThumb = component.getByRole("slider")
		await expectContrast(sliderThumb, {
			background: gallery,
			foregroundProperty: "background-color",
			minimum: 3,
			label: `${theme.name} slider thumb`,
		})
		const progressIndicator = component.getByRole("progressbar").locator("div")
		await expectContrast(progressIndicator, {
			background: gallery,
			foregroundProperty: "background-color",
			minimum: 3,
			label: `${theme.name} progress indicator`,
		})
		await expectContrast(component.getByRole("button", { name: "Chat settings" }), {
			background: gallery,
			minimum: 3,
			label: `${theme.name} settings icon`,
		})
		await expectContrast(component.getByTestId("error-message"), {
			background: gallery,
			label: `${theme.name} error text`,
		})
		const resetButton = component.getByRole("button", { name: "Reset" })
		await expectContrast(resetButton, {
			background: gallery,
			foregroundProperty: "border-color",
			minimum: 3,
			label: `${theme.name} outline button boundary`,
		})

		await expect(component).toHaveScreenshot(`accessibility-gallery-resting-${theme.name}.png`)

		await input.focus()
		await expect(input).toBeFocused()
		await expectContrast(input, {
			background: gallery,
			foregroundProperty: "border-color",
			minimum: 3,
			label: `${theme.name} input focus indicator`,
		})
		await expect(component).toHaveScreenshot(`accessibility-gallery-focus-${theme.name}.png`)
	})
}
