import { expect, test } from "../../../../../playwright/coverage-fixture"

for (const global of [false, true]) {
	test(`shows Bedrock routing scope and effective ID (global=${global})`, async ({ page }) => {
		await page.goto("/")
		await page.waitForFunction(() => typeof window.mount === "function")
		await page.evaluate((global) => window.mount({ story: "bedrock-routing", props: { global } }), global)
		await expect(page.locator("[data-playwright-mounted]")).toHaveScreenshot(
			`bedrock-routing-${global ? "global" : "geo"}.png`,
		)
	})
}
