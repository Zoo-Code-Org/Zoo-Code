import { expect, test } from "../../../../playwright/coverage-fixture"
import { expectContrast } from "../../../../playwright/contrast"
import { expectBoundedLayout } from "../../../../playwright/layout-contracts"
import { mountedStory } from "../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

for (const theme of visualThemes) {
	test(`renders empty history in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		const component = mountedStory(await mount("history-empty"))
		await applyVisualTheme(page, theme)

		const screen = component.locator(".bg-vscode-editor-background").first()
		const heading = component.getByRole("heading", { name: /history/i })
		await expect(heading).toBeVisible()
		await expectContrast(heading, { background: screen, label: `${theme.name} history heading` })

		await expect(component).toHaveScreenshot(`history-empty-${theme.name}.png`)
		const selectionButton = component.getByTestId("toggle-selection-mode-button")
		await expectBoundedLayout(page, component, {
			actionRows: [selectionButton.locator("xpath=../..")],
			focusedControl: selectionButton,
		})
	})
}
