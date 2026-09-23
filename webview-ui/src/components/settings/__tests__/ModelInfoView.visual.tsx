import { expect, test } from "../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../playwright/mounted-story"

test("renders OpenAI service tier pricing in the VS Code dark theme", async ({ mount }) => {
	const component = mountedStory(await mount("model-info"))

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(component).toHaveScreenshot("model-info-service-tier-pricing-dark.png")
})
