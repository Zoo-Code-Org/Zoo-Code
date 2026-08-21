import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"
import { ModelInfoViewFixture } from "./ModelInfoView.visual.fixture"

test("renders OpenAI service tier pricing in the VS Code dark theme", async ({ mount }) => {
	const component = await mount(<ModelInfoViewFixture />)

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(component).toHaveScreenshot("model-info-service-tier-pricing-dark.png")
})
