import { expect, test } from "../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../playwright/mounted-story"

const themes = [
	{
		name: "dark",
		bodyClass: "vscode-dark",
		themeId: "Default Dark Modern",
		expected: {
			background: "rgb(31, 31, 31)",
			description: "rgb(157, 157, 157)",
			dropdownBorder: "rgb(60, 60, 60)",
			hoverBackground: "rgba(90, 93, 94, 0.31)",
			focusBorder: "rgb(0, 120, 212)",
			error: "color(srgb 0.912157 0.486471 0.466078)",
			panelBorder: "rgb(43, 43, 43)",
		},
	},
	{
		name: "light",
		bodyClass: "vscode-light",
		themeId: "Default Light Modern",
		expected: {
			background: "rgb(255, 255, 255)",
			description: "rgb(59, 59, 59)",
			dropdownBorder: "rgb(206, 206, 206)",
			hoverBackground: "rgba(184, 184, 184, 0.31)",
			focusBorder: "rgb(0, 95, 184)",
			error: "color(srgb 0.713137 0.287451 0.267059)",
			panelBorder: "rgb(229, 229, 229)",
		},
	},
] as const

for (const theme of themes) {
	test(`renders selectors and confirmation dialogs in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		const component = mountedStory(await mount("theme-aware-controls"))
		await page.evaluate(({ bodyClass, themeId }) => {
			document.documentElement.className = bodyClass
			document.body.className = bodyClass
			document.body.dataset.vscodeThemeId = themeId
		}, theme)

		await component.evaluate(async () => {
			await document.fonts.ready
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
		})

		await expect(component).toHaveScreenshot(`chat-controls-resting-${theme.name}.png`)

		const trigger = component.getByTestId("dropdown-trigger")
		await expect(trigger).toHaveCSS("border-color", theme.expected.dropdownBorder)
		await trigger.hover()
		await expect(trigger).toHaveCSS("background-color", theme.expected.hoverBackground)
		await expect(trigger).toHaveCSS("border-color", theme.expected.focusBorder)
		await page.keyboard.press("Tab")
		await expect(trigger).toBeFocused()
		await expect
			.poll(() => trigger.evaluate((element) => getComputedStyle(element).boxShadow))
			.toContain(theme.expected.focusBorder)

		await expect(component).toHaveScreenshot(`chat-controls-focus-${theme.name}.png`)

		await component.getByRole("button", { name: "Edit" }).click()
		await component.getByTitle("Remove").click()
		const dialog = page.getByRole("alertdialog")
		await expect(dialog).toBeVisible()
		await expect(dialog).toHaveCSS("background-color", theme.expected.background)
		await expect(dialog).toHaveCSS("border-color", theme.expected.panelBorder)
		await expect(page.getByText("Are you sure you want to delete this todo item?")).toHaveCSS(
			"color",
			theme.expected.description,
		)
		await expect(page.getByRole("button", { name: "Delete" })).toHaveCSS("color", theme.expected.error)

		await expect(dialog).toHaveScreenshot(`chat-controls-delete-dialog-${theme.name}.png`)
	})
}
