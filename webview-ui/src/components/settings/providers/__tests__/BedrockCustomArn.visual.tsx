import type { Page } from "@playwright/test"

import { expect, test } from "../../../../../playwright/coverage-fixture"
import { applyVisualTheme, visualThemes } from "../../../../../playwright/themes"

const mountCustomArn = async (page: Page, props: { baseModelId?: string } = {}) => {
	await page.goto("/")
	await page.waitForFunction(() => typeof window.mount === "function")
	await page.evaluate((storyProps) => window.mount({ story: "bedrock-custom-arn", props: storyProps }), props)
	const component = page.locator("[data-playwright-mounted]")
	await expect(component.getByTestId("custom-arn-base-model")).toBeVisible()
	return component
}

const settleRendering = (page: Page) =>
	page.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

for (const theme of visualThemes.filter(({ name }) => name === "dark" || name === "light")) {
	test(`renders the custom ARN underlying model with Other limits in the VS Code ${theme.name} theme`, async ({
		page,
	}) => {
		const component = await mountCustomArn(page)
		await applyVisualTheme(page, theme)

		await expect(component.getByTestId("custom-arn-context-window")).toBeVisible()
		await settleRendering(page)

		await expect(component).toHaveScreenshot(`bedrock-custom-arn-other-${theme.name}.png`)
	})
}

test("renders a custom ARN with a listed underlying model and no manual limits", async ({ page }) => {
	const component = await mountCustomArn(page, { baseModelId: "anthropic.claude-opus-5-5" })
	await applyVisualTheme(page, visualThemes[0])

	await expect(component.getByTestId("custom-arn-context-window")).toHaveCount(0)
	await settleRendering(page)

	await expect(component).toHaveScreenshot("bedrock-custom-arn-opus-5-5-dark.png")
})
