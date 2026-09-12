import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"
import {
	CollapsedFixture,
	ExpandedWithOverridesFixture,
	WarningFixture,
	UnresolvedFixture,
} from "./CustomModelInfoSettings.visual.fixture"

test("renders the collapsed panel in the VS Code dark theme", async ({ mount }) => {
	const component = await mount(<CollapsedFixture />)

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(component).toHaveScreenshot("custom-model-info-collapsed-dark.png")
})

test("renders the expanded panel with overrides in the VS Code dark theme", async ({ mount }) => {
	const component = await mount(<ExpandedWithOverridesFixture />)

	const trigger = component.getByText("Custom model metadata")
	await trigger.click()

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(component).toHaveScreenshot("custom-model-info-expanded-overrides-dark.png")
})

test("renders the maxTokens exceeds contextWindow warning in the VS Code dark theme", async ({ mount }) => {
	const component = await mount(<WarningFixture />)

	const trigger = component.getByText("Custom model metadata")
	await trigger.click()

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(component).toHaveScreenshot("custom-model-info-warning-dark.png")
})

test("renders the unresolved model state in the VS Code dark theme", async ({ mount }) => {
	const component = await mount(<UnresolvedFixture />)

	// When selectedModelInfo is undefined the panel auto-opens
	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(component).toHaveScreenshot("custom-model-info-unresolved-dark.png")
})
