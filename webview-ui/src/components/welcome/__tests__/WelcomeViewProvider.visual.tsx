import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"
import { AppProviders } from "../../../../playwright/AppProviders"
import { expectContrast } from "../../../../playwright/contrast"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"
import { WelcomeLanding } from "../WelcomeLanding"

for (const theme of visualThemes) {
	test(`renders the full welcome screen in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		await page.setViewportSize({ width: 480, height: 640 })
		await applyVisualTheme(page, theme)
		const component = await mount(
			<AppProviders initialState={{ apiConfiguration: {} }}>
				<WelcomeLanding onGetStarted={() => undefined} onImportSettings={() => undefined} />
			</AppProviders>,
		)

		const screen = component.locator(".fixed.inset-0")
		const heading = component.getByRole("heading", { level: 2 })
		await expect(heading).toBeVisible()
		await expectContrast(heading, { background: screen, label: `${theme.name} welcome heading` })
		await expectContrast(component.getByRole("button", { name: /provider/i }).first(), {
			background: component.getByRole("button", { name: /provider/i }).first(),
			label: `${theme.name} welcome action`,
		})

		await expect(screen).toHaveScreenshot(`welcome-screen-${theme.name}.png`)
	})
}
