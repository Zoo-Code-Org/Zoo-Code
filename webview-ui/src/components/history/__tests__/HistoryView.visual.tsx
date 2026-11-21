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

	test(`renders task rename states in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		// Matches the "history-rename" story's reference time so "time ago" labels stay stable.
		await page.clock.setFixedTime(new Date("2026-06-01T12:00:00Z"))
		const component = mountedStory(await mount("history-rename"))
		await applyVisualTheme(page, theme)

		// A renamed task shows its custom title. Hovering a row reveals the rename action.
		const renamedTask = component.getByTestId("task-item-task-renamed")
		await expect(renamedTask.getByText("Auth refactor")).toBeVisible()
		const originalTask = component.getByTestId("task-item-task-original")
		await originalTask.getByText("Write unit tests for the billing service").hover()
		const renameButton = originalTask.getByTestId("rename-task-button")
		await expect(renameButton).toBeVisible()

		// The rename action swaps the title for an inline editor.
		await renameButton.click()
		const input = originalTask.getByTestId("task-title-input")
		await expect(input).toBeFocused()
		await expect(input).toHaveValue("Write unit tests for the billing service")
		await expect(component).toHaveScreenshot(`history-rename-editor-${theme.name}.png`)
		await expectBoundedLayout(page, component, { focusedControl: input })
	})
}
