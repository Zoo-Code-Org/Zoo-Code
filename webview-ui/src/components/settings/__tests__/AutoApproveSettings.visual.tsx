import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"
import { AutoApproveSettingsFixture } from "./AutoApproveSettings.visual.fixture"

test("renders follow-up timeout row with disabled state label in the VS Code dark theme", async ({ mount, page }) => {
	// The full settings bundle can leave a bare Zod reference after CT tree-shaking.
	await page.evaluate(() => Object.assign(globalThis, { z: undefined }))

	const component = await mount(<AutoApproveSettingsFixture />)

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(component).toHaveScreenshot("auto-approve-followup-timeout-disabled-dark.png")
})
