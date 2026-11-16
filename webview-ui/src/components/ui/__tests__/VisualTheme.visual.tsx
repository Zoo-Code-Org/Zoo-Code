import { expect, test } from "../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

test("finishes theme color transitions before contrast checks read them", async ({ mount, page }) => {
	const component = mountedStory(await mount("welcome"))
	const action = component.getByRole("button", { name: /provider/i }).first()
	await expect(action).toBeVisible()

	// Stretch the about 150 ms transition so it cannot end on its own before the assertions read it.
	// Reading the computed style flushes it, so the theme switch below starts the long transition.
	const transitionDuration = await action.evaluate((element) => {
		element.style.transitionDuration = "10s"
		return getComputedStyle(element).transitionDuration
	})
	expect(transitionDuration).toBe("10s")

	// finish() throws on an infinite animation, so the theme switch must leave CSS animations running.
	await page.evaluate(() => {
		const style = document.createElement("style")
		style.id = "visual-theme-infinite-animation"
		style.textContent =
			"@keyframes visual-theme-pulse { to { opacity: 0.5; } }" +
			"#visual-theme-infinite-animation-probe { animation: visual-theme-pulse 1s infinite; }"
		const probe = document.createElement("div")
		probe.id = "visual-theme-infinite-animation-probe"
		document.head.append(style)
		document.body.append(probe)
	})

	// The gallery starts in the dark theme, so this switch starts the Button border-color transition.
	await applyVisualTheme(
		page,
		visualThemes.find((theme) => theme.name === "high-contrast-light")!,
	)

	const { runningTransitions, runningAnimations } = await page.evaluate(() => {
		const running = document.getAnimations().filter((animation) => animation.playState === "running")
		return {
			runningTransitions: running.filter((animation) => animation instanceof CSSTransition).length,
			runningAnimations: running.filter(
				(animation) => animation instanceof CSSAnimation && animation.animationName === "visual-theme-pulse",
			).length,
		}
	})
	expect(runningTransitions).toBe(0)
	expect(runningAnimations).toBe(1)
	// Read once instead of toHaveCSS, which retries until the transition ends on its own.
	expect(await action.evaluate((element) => getComputedStyle(element).borderTopColor)).toBe("rgb(15, 74, 133)")

	await page.evaluate(() => {
		document.getElementById("visual-theme-infinite-animation")?.remove()
		document.getElementById("visual-theme-infinite-animation-probe")?.remove()
	})
})
