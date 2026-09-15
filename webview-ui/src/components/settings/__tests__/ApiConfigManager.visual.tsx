import { expect, test } from "../../../../playwright/coverage-fixture"
import { collectBoundedLayoutFailures, REFLOW_VIEWPORT_WIDTH } from "../../../../playwright/layout-contracts"
import { mountedStory } from "../../../../playwright/mounted-story"

test("keeps profile actions visible at narrow editor widths", async ({ mount, page }) => {
	await page.setViewportSize({ width: REFLOW_VIEWPORT_WIDTH, height: 640 })
	const component = mountedStory(await mount("api-config-manager"))
	const story = component.getByTestId("api-config-manager-story")
	const addButton = story.getByTestId("add-profile-button")
	const actionRow = story.getByTestId("select-component").locator("..")

	await expect(story).toHaveScreenshot("api-config-manager-320.png")
	await expect.poll(() => story.evaluate(collectBoundedLayoutFailures)).toEqual([])
	await expect
		.poll(() =>
			actionRow.evaluate((row) => {
				const rowRect = row.getBoundingClientRect()
				const addRect = row
					.querySelector<HTMLElement>("[data-testid='add-profile-button']")!
					.getBoundingClientRect()
				return addRect.left >= rowRect.left && addRect.right <= rowRect.right
			}),
		)
		.toBe(true)
	await addButton.focus()
	await expect(addButton).toBeFocused()
})

test("keeps profile actions visible at desktop editor widths", async ({ mount, page }) => {
	await page.setViewportSize({ width: 640, height: 640 })
	const component = mountedStory(await mount("api-config-manager"))
	const story = component.getByTestId("api-config-manager-story")

	await expect(story).toHaveScreenshot("api-config-manager-640.png")
	await expect.poll(() => story.evaluate(collectBoundedLayoutFailures)).toEqual([])
})
