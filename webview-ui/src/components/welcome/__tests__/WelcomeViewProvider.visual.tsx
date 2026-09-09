import { expect, test } from "../../../../playwright/coverage-fixture"
import { expectContrast } from "../../../../playwright/contrast"
import { expectBoundedLayout } from "../../../../playwright/layout-contracts"
import { mountedStory } from "../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

for (const theme of visualThemes) {
	test(`renders the full welcome screen in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		await page.setViewportSize({ width: 480, height: 640 })
		const component = mountedStory(await mount("welcome"))
		await applyVisualTheme(page, theme)

		const screen = component.locator(".fixed.inset-0")
		const heading = component.getByRole("heading", { level: 2 })
		const action = component.getByRole("button", { name: /provider/i }).first()
		await expect(heading).toBeVisible()
		await expectContrast(heading, { background: screen, label: `${theme.name} welcome heading` })
		await expectContrast(action, {
			background: action,
			label: `${theme.name} welcome action`,
		})
		if (theme.name.startsWith("high-contrast")) {
			await expect(action).toHaveCSS("border-top-width", "1px")
			await expect(action).toHaveCSS("border-top-style", "solid")
			await expectContrast(action, {
				background: screen,
				foregroundProperty: "border-color",
				minimum: 3,
				label: `${theme.name} welcome action boundary`,
			})
		}

		await expect(screen).toHaveScreenshot(`welcome-screen-${theme.name}.png`)
		await expectBoundedLayout(page, component, {
			actionRows: [action.locator("..")],
			focusedControl: action,
		})
	})
}
