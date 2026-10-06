import { expect, test } from "../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../playwright/mounted-story"

test("renders the telemetry consent banner in the VS Code dark theme", async ({ mount }) => {
	const component = mountedStory(await mount("telemetry-banner"))

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(component).toHaveScreenshot("telemetry-banner-dark.png")
})
