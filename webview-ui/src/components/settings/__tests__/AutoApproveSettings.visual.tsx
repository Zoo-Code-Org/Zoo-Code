import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"
import {
	AutoApproveSettingsManualSnapshot1Fixture,
	AutoApproveSettingsManualSnapshot2Fixture,
	AutoApproveSettingsManualSnapshot3Fixture,
} from "./AutoApproveSettings.manualSnapshots.fixture"

test("matches provided manual snapshot (1)", async ({ mount }) => {
	const component = await mount(<AutoApproveSettingsManualSnapshot1Fixture />)

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(component).toHaveScreenshot("screenshot-1-.png")
})

test("matches provided manual snapshot (2)", async ({ mount }) => {
	const component = await mount(<AutoApproveSettingsManualSnapshot2Fixture />)

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(component).toHaveScreenshot("screenshot-2-.png")
})

test("matches provided manual snapshot (3)", async ({ mount }) => {
	const component = await mount(<AutoApproveSettingsManualSnapshot3Fixture />)

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(component).toHaveScreenshot("screenshot-3-.png")
})
