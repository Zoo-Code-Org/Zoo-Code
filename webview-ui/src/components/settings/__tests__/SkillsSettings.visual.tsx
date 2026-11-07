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
