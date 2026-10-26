import { expect, test } from "../../../../playwright/coverage-fixture"
import { collectBoundedLayoutFailures } from "../../../../playwright/layout-contracts"
import { mountedStory } from "../../../../playwright/mounted-story"

test("shows skill load diagnostics with paths, locations and messages", async ({ mount, page }) => {
	await page.setViewportSize({ width: 520, height: 480 })
	const component = mountedStory(await mount("skills-settings-diagnostics"))
	const story = component.getByTestId("skills-settings-story")
	const alert = story.getByRole("alert")

	await expect(alert).toBeVisible()
	// The diagnostics are rendered verbatim: path, optional line:column, message.
	await expect(alert).toContainText("/workspace/.roo/skills/broken-skill/SKILL.md:3:12")
	await expect(alert).toContainText("Invalid YAML frontmatter: unexpected end of the stream")
	await expect(alert).toContainText("/home/user/.roo/skills/legacy-mode/SKILL.md")
	await expect(alert).toContainText("Missing required 'description' field")
	// The valid skill next to the diagnostics still renders its own row.
	await expect(story).toContainText("diagnostics-demo")

	await expect(story).toHaveScreenshot("skills-settings-diagnostics.png")
	await expect.poll(() => story.evaluate(collectBoundedLayoutFailures)).toEqual([])
})
