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
		const sliderThumb = component.locator('[data-slot="slider-thumb"]')
		const sliderTrack = component.locator('[data-slot="slider-track"]')
		const sliderRange = component.locator('[data-slot="slider-range"]')
		await expectContrast(sliderThumb, {
			background: gallery,
			foregroundProperty: "background-color",
			minimum: 3,
			label: `${theme.name} slider thumb`,
		})
		await expectContrast(sliderRange, {
			background: sliderTrack,
			foregroundProperty: "background-color",
			minimum: 3,
			label: `${theme.name} slider range`,
		})
		await expectContrast(sliderThumb, {
			background: sliderRange,
			foregroundProperty: "border-color",
			minimum: 3,
			label: `${theme.name} slider thumb inner edge`,
		})
		await expectContrast(sliderThumb, {
			background: sliderTrack,
			foregroundProperty: "outline-color",
			minimum: 3,
			label: `${theme.name} slider thumb outer edge`,
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
		const galleryContentRight = await gallery.evaluate((element) => {
			const styles = getComputedStyle(element)
			return element.getBoundingClientRect().right - Number.parseFloat(styles.paddingRight)
		})
		for (const button of await gallery.getByRole("button").all()) {
			const geometry = await button.evaluate((element) => {
				const styles = getComputedStyle(element)
				return {
					clientWidth: element.clientWidth,
					scrollWidth: element.scrollWidth,
					leftPadding: Number.parseFloat(styles.paddingLeft),
					rightPadding: Number.parseFloat(styles.paddingRight),
					right: element.getBoundingClientRect().right,
				}
			})
			expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1)
			expect(Math.abs(geometry.leftPadding - geometry.rightPadding)).toBeLessThanOrEqual(0.5)
			expect(geometry.right).toBeLessThanOrEqual(galleryContentRight + 0.5)
		}
		await expect(
			expectContrast(component.getByTestId("unsupported-gradient"), {
				label: `${theme.name} unsupported gradient`,
			}),
		).rejects.toThrow("Unsupported background image")

		await expect(component).toHaveScreenshot(`accessibility-gallery-resting-${theme.name}.png`)

		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
		for (
			let index = 0;
			index < 10 && !(await input.evaluate((element) => element === document.activeElement));
			index++
		) {
			await page.keyboard.press("Tab")
		}
		await expect(input).toBeFocused()
		await expectContrast(input, {
			background: gallery,
			foregroundProperty: "border-color",
			minimum: 3,
			label: `${theme.name} input focus indicator`,
		})
		await expectContrast(input, {
			background: input,
			foregroundProperty: "border-color",
			minimum: 3,
			label: `${theme.name} input focus indicator against fill`,
		})
		await expect(component).toHaveScreenshot(`accessibility-gallery-focus-${theme.name}.png`)
	})
}
