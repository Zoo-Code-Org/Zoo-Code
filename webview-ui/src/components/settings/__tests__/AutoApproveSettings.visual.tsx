import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"
import screenshot1 from "./__screenshots__/screenshot (1).png"
import screenshot2 from "./__screenshots__/screenshot (2).png"
import screenshot3 from "./__screenshots__/screenshot (3).png"
import {
	AutoApproveSettingsManualSnapshot1Fixture,
	AutoApproveSettingsManualSnapshot2Fixture,
	AutoApproveSettingsManualSnapshot3Fixture,
} from "./AutoApproveSettings.visual.fixture"

const manualReferencePngs = [screenshot1, screenshot2, screenshot3]

test("matches provided manual snapshot (1)", async ({ mount }) => {
	expect(manualReferencePngs[0]).toBeTruthy()

	const component = await mount(<AutoApproveSettingsManualSnapshot1Fixture />)

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(component).toHaveScreenshot("screenshot-1-.png")
})

test("matches provided manual snapshot (2)", async ({ mount }) => {
	expect(manualReferencePngs[1]).toBeTruthy()

	const component = await mount(<AutoApproveSettingsManualSnapshot2Fixture />)

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(component).toHaveScreenshot("screenshot-2-.png")
})

test("matches provided manual snapshot (3)", async ({ mount }) => {
	expect(manualReferencePngs[2]).toBeTruthy()

	const component = await mount(<AutoApproveSettingsManualSnapshot3Fixture />)

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(component).toHaveScreenshot("screenshot-3-.png")
})
