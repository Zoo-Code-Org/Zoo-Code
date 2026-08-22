import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"
import { AppProviders } from "../../../../playwright/AppProviders"
import { expectContrast } from "../../../../playwright/contrast"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"
import { RenderedContentContrastFixture } from "./RenderedContentContrast.visual.fixture"

for (const theme of visualThemes) {
	test(`audits rendered content in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		await applyVisualTheme(page, theme)
		const component = await mount(
			<AppProviders>
				<RenderedContentContrastFixture />
			</AppProviders>,
		)

		const code = component.getByTestId("code-block").locator("code")
		await expect(code).toContainText("Hello, Zoo Code", { timeout: 20_000 })
		const codeBackground = component.getByTestId("code-block").locator("pre")
		const syntaxTokens = code.locator("span[style]")
		for (let index = 0; index < (await syntaxTokens.count()); index++) {
			await expectContrast(syntaxTokens.nth(index), {
				background: codeBackground,
				label: `${theme.name} syntax token ${index + 1}`,
			})
		}
		const codeBlockContainer = component.getByTestId("code-block").locator(":scope > div")
		await codeBlockContainer.scrollIntoViewIfNeeded()
		await page.evaluate(() => window.dispatchEvent(new Event("resize")))
		await expect(codeBlockContainer).toHaveAttribute("data-partially-visible", "true")
		await codeBlockContainer.hover()
		const copyButton = component.getByRole("button", { name: /copy code/i })
		const collapseButton = component.getByRole("button", { name: /expand code block/i })
		await expect(copyButton).toBeVisible()
		await expect(collapseButton).toBeVisible()
		await expect(copyButton.locator("xpath=..")).toHaveCSS("opacity", "1")
		await expectContrast(copyButton, { minimum: 3, label: `${theme.name} copy code control` })
		await expectContrast(collapseButton, { minimum: 3, label: `${theme.name} expand code control` })

		const inserted = component.getByTestId("diff-view").locator(".diff-content-inserted").first()
		const removed = component.getByTestId("diff-view").locator(".diff-content-removed").first()
		await expectContrast(inserted, { background: inserted, label: `${theme.name} inserted diff text` })
		await expectContrast(removed, { background: removed, label: `${theme.name} removed diff text` })

		const terminal = component.getByTestId("terminal-output").locator("pre")
		await expectContrast(terminal, { background: terminal, label: `${theme.name} terminal text` })

		await expect(component).toHaveScreenshot(`rendered-content-${theme.name}.png`)
	})
}
