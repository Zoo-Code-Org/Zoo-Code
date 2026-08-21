import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"
import { Checkbox } from "@/components/ui/checkbox"
import { enabledChatControlClassName } from "../chatControlStyles"

const themes = [
	{
		name: "dark",
		bodyClass: "vscode-dark",
		themeId: "Default Dark Modern",
		expected: {
			hover: "rgb(42, 45, 46)",
			active: "rgb(42, 45, 46)",
			description: "rgb(157, 157, 157)",
			background: "rgb(30, 30, 30)",
		},
	},
	{
		name: "light",
		bodyClass: "vscode-light",
		themeId: "Default Light Modern",
		expected: {
			hover: "rgb(232, 232, 232)",
			active: "rgb(232, 232, 232)",
			description: "rgb(113, 113, 113)",
			background: "rgb(255, 255, 255)",
		},
	},
] as const

for (const theme of themes) {
	test(`renders remaining controls in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		await page.evaluate(({ bodyClass, themeId }) => {
			document.documentElement.className = bodyClass
			document.body.className = bodyClass
			document.body.dataset.vscodeThemeId = themeId
		}, theme)

		const component = await mount(
			<div className="flex flex-col gap-3 w-96">
				<button aria-label="Settings" className={enabledChatControlClassName}>
					Settings
				</button>
				<Checkbox aria-label="Include optional context" variant="description" checked />
			</div>,
		)

		await component.evaluate(async () => {
			await document.fonts.ready
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
		})

		await expect(component).toHaveScreenshot(`remaining-controls-resting-${theme.name}.png`)

		const iconButton = component.getByRole("button", { name: "Settings" })
		await iconButton.hover()
		await expect(iconButton).toHaveCSS("background-color", theme.expected.hover)
		await iconButton.focus()
		await page.mouse.down()
		await expect(iconButton).toHaveCSS("background-color", theme.expected.active)
		await page.mouse.up()

		await expect(component).toHaveScreenshot(`remaining-controls-active-${theme.name}.png`)

		const checkbox = component.getByRole("checkbox", { name: "Include optional context" })
		await expect(checkbox).toHaveCSS("background-color", theme.expected.description)
		await expect(checkbox).toHaveCSS("color", theme.expected.background)
	})
}
