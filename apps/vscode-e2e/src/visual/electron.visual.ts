import { downloadAndUnzipVSCode } from "@vscode/test-electron"
import { expect, test } from "@playwright/test"

import {
	attachFailureArtifacts,
	CHAT_RESULT,
	extensionDevelopmentPath,
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
			await expect(sidebar).toHaveScreenshot(`electron-${scenario.name}-sidebar.png`, {
				mask: [tokenCountMask],
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
