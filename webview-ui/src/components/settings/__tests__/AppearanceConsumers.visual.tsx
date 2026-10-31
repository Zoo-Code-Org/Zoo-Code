import type { Locator } from "@playwright/test"

import { expect, test } from "../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

const px = (locator: Locator, property: string) =>
	locator.evaluate((element, name) => Number.parseFloat(getComputedStyle(element).getPropertyValue(name)), property)

// Real layout, so the computed values are the ones a user would get: the saved values are applied to <html> through
// the app's own function, then removed again, and every consumer must follow both ways.
for (const theme of visualThemes) {
	test(`the appearance values reach every consumer, and removing them restores the defaults (${theme.name})`, async ({
		mount,
		page,
	}) => {
		const component = mountedStory(await mount("appearance-consumers"))
		await applyVisualTheme(page, theme)
		const story = component.getByTestId("appearance-consumers-story")

		const markdownText = story.getByTestId("consumer-markdown").locator("p").first()
		const queued = story.getByTestId("queued-messages")
		// The wrapper that ChatRow puts around every row: its padding is what the spacing setting changes.
		const chatRowWrapper = story.getByTestId("consumer-chat-row").locator(":scope > div").first()
		const terminal = story
			.getByTestId("consumer-terminal")
			.locator("pre, code, div")
			.filter({ hasText: "Tests passed" })
			.last()
		const diffCode = story.getByTestId("consumer-diff").locator(".diff-view").first()
		const code = story.getByTestId("consumer-code").locator("code").first()
		await expect(markdownText).toBeVisible()
		await expect(queued).toBeVisible()
		await expect(chatRowWrapper).toContainText("A chat row with an assistant reply.")
		await expect(diffCode).toBeVisible()
		// The code block highlights asynchronously: wait for it, so the picture is the same on every run.
		await expect(code.locator("span[style]").first()).toBeVisible({ timeout: 20_000 })

		// Unset: the historical look.
		await expect(story.getByTestId("appearance-state")).toHaveText("unset")
		const before = {
			chat: await px(markdownText, "font-size"),
			padX: await px(queued, "padding-left"),
			padY: await px(queued, "padding-top"),
			terminal: await px(terminal, "font-size"),
			diff: await px(diffCode, "font-size"),
			code: await px(code, "font-size"),
		}
		expect(before.padX).toBe(15)
		expect(before.padY).toBe(10)
		expect(await px(chatRowWrapper, "padding-left")).toBe(15)
		expect(await px(chatRowWrapper, "padding-top")).toBe(10)
		expect(before.terminal).not.toBe(20)
		expect(before.diff).not.toBe(22)
		expect(before.code).not.toBe(22)
		await expect(page.locator("html")).not.toHaveClass(/zoo-editor-font-set/)
		await expect(story).toHaveScreenshot(`appearance-consumers-${theme.name}-unset.png`)

		// Set: interface 150%, terminal 20px, editor 22px, spacing 150%.
		await story.getByTestId("apply-appearance").click()
		await expect(story.getByTestId("appearance-state")).toHaveText("set")
		await expect(page.locator("html")).toHaveClass(/zoo-editor-font-set/)
		await expect.poll(() => px(queued, "padding-left")).toBe(22.5) // 15px at 150%
		expect(await px(queued, "padding-top")).toBe(15) // 10px at 150%
		expect(await px(chatRowWrapper, "padding-left")).toBe(22.5)
		expect(await px(chatRowWrapper, "padding-top")).toBe(15)
		expect(await px(markdownText, "font-size")).toBeCloseTo(before.chat * 1.5, 1)
		expect(await px(terminal, "font-size")).toBe(20)
		expect(await px(diffCode, "font-size")).toBe(22)
		expect(await px(code, "font-size")).toBe(22)
		await expect(story).toHaveScreenshot(`appearance-consumers-${theme.name}-set.png`)

		// Removed again: every consumer is back on its default.
		await story.getByTestId("remove-appearance").click()
		await expect(story.getByTestId("appearance-state")).toHaveText("unset")
		await expect(page.locator("html")).not.toHaveClass(/zoo-editor-font-set/)
		await expect.poll(() => px(queued, "padding-left")).toBe(15)
		expect(await px(queued, "padding-top")).toBe(10)
		expect(await px(chatRowWrapper, "padding-left")).toBe(15)
		expect(await px(chatRowWrapper, "padding-top")).toBe(10)
		expect(await px(markdownText, "font-size")).toBeCloseTo(before.chat, 1)
		expect(await px(terminal, "font-size")).toBeCloseTo(before.terminal, 1)
		expect(await px(diffCode, "font-size")).toBeCloseTo(before.diff, 1)
		expect(await px(code, "font-size")).toBeCloseTo(before.code, 1)
		// ...and it looks the way it did before: the same picture as the unset state.
		await expect(story).toHaveScreenshot(`appearance-consumers-${theme.name}-unset.png`)
	})
}
