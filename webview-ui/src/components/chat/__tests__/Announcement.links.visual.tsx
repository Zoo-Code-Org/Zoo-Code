import { expect, test } from "../../../../playwright/coverage-fixture"
import { getCapturedVscodeMessages } from "../../../../playwright/vscode-messages"

test("announcement links open exactly once through the extension host", async ({ mount, page }) => {
	await mount("announcement-links")

	// Mirrors VS Code's webview bootstrap (handleInnerClick): a document-level
	// bubble listener that walks the composed path for any anchor with an href
	// and records the URL. In real VS Code this is where did-click-link is
	// posted for the second open; its handler never checks defaultPrevented.
	await page.evaluate(() => {
		const w = window as unknown as { __interceptedLinks: string[] }
		w.__interceptedLinks = []
		document.addEventListener("click", (event) => {
			// Real Playwright clicks arrive as trusted events; skip synthetic
			// dispatches so the mirror only records genuine user clicks.
			if (!event.isTrusted) {
				return
			}
			for (const node of event.composedPath()) {
				if (node instanceof HTMLAnchorElement && node.href) {
					w.__interceptedLinks.push(node.href)
					break
				}
			}
		})
	})

	// The dialog portals outside the mount wrapper, so scope to the page.
	await page.getByRole("link", { name: /zoocode\.dev\/models/ }).click()
	await page.getByRole("link", { name: "GitHub" }).click()
	await page.getByRole("link", { name: "X", exact: true }).click()
	await page.getByRole("link", { name: "Discord" }).click()
	await page.getByRole("link", { name: "Reddit" }).click()

	// The modal overlay blocks the control link behind it; close the dialog
	// (which also exercises hideAnnouncement) before clicking it.
	await page.keyboard.press("Escape")
	await page.locator("#control-link").click()

	// Exactly one host message per link, in render order.
	const hostMessages = (await getCapturedVscodeMessages(page)).filter((message) => message.type === "openExternal")
	expect(hostMessages).toEqual([
		{ type: "openExternal", url: "https://zoocode.dev/models" },
		{ type: "openExternal", url: "https://github.com/Zoo-Code-Org/Zoo-Code" },
		{ type: "openExternal", url: "https://x.com/ZooCodeDev" },
		{ type: "openExternal", url: "https://discord.gg/VxfP4Vx3gX" },
		{ type: "openExternal", url: "https://www.reddit.com/r/ZooCode/" },
	])

	// Only the control anchor reaches VS Code's click interception.
	const interceptedLinks = await page.evaluate(
		() => (window as unknown as { __interceptedLinks: string[] }).__interceptedLinks,
	)
	expect(interceptedLinks).toHaveLength(1)
	// The control href resolves to an absolute URL, so match on the fragment.
	expect(interceptedLinks[0]).toMatch(/#control$/)

	await mount("announcement-links")
	expect(await getCapturedVscodeMessages(page)).toEqual([])
})
