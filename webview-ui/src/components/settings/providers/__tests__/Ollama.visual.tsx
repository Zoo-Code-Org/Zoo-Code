import { expect, test } from "../../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../../playwright/mounted-story"

test("renders the API key help text in the VS Code dark theme", async ({ mount, page }) => {
	// The full provider bundle leaves bare Zod references after gallery tree-shaking.
	await page.evaluate(() => Object.assign(globalThis, { z: undefined, z$1: undefined }))
	const component = mountedStory(await mount("ollama-api-key-help"))

	await component.evaluate((element) => {
		const { document } = element.ownerDocument.defaultView!
		document.documentElement.className = "vscode-dark"
		document.body.className = "vscode-dark"
		document.body.dataset.vscodeThemeId = "Default Dark Modern"
	})

	await expect
		.poll(() =>
			component.evaluate((element) => {
				return getComputedStyle(element.ownerDocument.body)
					.getPropertyValue("--vscode-editor-background")
					.trim()
			}),
		)
		.toBe("#1f1f1f")

	// The real toolkit text field draws the label above the input once upgraded.
	await page.evaluate(() => customElements.whenDefined("vscode-text-field"))

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(component).toHaveScreenshot("ollama-api-key-help-guidance-dark.png")
})
