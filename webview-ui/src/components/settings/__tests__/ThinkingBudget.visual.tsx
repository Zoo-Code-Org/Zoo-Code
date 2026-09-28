import { expect, test } from "../../../../playwright/coverage-fixture"

test("renders the Bedrock binary-reasoning output budget control", async ({ page }) => {
	await page.goto("/")
	await page.waitForFunction(() => typeof window.mount === "function")
	await page.evaluate(() => window.mount({ story: "bedrock-output-budget" }))
	await expect(page.locator("[data-playwright-mounted]")).toHaveScreenshot("bedrock-output-budget.png")
})
