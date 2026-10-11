import type { Page } from "@playwright/test"

import { expect, test } from "../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../playwright/mounted-story"

const send = (page: Page, data: object) =>
	page.evaluate((message) => window.dispatchEvent(new MessageEvent("message", { data: message })), data)

// The host reports context but says nothing about vision, which the UI must show as unreported.
const model = { id: "gpt-5.5", vendor: "copilot", family: "gpt-5.5", version: "1", name: "GPT-5.5" }
const reportedModel = { ...model, modelInfo: { contextWindow: 268_426, supportsPromptCache: false } }

const mountSettings = async (mount: (name: string) => Promise<import("@playwright/test").Locator>, page: Page) => {
	const component = mountedStory(await mount("github-copilot-settings"))
	// The full provider bundle leaves a bare Zod reference after gallery tree-shaking.
	await page.evaluate(() => Object.assign(globalThis, { z: undefined }))
	return component
}

const settle = (component: import("@playwright/test").Locator) =>
	component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

test("renders a signed-in account with host-reported capabilities in the VS Code dark theme", async ({
	mount,
	page,
}) => {
	const component = await mountSettings(mount, page)
	await send(page, {
		type: "githubCopilotModels",
		githubCopilotAccount: "octocat",
		vsCodeLmModels: [reportedModel],
	})

	await expect(component.getByRole("status")).toContainText("octocat")
	await expect(component.getByText("Image support not reported")).toBeVisible()
	await settle(component)

	await expect(component).toHaveScreenshot("github-copilot-signed-in-dark.png")
})

test("renders the empty state for an account with no Copilot models", async ({ mount, page }) => {
	const component = await mountSettings(mount, page)
	await send(page, { type: "githubCopilotModels", githubCopilotAccount: "octocat", vsCodeLmModels: [] })

	await expect(component.getByText(/Signing in does not confirm a Copilot subscription/)).toBeVisible()
	await settle(component)

	await expect(component).toHaveScreenshot("github-copilot-no-models-dark.png")
})

test("renders a model discovery error", async ({ mount, page }) => {
	const component = await mountSettings(mount, page)
	await send(page, { type: "githubCopilotModels", error: "Model access denied" })

	await expect(component.getByRole("alert")).toContainText("Model access denied")
	await settle(component)

	await expect(component).toHaveScreenshot("github-copilot-error-dark.png")
})
