import type { Locator } from "@playwright/test"
import { providerIdentifiers } from "@roo-code/types"

import { expect, test } from "../../../../playwright/coverage-fixture"
import {
	collectBoundedLayoutFailures,
	expectBoundedLayout,
	REFLOW_VIEWPORT_WIDTH,
	WCAG_TEXT_SPACING,
} from "../../../../playwright/layout-contracts"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"
import { getCapturedVscodeMessages } from "../../../../playwright/vscode-messages"

const themes = visualThemes.filter(({ name }) => name === "dark" || name === "light")

test.beforeEach(async ({ page }) => {
	// A cold Vite dependency optimization can outlive the initial page load event.
	await page.goto("/")
	await page.waitForFunction(() => typeof window.mount === "function")
})

async function geometry(dialog: Locator, search: Locator) {
	const picker = await dialog.boundingBox()
	const input = await search.boundingBox()
	// Both production views use the same fixed-height results viewport.
	const results = await dialog.locator(".h-\\[300px\\]:visible").boundingBox()
	expect(picker).not.toBeNull()
	expect(input).not.toBeNull()
	expect(results).not.toBeNull()
	return {
		pickerY: picker!.y,
		pickerHeight: picker!.height,
		searchY: input!.y,
		searchHeight: input!.height,
		resultsY: results!.y,
		resultsHeight: results!.height,
	}
}

for (const theme of themes) {
	test(`unified picker model and profile views in ${theme.name}`, async ({ mount, page }) => {
		await page.setViewportSize({ width: 360, height: 640 })
		await mount("unified-model-picker")
		await applyVisualTheme(page, theme)
		await page.getByTestId("dropdown-trigger").click()
		const dialog = page.getByRole("dialog")
		const models = dialog.getByRole("group", { name: "Models from the current provider" })
		await models.getByRole("button", { name: "gpt-5", exact: true }).scrollIntoViewIfNeeded()
		await expect(dialog.getByRole("group", { name: "Reasoning effort" })).toBeVisible()
		await page.mouse.move(350, 10)
		await expect(page).toHaveScreenshot(`unified-model-picker-models-${theme.name}.png`)

		await dialog.getByRole("button", { name: "Choose profile", exact: true }).click()
		await expect(dialog.locator("[data-picker-result]")).toHaveCount(3)
		await page.mouse.move(350, 10)
		await expect(page).toHaveScreenshot(`unified-model-picker-profiles-${theme.name}.png`)
	})
}

for (const view of ["models", "profiles"] as const) {
	for (const width of [360, REFLOW_VIEWPORT_WIDTH]) {
		test(`${view} search keeps its upward-anchored geometry at ${width}px`, async ({ mount, page }) => {
			await page.setViewportSize({ width, height: 640 })
			await mount("unified-model-picker")
			await page.getByTestId("dropdown-trigger").click()
			const dialog = page.getByRole("dialog")
			if (view === "profiles") {
				await dialog.getByRole("button", { name: "Choose profile", exact: true }).click()
			}
			const search = dialog.getByRole("textbox")
			const results = dialog.locator("[data-picker-result]:visible")
			await expect(results.first()).toBeVisible()
			await expect.poll(async () => (await geometry(dialog, search)).resultsHeight).toBe(300)
			const initial = await geometry(dialog, search)
			expect(initial.resultsHeight).toBe(300)

			await search.fill(view === "models" ? "gpt-5.1-codex-max" : "Personal")
			await expect(results).toHaveCount(1)
			await expect.poll(() => geometry(dialog, search)).toEqual(initial)
			await expect.poll(() => dialog.evaluate(collectBoundedLayoutFailures)).toEqual([])

			await search.fill("no-such-picker-result-2479")
			await expect(results).toHaveCount(view === "models" ? 1 : 0)
			if (view === "models") {
				await expect(
					dialog.getByRole("button", { name: "Use custom: no-such-picker-result-2479" }),
				).toBeVisible()
				await expect(dialog.getByRole("button", { name: "Model Settings", exact: true })).toHaveCount(0)
			} else {
				await expect(dialog.getByText("No results found", { exact: true })).toBeVisible()
			}
			await expect.poll(() => geometry(dialog, search)).toEqual(initial)
			await expect.poll(() => dialog.evaluate(collectBoundedLayoutFailures)).toEqual([])

			if (width === REFLOW_VIEWPORT_WIDTH) {
				// The picker is portaled beside #root, outside the shared helper's CSS scope.
				await page.addStyleTag({
					content: `#roo-portal, #roo-portal * {
						line-height: ${WCAG_TEXT_SPACING.lineHeight} !important;
						letter-spacing: ${WCAG_TEXT_SPACING.letterSpacing} !important;
						word-spacing: ${WCAG_TEXT_SPACING.wordSpacing} !important;
					}`,
				})
				await expectBoundedLayout(page, dialog, { focusedControl: search })
				const spaced = await geometry(dialog, search)
				await search.fill(view === "models" ? "gpt-5.1-codex-max" : "Personal")
				await expect(results).toHaveCount(1)
				await expect.poll(() => geometry(dialog, search)).toEqual(spaced)
				await expectBoundedLayout(page, dialog, {
					focusedControl: results.first(),
					actionRows: view === "models" ? [dialog.getByRole("group", { name: "Reasoning effort" })] : [],
				})
			}
		})
	}
}

