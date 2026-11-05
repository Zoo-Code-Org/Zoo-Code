import type { Locator } from "@playwright/test"

import { expect, test } from "../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

const fontSize = (locator: Locator) =>
	locator.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))

// Real layout, because the sizes are `calc()` of two variables, which jsdom does not compute. The computed sizes are
// what is checked, in every theme; the screenshots are one focused picture of each of the two states.
for (const theme of visualThemes) {
	test(`the names, arguments, descriptions and badges of the tool rows follow the interface scale, and removing it restores them (${theme.name})`, async ({
		mount,
		page,
	}) => {
		const component = mountedStory(await mount("appearance-tool-rows"))
		await applyVisualTheme(page, theme)
		const story = component.getByTestId("appearance-tool-rows-story")

		// Each text, with the px that its size has beside the base size of the font (`calc(base * scale - offset)`).
		const texts = [
			{
				name: "the name of a skill",
				locator: story.getByTestId("tool-skill").getByText("deploy-helper"),
				offset: 0,
			},
			{
				name: "the source badge of a skill",
				locator: story.getByTestId("tool-skill").getByText("project", { exact: true }),
				offset: -2,
			},
			{
				name: "the name of a slash command to approve",
				locator: story.getByTestId("tool-slash-ask").getByText("/init", { exact: true }),
				offset: 0,
			},
			{
				name: "the source badge of a slash command to approve",
				locator: story.getByTestId("tool-slash-ask").getByText("project", { exact: true }),
				offset: -2,
			},
			{
				name: "the name of a slash command that ran",
				locator: story.getByTestId("tool-slash-say").getByText("/init", { exact: true }),
				offset: 0,
			},
			{
				name: "the arguments of a slash command that ran",
				locator: story.getByTestId("tool-slash-say").getByText("--force", { exact: true }),
				offset: 0,
			},
			{
				name: "the description of a slash command that ran",
				locator: story.getByTestId("tool-slash-say").getByText("Starts a new project", { exact: true }),
				offset: -1,
			},
			{
				name: "the source badge of a slash command that ran",
				locator: story.getByTestId("tool-slash-say").getByText("project", { exact: true }),
				offset: -2,
			},
		]
		for (const { locator } of texts) await expect(locator).toBeVisible()

		// Unset: the size of the font, less the offset of the text.
		await expect(story.getByTestId("scale-state")).toHaveText("unset")
		const base = await fontSize(texts[0].locator)
		const before: number[] = []
		for (const { name, locator, offset } of texts) {
			const size = await fontSize(locator)
			expect(size, name).toBeCloseTo(base + offset, 1)
			before.push(size)
		}
		await expect(story).toHaveScreenshot(`appearance-tool-rows-${theme.name}-unset.png`)

		// Set: 150%. The offset is taken after the scale, so a badge is 1.5 * base - 2, not 1.5 * (base - 2).
		await story.getByTestId("apply-scale").click()
		await expect(story.getByTestId("scale-state")).toHaveText("set")
		await expect.poll(() => fontSize(texts[0].locator)).toBeCloseTo(base * 1.5, 1)
		for (const { name, locator, offset } of texts) {
			expect(await fontSize(locator), name).toBeCloseTo(base * 1.5 + offset, 1)
		}
		await expect(story).toHaveScreenshot(`appearance-tool-rows-${theme.name}-set.png`)

		// Removed again: every text is back on its size.
		await story.getByTestId("remove-scale").click()
		await expect(story.getByTestId("scale-state")).toHaveText("unset")
		await expect.poll(() => fontSize(texts[0].locator)).toBeCloseTo(base, 1)
		for (const [index, { name, locator }] of texts.entries()) {
			expect(await fontSize(locator), name).toBeCloseTo(before[index], 1)
		}
		// ...and it looks the way it did before: the same picture as the unset state.
		await expect(story).toHaveScreenshot(`appearance-tool-rows-${theme.name}-unset.png`)
	})
}
