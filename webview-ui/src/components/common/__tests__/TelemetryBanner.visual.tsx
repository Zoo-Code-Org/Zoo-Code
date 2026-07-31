import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"
import { TelemetryBannerFixture } from "./TelemetryBanner.visual.fixture"
import { visualTestI18nReady } from "./TelemetryBanner.visual.i18n"

test("renders the telemetry consent banner in the VS Code dark theme", async ({ mount }) => {
	await visualTestI18nReady

	const component = await mount(<TelemetryBannerFixture />)

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(component).toHaveScreenshot("telemetry-banner-dark.png")
})
