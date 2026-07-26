import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"
import RooHero from "../RooHero"

async function waitForAssetsAndRender(component: any) {
	await component.evaluate(async () => {
		await document.fonts.ready
		const images = Array.from(document.querySelectorAll("img"))
		await Promise.all(
			images.map((img) => {
				if (img.complete) return Promise.resolve()
				return new Promise((resolve) => {
					img.onload = resolve
					img.onerror = resolve
				})
			}),
		)
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})
}

test("renders the welcome hero in the VS Code dark theme", async ({ mount }) => {
	const component = await mount(<RooHero />)

	await waitForAssetsAndRender(component)

	await expect(component).toHaveScreenshot("zoo-hero-dark.png")
})
