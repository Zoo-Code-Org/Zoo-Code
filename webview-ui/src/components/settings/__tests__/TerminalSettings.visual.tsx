import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"
import { TerminalSettingsFixture } from "./TerminalSettings.visual.fixture"

async function waitForRender(component: any) {
	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})
}

test("renders inline shell selector with default auto selection", async ({ mount }) => {
	const component = await mount(<TerminalSettingsFixture />)

	// Wait for the shell-options message to populate the dropdown + summary.
	await expect(component.getByTestId("terminal-inline-shell-effective")).toBeVisible()
	await expect(component.getByTestId("terminal-inline-shell-dropdown")).toBeVisible()

	await waitForRender(component)

	await expect(component).toHaveScreenshot("terminal-settings-shell-default-dark.png")
})

test("renders effective shell info when a profile is selected", async ({ mount }) => {
	const component = await mount(
		<TerminalSettingsFixture terminalShellSelection={{ kind: "profile", profileName: "PowerShell" }} />,
	)

	await expect(component.getByTestId("terminal-inline-shell-effective")).toBeVisible()

	await waitForRender(component)

	await expect(component).toHaveScreenshot("terminal-settings-shell-profile-selected-dark.png")
})

test("shell dropdown lists shell options when opened", async ({ mount, page }) => {
	const component = await mount(<TerminalSettingsFixture />)

	await expect(component.getByTestId("terminal-inline-shell-effective")).toBeVisible()

	// Open the Radix dropdown rendered by the inline-shell Select.
	await component.getByTestId("terminal-inline-shell-dropdown").click()
	await expect(page.getByTestId("terminal-inline-shell-option-profile:PowerShell")).toBeVisible()

	await waitForRender(component)

	// Screenshot the whole page so the portaled dropdown content is captured.
	await expect(page).toHaveScreenshot("terminal-settings-shell-dropdown-open-dark.png")
})
