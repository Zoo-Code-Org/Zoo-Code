import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"
import RooHero from "../RooHero"

test("renders the welcome hero in the VS Code dark theme", async ({ mount }) => {
	const component = await mount(<RooHero />)

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(component).toHaveScreenshot("zoo-hero-dark.png")
})
