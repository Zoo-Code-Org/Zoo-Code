import React from "react"

import { expect, test } from "../../../../../playwright/coverage-fixture"
import { OpenAICompatibleAzureFixture } from "./OpenAICompatible.visual.fixture"

test("renders Azure OpenAI endpoint and deployment guidance in the VS Code dark theme", async ({ mount, page }) => {
	// The full provider bundle leaves a bare Zod reference after CT tree-shaking.
	await page.evaluate(() => Object.assign(globalThis, { z: undefined }))
	const component = await mount(<OpenAICompatibleAzureFixture />)

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(component).toHaveScreenshot("openai-compatible-azure-guidance-dark.png")
})
