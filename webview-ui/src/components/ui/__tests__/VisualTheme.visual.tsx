import { expect, test } from "../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

test("finishes theme color transitions before contrast checks read them", async ({ mount, page }) => {
	const component = mountedStory(await mount("welcome"))
	const action = component.getByRole("button", { name: /provider/i }).first()
	await expect(action).toBeVisible()

	// The gallery starts in the dark theme, so this switch starts the Button border-color transition.
	await applyVisualTheme(
		page,
		visualThemes.find((theme) => theme.name === "high-contrast-light")!,
	)

	const runningTransitions = await page.evaluate(
		() =>
			document
				.getAnimations()
				.filter((animation) => animation instanceof CSSTransition && animation.playState === "running").length,
	)
	expect(runningTransitions).toBe(0)
	// Read once instead of toHaveCSS, which retries until the transition ends on its own.
	expect(await action.evaluate((element) => getComputedStyle(element).borderTopColor)).toBe("rgb(15, 74, 133)")
})
