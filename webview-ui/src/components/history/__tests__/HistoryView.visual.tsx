import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"
import { AppProviders } from "../../../../playwright/AppProviders"
import { expectContrast } from "../../../../playwright/contrast"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"
import HistoryView from "../HistoryView"

for (const theme of visualThemes) {
	test(`renders empty history in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		await applyVisualTheme(page, theme)
		const component = await mount(
			<AppProviders initialState={{ taskHistory: [] }}>
				<div className="h-[640px] w-[480px] bg-vscode-editor-background">
					<HistoryView onDone={() => undefined} />
				</div>
			</AppProviders>,
		)

		const screen = component.locator(".bg-vscode-editor-background").first()
		const heading = component.getByRole("heading", { name: /history/i })
		await expect(heading).toBeVisible()
		await expectContrast(heading, { background: screen, label: `${theme.name} history heading` })

		await expect(component).toHaveScreenshot(`history-empty-${theme.name}.png`)
	})
}
