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

		// Establish the expanded state deterministically through the heading
		// (rendered only by the markdown pipeline in the expanded view).
		await expect(component.getByRole("heading", { name: "Refactor the billing module" })).toBeVisible()

		// Content assertions (list items, mention text, <br> soft breaks, the
		// .scrollable/max-h-80 box) are covered by TaskHeader.spec.tsx and
		// MarkdownBlock.spec.tsx; the pixel receipt here only pins the rendered
		// state. The prompt overflows the max-h-80 box, so the snapshot captures
		// the clipped, scrollable region.
		const scrollBox = component.locator(".scrollable")
		const { scrollHeight, clientHeight } = await scrollBox.evaluate((el) => ({
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
		}))
		expect(scrollHeight).toBeGreaterThan(clientHeight)

		await expect(component).toHaveScreenshot(`task-header-markdown-${theme.name}.png`)
	})
}
