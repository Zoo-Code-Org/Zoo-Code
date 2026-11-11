import { downloadAndUnzipVSCode } from "@vscode/test-electron"
import { expect, test } from "@playwright/test"

import {
	attachFailureArtifacts,
	CHAT_RESULT,
	extensionDevelopmentPath,
	SCM_ACTION_TITLE,
	startScene,
	stopScene,
	vscodeVersion,
	type VisualScenario,
} from "./electronHarness"

const scenarios: VisualScenario[] = [
	{
		name: "welcome-dark",
		scene: "welcome",
		themeId: "Default Dark Modern",
		landmark: "Welcome to Zoo Code!",
		webviewSnapshot: "electron-welcome-dark-webview.png",
	},
	{
		name: "welcome-high-contrast",
		scene: "welcome",
		themeId: "Default High Contrast",
		landmark: "Welcome to Zoo Code!",
	},
	{
		name: "chat-dark",
		scene: "chat",
		themeId: "Default Dark Modern",
		landmark: CHAT_RESULT,
		startMock: true,
	},
]

test.describe.configure({ mode: "serial" })

let vscodeExecutablePath: string
test.beforeAll(async () => {
	vscodeExecutablePath = await downloadAndUnzipVSCode({ version: vscodeVersion, extensionDevelopmentPath })
})

for (const scenario of scenarios) {
	test(`renders ${scenario.name} in the real VS Code Extension Host`, async ({
		browserName: _browserName,
	}, testInfo) => {
		const running = await startScene(vscodeExecutablePath, scenario, testInfo)
		try {
			await running.page.mouse.move(900, 400)
			await expect
				.poll(() =>
					running.page
						.frames()
						.some((frame) => frame.url().includes("extensionId=ZooCodeOrganization.zoo-code")),
				)
				.toBe(true)
			const parentFrame = running.page
				.frames()
				.find((frame) => frame.url().includes("extensionId=ZooCodeOrganization.zoo-code"))
			const contentFrame = parentFrame?.childFrames().find((frame) => frame.url().includes("/fake.html"))
			if (!contentFrame) throw new Error("Zoo Code webview content frame not found")
			await contentFrame
				.getByText(scenario.landmark, { exact: false })
				.waitFor({ state: "visible", timeout: 60_000 })
			await contentFrame.evaluate(() => {
				if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
			})
			await expect.poll(() => contentFrame.evaluate(() => document.activeElement === document.body)).toBe(true)
			await contentFrame.evaluate(() => document.fonts.ready)

			// The selected model's metadata resolves asynchronously: router models
			// arrive over the extension-host message channel after the webview
			// launches. Until they land, the context-window readout renders the `1`
			// fallback (see TaskHeader's `model?.contextWindow || 1`)
			//  Wait for a resolved context window so the screenshot is deterministic.
			if (scenario.scene === "chat") {
				await expect(contentFrame.locator('[data-testid="context-window-size"]')).not.toHaveText("1", {
					timeout: 60_000,
				})
			}

			const sidebar = running.page.locator(".part.sidebar")
			await expect(sidebar).toBeVisible()

			// Mask the dynamic token counter so system-prompt changes that alter
			// token counts do not cause pixel diffs when layout is unchanged.
			const webviewFrame = running.page.frameLocator('iframe[src*="extensionId=ZooCodeOrganization.zoo-code"]')
			const tokenCountMask = webviewFrame
				.frameLocator("iframe")
				.locator('[data-testid="context-tokens-count"],[data-testid="context-window-size"]')
			// The time under each message is the real send time, so it changes on every run, and so does the length
			// of its text ("Today 9:05 AM" and "Yesterday 12:36 PM" are not equally long). A mask covers the
			// element's box, so that box needs a fixed size as well: without it the masked area differs between
			// runs, in width and, when the text wraps onto a second line, in height.
			await contentFrame.evaluate(() => {
				document.querySelectorAll<HTMLElement>('[data-testid="message-timestamp"]').forEach((time) => {
					time.style.setProperty("width", "160px", "important")
					time.style.setProperty("white-space", "nowrap", "important")
					time.style.setProperty("overflow", "hidden", "important")
				})
			})
			// Mask it, as the token counters above, and keep the rest of the scene byte-stable.
			const messageTimeMask = webviewFrame.frameLocator("iframe").locator('[data-testid="message-timestamp"]')
			await expect(sidebar).toHaveScreenshot(`electron-${scenario.name}-sidebar.png`, {
				mask: [tokenCountMask, messageTimeMask],
			})

			if (scenario.webviewSnapshot) {
				const webview = running.page.locator('iframe[src*="extensionId=ZooCodeOrganization.zoo-code"]')
				await expect(webview).toHaveCount(1)
				await expect(webview).toHaveScreenshot(scenario.webviewSnapshot)
			}
		} catch (error) {
			await attachFailureArtifacts(running, testInfo)
			throw error
		} finally {
			await stopScene(running, testInfo)
		}
	})
}

const scmScenario: VisualScenario = {
	name: "scm-title-dark",
	scene: "scm",
	themeId: "Default Dark Modern",
	landmark: SCM_ACTION_TITLE,
}

test("renders the Generate Commit Message action in the Source Control title bar", async ({
	browserName: _browserName,
}, testInfo) => {
	const running = await startScene(vscodeExecutablePath, scmScenario, testInfo)
	try {
		// Keep the pointer away from the sidebar so no action shows a hover state or tooltip.
		await running.page.mouse.move(900, 400)
		// `has` takes a locator relative to each header, so it names only the action itself.
		const header = running.page
			.locator(".part.sidebar .pane-header")
			.filter({ has: running.page.locator(`[aria-label="${SCM_ACTION_TITLE}"]`) })
		await expect(header).toHaveCount(1)
		await expect(header.locator(`[aria-label="${SCM_ACTION_TITLE}"]`)).toBeVisible()
		await expect(header).toHaveScreenshot("electron-scm-title-dark-header.png")
	} catch (error) {
		await attachFailureArtifacts(running, testInfo)
		throw error
	} finally {
		await stopScene(running, testInfo)
	}
})
