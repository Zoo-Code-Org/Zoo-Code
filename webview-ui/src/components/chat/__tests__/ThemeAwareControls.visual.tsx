import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"
import UpdateTodoListToolBlock from "../UpdateTodoListToolBlock"
import { SelectDropdown } from "@/components/ui/select-dropdown"

const themes = [
	{
		name: "dark",
		bodyClass: "vscode-dark",
		themeId: "Default Dark Modern",
		expected: {
			background: "rgb(30, 30, 30)",
			description: "rgb(157, 157, 157)",
			dropdownBorder: "rgb(60, 60, 60)",
			hoverBackground: "rgb(42, 45, 46)",
			focusBorder: "rgb(0, 127, 212)",
			error: "rgb(244, 135, 113)",
			panelBorder: "rgb(43, 43, 43)",
		},
	},
	{
		name: "light",
		bodyClass: "vscode-light",
		themeId: "Default Light Modern",
		expected: {
			background: "rgb(255, 255, 255)",
			description: "rgb(113, 113, 113)",
			dropdownBorder: "rgb(206, 206, 206)",
			hoverBackground: "rgb(232, 232, 232)",
			focusBorder: "rgb(0, 144, 241)",
			error: "rgb(161, 38, 13)",
			panelBorder: "rgb(206, 206, 206)",
		},
	},
] as const

for (const theme of themes) {
	test(`renders selectors and confirmation dialogs in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		await page.evaluate(({ bodyClass, themeId }) => {
			document.documentElement.className = bodyClass
			document.body.className = bodyClass
			document.body.dataset.vscodeThemeId = themeId
		}, theme)

		const component = await mount(
			<div className="flex flex-col gap-4 w-96">
				<SelectDropdown value="code" options={[{ value: "code", label: "Code" }]} onChange={() => undefined} />
				<UpdateTodoListToolBlock
					todos={[{ id: "todo-1", content: "Ship the follow-up", status: "in_progress" }]}
					onChange={() => undefined}
				/>
			</div>,
		)

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
