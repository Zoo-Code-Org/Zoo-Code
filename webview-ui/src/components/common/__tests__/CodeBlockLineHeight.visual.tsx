import { expect, test } from "../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../playwright/mounted-story"

// Computed values only: no screenshot, so there is no baseline to keep.
test.describe("the line height of a code block inside a list", () => {
	const lineHeights = (component: ReturnType<typeof mountedStory>) =>
		component.evaluate((root) => {
			const pre = root.querySelector("pre") as HTMLElement
			const item = root.querySelector("li") as HTMLElement
			const lineHeight = (element: HTMLElement) => Number.parseFloat(getComputedStyle(element).lineHeight)
			return {
				code: lineHeight(pre),
				item: lineHeight(item),
				codeFont: Number.parseFloat(getComputedStyle(pre).fontSize),
			}
		})

	test("is the one of the list when no editor size is set", async ({ mount, page }) => {
		const component = mountedStory(await mount("markdown-list-code"))
		await expect(component.locator("pre")).toBeVisible({ timeout: 10_000 })
		await page.evaluate(() => document.documentElement.style.removeProperty("--zoo-editor-font-size"))

		const { code, item } = await lineHeights(component)

		expect(code).toBeCloseTo(item, 5) // inherited, as before
	})

	test("follows the editor size when one is set, so the lines do not overlap", async ({ mount, page }) => {
		const component = mountedStory(await mount("markdown-list-code"))
		await expect(component.locator("pre")).toBeVisible({ timeout: 10_000 })
		await page.evaluate(() => document.documentElement.style.setProperty("--zoo-editor-font-size", "32px"))

		const { code, item, codeFont } = await lineHeights(component)

		expect(codeFont).toBe(32)
		expect(code).toBeCloseTo(32 * 1.35, 5)
		expect(code).toBeGreaterThan(item) // the list's own line height would be smaller than the font
		await page.evaluate(() => document.documentElement.style.removeProperty("--zoo-editor-font-size"))
	})
})
