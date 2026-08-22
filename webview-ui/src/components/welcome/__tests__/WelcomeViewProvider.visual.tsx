import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"
import { AppProviders } from "../../../../playwright/AppProviders"
import { expectContrast } from "../../../../playwright/contrast"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"
import { WelcomeLanding } from "../WelcomeLanding"

for (const theme of visualThemes) {
	test(`renders the full welcome screen in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		await applyVisualTheme(page, theme)
		const component = await mount(
			<AppProviders initialState={{ apiConfiguration: {} }}>
				<div className="h-[640px] w-[480px] bg-vscode-editor-background">
					<WelcomeLanding onGetStarted={() => undefined} onImportSettings={() => undefined} />
				</div>
			</AppProviders>,
		)

		const screen = component.locator(".bg-vscode-editor-background").first()
		const heading = component.getByRole("heading", { level: 2 })
		await expect(heading).toBeVisible()
		await expectContrast(heading, { background: screen, label: `${theme.name} welcome heading` })
		await expectContrast(component.getByRole("button", { name: /provider/i }).first(), {
			background: component.getByRole("button", { name: /provider/i }).first(),
			label: `${theme.name} welcome action`,
		})

		await expect(component).toHaveScreenshot(`welcome-screen-${theme.name}.png`)
	})
}
