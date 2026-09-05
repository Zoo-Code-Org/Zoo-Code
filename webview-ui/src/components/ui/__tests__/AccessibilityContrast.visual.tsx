import { expect, test } from "../../../../playwright/coverage-fixture"
import { expectContrast } from "../../../../playwright/contrast"
import { mountedStory } from "../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

for (const theme of visualThemes) {
	test(`audits representative controls in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		const component = mountedStory(await mount("accessibility-contrast"))
		await applyVisualTheme(page, theme)
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
		const layout = await gallery.evaluate((element) => {
			const contentBox = (target: Element) => {
				const rect = target.getBoundingClientRect()
				const styles = getComputedStyle(target)
				return {
					left: rect.left + Number.parseFloat(styles.borderLeftWidth) + Number.parseFloat(styles.paddingLeft),
					right:
						rect.right -
						Number.parseFloat(styles.borderRightWidth) -
						Number.parseFloat(styles.paddingRight),
				}
			}
			const rect = element.getBoundingClientRect()
			const root = document.querySelector("#root") as HTMLElement
			return {
				viewportWidth: window.innerWidth,
				rootContent: contentBox(root),
				galleryRect: { left: rect.left, right: rect.right },
				galleryContent: contentBox(element),
				buttons: Array.from(element.querySelectorAll("button")).map((button) => {
					const buttonRect = button.getBoundingClientRect()
					const styles = getComputedStyle(button)
					return {
						left: buttonRect.left,
						right: buttonRect.right,
						clientWidth: button.clientWidth,
						scrollWidth: button.scrollWidth,
						leftPadding: Number.parseFloat(styles.paddingLeft),
						rightPadding: Number.parseFloat(styles.paddingRight),
					}
				}),
				actionRows: ["chat-actions", "settings-actions"].map((testId) => {
					const row = element.querySelector(`[data-testid="${testId}"]`) as HTMLElement
					const rowRect = row.getBoundingClientRect()
					const buttons = row.querySelectorAll("button")
					return {
						left: rowRect.left,
						right: rowRect.right,
						clientWidth: row.clientWidth,
						scrollWidth: row.scrollWidth,
						firstButtonLeft: buttons[0].getBoundingClientRect().left,
						lastButtonRight: buttons[buttons.length - 1].getBoundingClientRect().right,
					}
				}),
			}
		})
		expect(layout.galleryRect.left).toBeGreaterThanOrEqual(layout.rootContent.left - 0.5)
		expect(layout.galleryRect.right).toBeLessThanOrEqual(layout.rootContent.right + 0.5)
		expect(layout.galleryRect.right).toBeLessThanOrEqual(layout.viewportWidth)
		for (const button of layout.buttons) {
			expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth)
			expect(Math.abs(button.leftPadding - button.rightPadding)).toBeLessThanOrEqual(0.5)
			expect(button.left).toBeGreaterThanOrEqual(layout.galleryContent.left - 0.5)
			expect(button.right).toBeLessThanOrEqual(layout.galleryContent.right + 0.5)
		}
		for (const row of layout.actionRows) {
			expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth)
			expect(row.firstButtonLeft).toBeGreaterThanOrEqual(row.left - 0.5)
			expect(row.lastButtonRight).toBeLessThanOrEqual(row.right + 0.5)
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
