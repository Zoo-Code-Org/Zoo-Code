import { expect, test } from "../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../playwright/mounted-story"

const popoverCases = [
	{ story: "code-index-status-failed-files", text: /broken\.ts/ },
	{ story: "code-index-status-provider-wait", text: /OpenAI/ },
]

for (const { story, text } of popoverCases) {
	test(`renders the ${story} popover`, async ({ mount, page }) => {
		const component = mountedStory(await mount(story))
		await component.getByRole("button").first().click()
		const popover = page.getByRole("dialog")
		await expect(popover.getByText(text).first()).toBeVisible()
		await expect(popover).toHaveScreenshot(`${story}.png`)
	})
}

test("shows the amber badge for an idle partial index", async ({ mount }) => {
	const component = mountedStory(await mount("code-index-status-amber-badge"))
	await expect(component.locator(".bg-amber-500")).toBeVisible()
	await expect(component).toHaveScreenshot("code-index-status-amber-badge.png")
})
