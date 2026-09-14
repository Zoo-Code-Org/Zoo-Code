import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"
import { AppProviders } from "../../../../playwright/AppProviders"
import { expectContrast } from "../../../../playwright/contrast"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"
import { ThemeSensitiveStatusFixture } from "./ThemeSensitiveStatus.visual.fixture"

for (const theme of visualThemes) {
	test(`audits status controls in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		await applyVisualTheme(page, theme)
		const component = await mount(
			<AppProviders>
				<ThemeSensitiveStatusFixture />
			</AppProviders>,
		)
		const surface = component.getByTestId("status-surface")

		await component.getByRole("button", { name: /auto-approved commands/i }).click()
		const allowButton = component.getByTestId("allow-command-pattern").first()
		const denyButton = component.getByTestId("deny-command-pattern").nth(1)
		await expect(allowButton).toHaveAttribute("aria-pressed", "true")
		await expect(denyButton).toHaveAttribute("aria-pressed", "true")
		await expectContrast(allowButton, {
			background: allowButton,
			minimum: 3,
			label: `${theme.name} allowed command indicator`,
		})
		await expectContrast(denyButton, {
			background: denyButton,
			minimum: 3,
			label: `${theme.name} denied command indicator`,
		})
		await expectContrast(component.getByText("Search files and symbols in the current workspace"), {
			background: surface,
			label: `${theme.name} disabled MCP description`,
		})

		await expect(component).toHaveScreenshot(`theme-sensitive-status-${theme.name}.png`)
	})
}
