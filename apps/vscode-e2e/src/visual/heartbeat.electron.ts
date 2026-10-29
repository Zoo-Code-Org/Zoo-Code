import { downloadAndUnzipVSCode } from "@vscode/test-electron"
import { expect, test, type Page } from "@playwright/test"

import {
	attachFailureArtifacts,
	extensionDevelopmentPath,
	startScene,
	stopScene,
	vscodeVersion,
	type VisualScenario,
} from "./electronHarness"

const scenario: VisualScenario = {
	name: "heartbeat",
	scene: "welcome",
	themeId: "Default Dark Modern",
	landmark: "Welcome to Zoo Code!",
}

function contentFrame(page: Page) {
	return page
		.frames()
		.find((frame) => frame.url().includes("extensionId=ZooCodeOrganization.zoo-code"))
		?.childFrames()
		.find((frame) => frame.url().includes("/fake.html"))
}

async function waitForWelcome(page: Page) {
	await expect.poll(() => Boolean(contentFrame(page))).toBe(true)
	const frame = contentFrame(page)
	if (!frame) throw new Error("Zoo Code content frame not found")
	await expect(frame.getByText(scenario.landmark, { exact: false })).toBeVisible()
	return frame
}

async function observeHeartbeats(page: Page, block = false) {
	const parent = page.frames().find((frame) => frame.url().includes("extensionId=ZooCodeOrganization.zoo-code"))
	if (!parent) throw new Error("Zoo Code parent frame not found")
	return parent.evaluateHandle((blockHeartbeats) => {
		const observed = { block: blockHeartbeats, blocked: 0, forwarded: 0, launches: 0 }
		const original = MessagePort.prototype.postMessage
		// VS Code 1.100 forwards webview messages through this parent's port.
		// Intercept only heartbeat payloads; all other host traffic stays real.
		MessagePort.prototype.postMessage = function (this: MessagePort, envelope: unknown, ...args: unknown[]) {
			if (
				typeof envelope === "object" &&
				envelope !== null &&
				"channel" in envelope &&
				envelope.channel === "onmessage" &&
				"data" in envelope
			) {
				const data = envelope.data
				if (typeof data === "object" && data !== null && "message" in data) {
					const message = data.message
					if (typeof message === "object" && message !== null && "type" in message) {
						if (message.type === "webviewDidLaunch") {
							observed.launches++
							observed.block = false
						}
						if (message.type === "webviewHeartbeat") {
							if (observed.block) {
								observed.blocked++
								return
							}
							observed.forwarded++
						}
					}
				}
			}
			Reflect.apply(original, this, [envelope, ...args])
		}
		return observed
	}, block)
}

let vscodeExecutablePath: string
test.beforeAll(async () => {
	vscodeExecutablePath = await downloadAndUnzipVSCode({ version: vscodeVersion, extensionDevelopmentPath })
})

test("recovers when heartbeat delivery stops and resumes periodic heartbeats", async ({
	browserName: _browserName,
}, testInfo) => {
	test.setTimeout(4 * 60_000)
	const running = await startScene(vscodeExecutablePath, scenario, testInfo)
	try {
		const frame = await waitForWelcome(running.page)
		await frame.evaluate(() => {
			document.documentElement.dataset.heartbeatDocument = "before-timeout"
		})
		const heartbeat = await observeHeartbeats(running.page, true)
		await expect
			.poll(() => heartbeat.evaluate((state) => state.launches), { timeout: 150_000, intervals: [1_000] })
			.toBeGreaterThan(0)
		expect(await heartbeat.evaluate((state) => state.blocked)).toBeGreaterThan(0)
		const recovered = await waitForWelcome(running.page)
		expect(await recovered.evaluate(() => document.documentElement.dataset.heartbeatDocument)).toBeUndefined()
		// Mount effects can emit more than one launch/heartbeat message. Capture
		// their counts after rendering, then require a later interval heartbeat.
		const afterMount = await heartbeat.jsonValue()
		expect(afterMount.forwarded).toBeGreaterThan(0)
		await expect
			.poll(() => heartbeat.evaluate((state) => state.forwarded), { timeout: 45_000 })
			.toBeGreaterThan(afterMount.forwarded)
		expect(await heartbeat.evaluate((state) => state.launches)).toBe(afterMount.launches)
	} catch (error) {
		await attachFailureArtifacts(running, testInfo)
		throw error
	} finally {
		await stopScene(running, testInfo)
	}
})

