import React from "react"
import { expect, test } from "@playwright/experimental-ct-react"

import { ProgressIndicator } from "../ProgressIndicator"

test("renders a toolkit progress indicator in the VS Code dark theme", async ({ mount }) => {
	const component = await mount(<ProgressIndicator />)
	const progressRing = component.locator("vscode-progress-ring")

	await progressRing.evaluate(async (element) => {
		await customElements.whenDefined("vscode-progress-ring")
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

		if (!element.shadowRoot) {
			throw new Error("VSCodeProgressRing did not create its shadow root")
		}
	})

	await expect(component).toHaveScreenshot("progress-indicator-dark.png")
})
