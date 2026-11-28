import { expect, test } from "../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../playwright/mounted-story"

test("expanded file changes scroll while the summary header remains visible", async ({ mount }) => {
	const story = mountedStory(await mount("file-changes-long-list"))
	const header = story.getByRole("button", { name: /40 file/ })
	await header.click()

	const list = story.getByTestId("file-changes-list")
	await expect(list).toBeVisible()
	await expect(story).toHaveScreenshot("file-changes-expanded-dark.png")
	const dimensions = await list.evaluate((element) => ({
		clientHeight: element.clientHeight,
		scrollHeight: element.scrollHeight,
	}))
	expect(dimensions.clientHeight).toBeGreaterThan(0)
	expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight)

	await list.focus()
	await list.press("End")
	await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
	await expect(header).toBeInViewport()
	await expect(story.getByText("src/file-39.ts")).toBeInViewport()
})
