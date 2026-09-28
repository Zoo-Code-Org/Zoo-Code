import type { Locator } from "@playwright/test"

export function mountedStory(root: Locator): Locator {
	return root.locator(":scope > [data-playwright-mounted]")
}
