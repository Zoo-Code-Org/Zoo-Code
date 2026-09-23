import { expect, test } from "../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../playwright/mounted-story"

test("renders the collapsed panel in the VS Code dark theme", async ({ mount }) => {
	const component = mountedStory(await mount("custom-model-info-collapsed"))

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(component).toHaveScreenshot("custom-model-info-collapsed-dark.png")
})

test("renders the expanded panel with overrides in the VS Code dark theme", async ({ mount }) => {
	const component = mountedStory(await mount("custom-model-info-expanded-overrides"))

	await component.getByText("Custom model metadata").click()

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(component).toHaveScreenshot("custom-model-info-expanded-overrides-dark.png")
})

test("renders the maxTokens exceeds contextWindow warning in the VS Code dark theme", async ({ mount }) => {
	const component = mountedStory(await mount("custom-model-info-warning"))

	await component.getByText("Custom model metadata").click()

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(component).toHaveScreenshot("custom-model-info-warning-dark.png")
})

test("renders the unresolved model state in the VS Code dark theme", async ({ mount }) => {
	// When selectedModelInfo is undefined the panel auto-opens.
	const component = mountedStory(await mount("custom-model-info-unresolved"))

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(component).toHaveScreenshot("custom-model-info-unresolved-dark.png")
})
