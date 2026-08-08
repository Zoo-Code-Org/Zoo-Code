import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"
import { OpenAICompatibleStrictModeFixture } from "./OpenAICompatible.visual.fixture"

test("renders strict tool schemas toggle enabled in the VS Code dark theme", async ({ mount }) => {
	const component = await mount(<OpenAICompatibleStrictModeFixture />)

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	// Target the inner strict-mode block via data-testid (Playwright CT
	// cannot locate a testid on the outermost mounted wrapper).
	const strictBlock = component.getByTestId("strict-tool-schemas-block")
	await expect(strictBlock).toBeVisible()
	await expect(strictBlock).toHaveScreenshot("openai-compatible-strict-tool-schemas-dark.png")
})
