import { expect, test } from "../../../../playwright/coverage-fixture"
import { collectBoundedLayoutFailures } from "../../../../playwright/layout-contracts"
import { mountedStory } from "../../../../playwright/mounted-story"

test("detects clipped direct text containers", async ({ mount }) => {
	const component = mountedStory(await mount("layout-clipped-text"))
	const failures = await component.evaluate(collectBoundedLayoutFailures)

	expect(failures).toContain("Clipped direct text clips horizontally")
})

test("ignores screen-reader-only content", async ({ mount }) => {
	const component = mountedStory(await mount("layout-screen-reader-only"))
	const failures = await component.evaluate(collectBoundedLayoutFailures)

	expect(failures).toEqual([])
})
