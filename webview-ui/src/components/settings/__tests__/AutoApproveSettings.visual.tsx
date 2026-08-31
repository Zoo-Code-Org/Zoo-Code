import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"
import {
	AutoApproveSettingsManualSnapshot1Fixture,
	AutoApproveSettingsManualSnapshot2Fixture,
	AutoApproveSettingsManualSnapshot3Fixture,
} from "./AutoApproveSettings.visual.fixture"

test("matches provided manual snapshot (1)", async ({ mount, page }) => {
	await mount(<AutoApproveSettingsManualSnapshot1Fixture />)

	await page.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})
	await expect(page.getByTestId("auto-approve-settings-visual")).toHaveScreenshot("screenshot-1-.png")
})

test("matches provided manual snapshot (2)", async ({ mount, page }) => {
	await mount(<AutoApproveSettingsManualSnapshot2Fixture />)

	await page.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(page.getByTestId("auto-approve-settings-visual")).toHaveScreenshot("screenshot-2-.png")
})

test("matches provided manual snapshot (3)", async ({ mount, page }) => {
	await mount(<AutoApproveSettingsManualSnapshot3Fixture />)

	await page.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(page.getByTestId("auto-approve-settings-visual")).toHaveScreenshot("screenshot-3-.png")
})