test("model and effort clicks retain the open picker layout", async ({ mount, page }) => {
	await page.setViewportSize({ width: 360, height: 640 })
	await mount("unified-model-picker")
	await page.getByTestId("dropdown-trigger").click()
	const dialog = page.getByRole("dialog")
	const search = dialog.getByRole("textbox", { name: "Search models" })
	await search.fill("gpt-5.1-codex-max")
	await expect.poll(async () => (await geometry(dialog, search)).resultsHeight).toBe(300)
	const initial = await geometry(dialog, search)
	await dialog
		.getByRole("group", { name: "Reasoning effort" })
		.getByRole("button", { name: "Low", exact: true })
		.click()
	await expect(dialog).toBeVisible()
	await expect.poll(() => geometry(dialog, search)).toEqual(initial)
	await dialog.getByRole("button", { name: "gpt-5.1-codex-max", exact: true }).click()
	await expect(dialog).toBeVisible()
	await expect.poll(() => geometry(dialog, search)).toEqual(initial)
	await expect(
		dialog.getByRole("group", { name: "Reasoning effort" }).getByRole("button", { name: "Low", exact: true }),
	).toBeDisabled()

	// Use the shared bridge capture, not console output, to ensure the real controls ran.
	const messages = await getCapturedVscodeMessages(page)
	expect(messages.filter(({ type }) => type === "updateProfileModel")).toHaveLength(2)
})

test("custom model keyboard acceptance clears search without closing the picker", async ({ mount, page }) => {
	await mount("unified-model-picker")
	await page.getByTestId("dropdown-trigger").click()
	const dialog = page.getByRole("dialog")
	const search = dialog.getByRole("textbox", { name: "Search models" })
	await search.fill("  deployment-new  ")
	await search.press("ArrowDown")
	await expect(dialog.getByRole("button", { name: "Use custom: deployment-new" })).toBeFocused()
	await page.keyboard.press("Enter")
	await expect(dialog).toBeVisible()
	await expect(search).toHaveValue("")
	const messages = (await getCapturedVscodeMessages(page)).filter(({ type }) => type === "updateProfileModel")
	expect(messages).toEqual([
		expect.objectContaining({
			values: expect.objectContaining({ patch: expect.objectContaining({ apiModelId: "deployment-new" }) }),
		}),
	])
})

test("switching profiles updates the mounted context before model submission", async ({ mount, page }) => {
	await mount("unified-model-picker")
	await page.getByTestId("dropdown-trigger").click()
	const dialog = page.getByRole("dialog")
	await dialog.getByRole("button", { name: "Choose profile", exact: true }).click()
	await dialog.getByRole("button", { name: "Personal gpt-5-mini", exact: true }).click()
	await expect(dialog).toBeVisible()
	await expect(page.getByTestId("dropdown-trigger")).toContainText("Personal / gpt-5-mini")
	const models = dialog.getByRole("group", { name: "Models from the current provider" })
	await expect(models.getByRole("button", { name: "gpt-5-mini", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	)
	await expect(models.getByRole("button", { name: "gpt-5", exact: true })).toHaveAttribute("aria-pressed", "false")
	await dialog.getByRole("textbox", { name: "Search models" }).fill("gpt-5.1-codex-max")
	await models.getByRole("button", { name: "gpt-5.1-codex-max", exact: true }).click()
	const messages = (await getCapturedVscodeMessages(page)).filter(({ type }) => type === "updateProfileModel")
	expect(messages).toEqual([
		expect.objectContaining({
			text: "Personal",
			values: expect.objectContaining({
				expectedProvider: providerIdentifiers.openaiNative,
				patch: expect.objectContaining({ apiModelId: "gpt-5.1-codex-max" }),
			}),
		}),
	])
})
