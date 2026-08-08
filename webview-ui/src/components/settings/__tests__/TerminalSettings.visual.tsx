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

	await expect(component).toHaveScreenshot("terminal-settings-shell-default-dark.png", { maxDiffPixelRatio: 0.05 })
})

test("renders effective shell info when a profile is selected", async ({ mount }) => {
	const component = await mount(
		<TerminalSettingsFixture terminalShellSelection={{ kind: "profile", profileName: "PowerShell" }} />,
	)

	await expect(component.getByTestId("terminal-inline-shell-effective")).toBeVisible()

	await waitForRender(component)

	await expect(component).toHaveScreenshot("terminal-settings-shell-profile-selected-dark.png", { maxDiffPixelRatio: 0.05 })
})