test("recovers after the isolated Zoo Code renderer is terminated", async ({ browserName: _browserName }, testInfo) => {
	test.setTimeout(4 * 60_000)
	const running = await startScene(vscodeExecutablePath, scenario, testInfo)
	try {
		const initial = await waitForWelcome(running.page)
		await initial.evaluate(() => {
			document.documentElement.dataset.heartbeatDocument = "before-crash"
		})
		const processes = await running.app.evaluate(({ BrowserWindow }) => {
			const mainFrame = BrowserWindow.getAllWindows()[0]?.webContents.mainFrame
			if (!mainFrame) throw new Error("VS Code workbench frame not found")
			const renderer = mainFrame.framesInSubtree.find(
				(frame: { url: string; parent?: { url: string }; osProcessId: number }) =>
					frame.url.includes("/fake.html") &&
					frame.parent?.url.includes("extensionId=ZooCodeOrganization.zoo-code"),
			)
			if (!renderer) throw new Error("Zoo Code renderer process not found")
			return { workbench: mainFrame.osProcessId, webview: renderer.osProcessId }
		})
		await testInfo.attach("renderer-processes.json", {
			body: JSON.stringify(processes),
			contentType: "application/json",
		})
		// Never terminate the workbench: this test requires a separate OOPIF process.
		expect(processes.webview).toBeGreaterThan(0)
		expect(processes.webview).not.toBe(processes.workbench)
		process.kill(processes.webview, "SIGKILL")

		// Use production timers: the next stale tick is at most two minutes away.
		await expect
			.poll(
				async () => {
					try {
						const frame = contentFrame(running.page)
						if (!frame || !(await frame.getByText(scenario.landmark, { exact: false }).isVisible()))
							return "missing"
						return (
							(await frame.locator("html").getAttribute("data-heartbeat-document", { timeout: 1_000 })) ??
							"recovered"
						)
					} catch {
						return "unavailable"
					}
				},
				{ timeout: 150_000, intervals: [1_000] },
			)
			.toBe("recovered")
		await waitForWelcome(running.page)
		const heartbeat = await observeHeartbeats(running.page)
		await expect.poll(() => heartbeat.evaluate((state) => state.forwarded), { timeout: 45_000 }).toBeGreaterThan(0)
	} catch (error) {
		await attachFailureArtifacts(running, testInfo)
		throw error
	} finally {
		await stopScene(running, testInfo)
	}
})

test("keeps the same document when the sidebar is hidden past the stale threshold", async ({
	browserName: _browserName,
}, testInfo) => {
	test.setTimeout(4 * 60_000)
	const running = await startScene(vscodeExecutablePath, scenario, testInfo)
	try {
		const frame = await waitForWelcome(running.page)
		await frame.evaluate(() => {
			document.documentElement.dataset.heartbeatDocument = "retained"
		})
		const heartbeat = await observeHeartbeats(running.page, true)
		await running.page.keyboard.press("Control+b")
		await expect(running.page.locator(".part.sidebar")).toBeHidden()
		const deadline = Date.now() + 125_000
		// Observe a complete production stale window and two watchdog ticks;
		// this is a negative assertion window, not a delay for UI readiness.
		await expect
			.poll(
				async () => {
					expect(await frame.evaluate(() => document.documentElement.dataset.heartbeatDocument)).toBe(
						"retained",
					)
					return Date.now()
				},
				{ timeout: 135_000, intervals: [1_000] },
			)
			.toBeGreaterThanOrEqual(deadline)
		expect(await heartbeat.evaluate((state) => state.blocked)).toBeGreaterThan(0)
		await running.page.keyboard.press("Control+b")
		await expect(running.page.locator(".part.sidebar")).toBeVisible()
		const restored = await waitForWelcome(running.page)
		expect(await restored.evaluate(() => document.documentElement.dataset.heartbeatDocument)).toBe("retained")
		await heartbeat.evaluate((state) => {
			state.block = false
		})
		await expect.poll(() => heartbeat.evaluate((state) => state.forwarded), { timeout: 45_000 }).toBeGreaterThan(0)
	} catch (error) {
		await attachFailureArtifacts(running, testInfo)
		throw error
	} finally {
		await stopScene(running, testInfo)
	}
})
