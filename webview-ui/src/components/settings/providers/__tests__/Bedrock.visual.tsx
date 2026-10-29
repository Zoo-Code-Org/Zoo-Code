import { expect, test } from "../../../../../playwright/coverage-fixture"
import { getCapturedVscodeMessages } from "../../../../../playwright/vscode-messages"
import { BedrockModelsMessageType } from "@roo-code/types"

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

test("shows the inference profile caveat for discovered foundation models", async ({ page }) => {
	await page.setViewportSize({ width: 520, height: 900 })
	await page.goto("/")
	await page.waitForFunction(() => typeof window.mount === "function")
	await page.evaluate(() => window.mount({ story: "bedrock-routing" }))
	await page.getByRole("button", { name: "Refresh regional AWS catalogue" }).click()
	const request = (await getCapturedVscodeMessages(page)).find(
		(message) => message.type === BedrockModelsMessageType.requestBedrockModels,
	)
	await page.evaluate((data) => window.dispatchEvent(new MessageEvent("message", { data })), {
		type: BedrockModelsMessageType.bedrockModels,
		requestId: request?.requestId,
		bedrockModels: [{ arn: "foundation", name: "Example model", kind: "regional" }],
	})
	await page.locator("#bedrock-catalog").click()
	await expect(page.getByRole("listbox")).toHaveScreenshot("bedrock-catalog-regional.png")
})
