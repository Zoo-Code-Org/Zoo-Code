import { expect, test } from "../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

// Pixel receipts for the expanded TaskHeader markdown surface (PR #1257):
// markdown formatting, clickable mentions, soft breaks, and the consistent
// .scrollable overflow box. Semantic behavior (toggle guards, openMention
// posts, boundary rules) stays covered by TaskHeader.spec.tsx.
for (const theme of visualThemes) {
	test(`renders the expanded TaskHeader prompt as markdown in the ${theme.name} theme`, async ({ mount, page }) => {
		const component = mountedStory(await mount("task-header-markdown"))
		await applyVisualTheme(page, theme)

		// Establish the expanded state deterministically through the header
		// toggle (lucide chevron-down while collapsed).
		await component.locator("button:has(svg.lucide-chevron-down)").click()

		// The expanded view applies markdown: heading, list, mentions, and
		// soft breaks rendered as <br>.
		await expect(component.getByRole("heading", { name: "Refactor the billing module" })).toBeVisible()
		expect(await component.locator("ul li").count()).toBe(4)
		const mentions = component.locator('span.mention-context-highlight[role="button"]')
		expect(await mentions.count()).toBe(3)
		await expect(mentions.nth(0)).toHaveText("@problems")
		await expect(mentions.nth(1)).toHaveText("@terminal")
		await expect(mentions.nth(2)).toHaveText("@/src/billing/invoice.ts")
		expect(await component.locator("p br").count()).toBeGreaterThan(0)

		// The prompt overflows the max-h-80 box, so the snapshot captures the
		// clipped, scrollable region using the shared .scrollable (VS Code-style
		// scrollbar) surface.
		const scrollBox = component.locator(".scrollable")
		expect(await scrollBox.count()).toBe(1)
		await expect(scrollBox).toHaveClass(/max-h-80/)
		const { scrollHeight, clientHeight } = await scrollBox.evaluate((el) => ({
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
		}))
		expect(scrollHeight).toBeGreaterThan(clientHeight)

		await expect(component).toHaveScreenshot(`task-header-markdown-${theme.name}.png`)
	})
}
