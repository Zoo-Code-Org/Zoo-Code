import { expect, test } from "../../../../playwright/coverage-fixture"
import { collectBoundedLayoutFailures } from "../../../../playwright/layout-contracts"
import { mountedStory } from "../../../../playwright/mounted-story"

test("renders the diagnostics story deterministically", async ({ mount, page }) => {
	await page.setViewportSize({ width: 520, height: 480 })
	const component = mountedStory(await mount("skills-settings-diagnostics"))
	const story = component.getByTestId("skills-settings-story")

	// Behavioural assertions for the diagnostics alert live in the SkillsSettings Vitest
	// suite; this test only pins the deterministic state and its screenshot.
	await expect(story).toHaveScreenshot("skills-settings-diagnostics.png")
	await expect.poll(() => story.evaluate(collectBoundedLayoutFailures)).toEqual([])
})

test("keeps the skills list reachable when many diagnostics arrive", async ({ mount, page }) => {
	// The pane height is fixed by the story on purpose: the failure this case guards is a
	// height race inside the settings pane, and a story that inherits its height from its
	// own content cannot lose that race. The viewport is taller than the pane so that the
	// pane, and not the browser window, decides what is reachable.
	await page.setViewportSize({ width: 520, height: 700 })
	const component = mountedStory(await mount("skills-settings-many-diagnostics"))
	const story = component.getByTestId("skills-settings-story")

	const layout = await story.evaluate((element: HTMLElement) => {
		const pane = element.getBoundingClientRect()
		const alert = element.querySelector("[role='alert']")
		const list = alert ? alert.querySelector("ul") : null
		const scroller = element.querySelector(".flex-1.overflow-y-auto")
		const addSkill = Array.from(element.querySelectorAll("button")).find((button) =>
			(button.textContent || "").includes("Add Skill"),
		)
		return {
			diagnosticsListScrolls:
				Boolean(list) && (list as HTMLElement).scrollHeight > (list as HTMLElement).clientHeight,
			addSkillInsidePane:
				Boolean(addSkill) &&
				Math.round((addSkill as HTMLElement).getBoundingClientRect().bottom) <= Math.round(pane.bottom),
			skillsScrollerHeight: scroller ? Math.round(scroller.getBoundingClientRect().height) : 0,
		}
	})

	// Bounding the diagnostics list is what keeps all three true at once. Assertions are
	// measured here rather than taken from collectBoundedLayoutFailures because that helper
	// flags the skills scroller for its own scrolled content in both configurations at this
	// fixture size, so it cannot tell the bounded list from the unbounded one.
	expect(layout.diagnosticsListScrolls).toBe(true)
	expect(layout.addSkillInsidePane).toBe(true)
	expect(layout.skillsScrollerHeight).toBeGreaterThanOrEqual(40)
})
