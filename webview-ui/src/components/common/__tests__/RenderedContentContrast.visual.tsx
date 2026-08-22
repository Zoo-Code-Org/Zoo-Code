import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"
import { expectContrast } from "../../../../playwright/contrast"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"
import { RenderedContentContrastFixture } from "./RenderedContentContrast.visual.fixture"

for (const theme of visualThemes) {
	test(`audits rendered content in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		await applyVisualTheme(page, theme)
		const component = await mount(<RenderedContentContrastFixture />)

		const code = component.getByTestId("code-block").locator("code")
		await expect(code).toContainText("Hello, Zoo Code")
		await expectContrast(code, {
			background: component.getByTestId("code-block").locator("pre"),
			label: `${theme.name} code text`,
		})

		const inserted = component.getByTestId("diff-view").locator(".diff-content-inserted").first()
		const removed = component.getByTestId("diff-view").locator(".diff-content-removed").first()
		await expectContrast(inserted, { background: inserted, label: `${theme.name} inserted diff text` })
		await expectContrast(removed, { background: removed, label: `${theme.name} removed diff text` })

		const terminal = component.getByTestId("terminal-output").locator("pre")
		await expectContrast(terminal, { background: terminal, label: `${theme.name} terminal text` })

		await expect(component).toHaveScreenshot(`rendered-content-${theme.name}.png`)
	})
}
