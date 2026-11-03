import fs from "fs/promises"
import path from "path"

import { glob } from "glob"

import { downloadAndUnzipVSCode } from "@vscode/test-electron"
import { expect, test, type Page } from "@playwright/test"

import {
	attachFailureArtifacts,
	CHAT_RESULT,
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

async function waitForContent(page: Page, landmark = scenario.landmark) {
	await expect.poll(() => Boolean(contentFrame(page))).toBe(true)
	const frame = contentFrame(page)
	if (!frame) throw new Error("Zoo Code content frame not found")
	await expect(frame.getByText(landmark, { exact: false })).toBeVisible()
	return frame
}

async function observeHeartbeats(page: Page, block = false) {
	const parent = page.frames().find((frame) => frame.url().includes("extensionId=ZooCodeOrganization.zoo-code"))
	if (!parent) throw new Error("Zoo Code parent frame not found")
	return parent.evaluateHandle((blockHeartbeats) => {
		const observed = { block: blockHeartbeats, blocked: 0, forwarded: 0, launches: 0 }
		// Reacquire the observation after a retained hidden frame reconnects;
		// CDP handles from before suspension are not a readiness contract.
		Reflect.set(window, Symbol.for("zooCode.heartbeatObservation"), observed)
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
	// Allow startup, stale detection, recovery observations, and cleanup.
	test.setTimeout(8 * 60_000)
	const running = await startScene(vscodeExecutablePath, scenario, testInfo)
	try {
		const frame = await waitForContent(running.page)
		await frame.evaluate(() => {
			document.documentElement.dataset.heartbeatDocument = "before-timeout"
		})
		const heartbeat = await observeHeartbeats(running.page, true)
		await expect
			.poll(() => heartbeat.evaluate((state) => state.launches), { timeout: 150_000, intervals: [1_000] })
			.toBeGreaterThan(0)
		expect(await heartbeat.evaluate((state) => state.blocked)).toBeGreaterThan(0)
		const recovered = await waitForContent(running.page)
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

for (const explicitRetry of [false, true])
	test(
		explicitRetry
			? "explicit retry recovers the isolated Zoo Code renderer and retains its task"
			: "recovers after the isolated Zoo Code renderer is terminated",
		async ({ browserName: _browserName }, testInfo) => {
			// Allow startup, stale detection, recovery observations, and cleanup.
			test.setTimeout(8 * 60_000)
			const running = await startScene(
				vscodeExecutablePath,
				{ ...scenario, scene: "chat", startMock: true, landmark: CHAT_RESULT },
				testInfo,
			)
			try {
				expect(running.taskIds).toHaveLength(1)
				const initial = await waitForContent(running.page, CHAT_RESULT)
				await initial.evaluate(() => {
					document.documentElement.dataset.heartbeatDocument = "before-crash"
				})
				if (explicitRetry) {
					// Establish a fresh delivered heartbeat before the crash. Explicit
					// recovery must finish before the 90-second stale threshold.
					const beforeCrash = await observeHeartbeats(running.page)
					await expect
						.poll(() => beforeCrash.evaluate((state) => state.forwarded), { timeout: 45_000 })
						.toBeGreaterThan(0)
				}
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
				if (explicitRetry) {
					await running.page.keyboard.press("F1")
					const input = running.page.locator(".quick-input-widget input")
					await expect(input).toBeVisible({ timeout: 10_000 })
					await input.fill(">Zoo Code: Retry Interface Recovery", { timeout: 10_000 })
					await running.page
						.locator(".quick-input-list .monaco-list-row")
						.filter({ hasText: "Retry Interface Recovery" })
						.first()
						.click({ timeout: 10_000 })
				}

				// Allow stale detection (up to 150s), confirmation and replacement waits,
				// plus webview loading. A passing fast run does not bound the slow path.
				await expect
					.poll(
						async () => {
							try {
								const frame = contentFrame(running.page)
								if (!frame || !(await frame.getByText(CHAT_RESULT, { exact: false }).isVisible()))
									return "missing"
								return (
									(await frame
										.locator("html")
										.getAttribute("data-heartbeat-document", { timeout: 1_000 })) ?? "recovered"
								)
							} catch {
								return "unavailable"
							}
						},
						{ timeout: explicitRetry ? 45_000 : 210_000, intervals: [1_000] },
					)
					.toBe("recovered")
				await waitForContent(running.page, CHAT_RESULT)
				await fs.writeFile(`${running.donePath}.probe`, "probe")
				await expect
					.poll(async () => {
						const result = await fs.readFile(`${running.donePath}.probe.result`, "utf8").catch(() => "")
						return result ? (JSON.parse(result) as { taskIds: string[] }) : undefined
					})
					.toMatchObject({ taskIds: running.taskIds })
				const heartbeat = await observeHeartbeats(running.page)
				await expect
					.poll(() => heartbeat.evaluate((state) => state.forwarded), { timeout: 45_000 })
					.toBeGreaterThan(0)
			} catch (error) {
				await attachFailureArtifacts(running, testInfo)
				throw error
			} finally {
				await stopScene(running, testInfo)
			}
		},
	)

test("keeps the same document when the sidebar is hidden past the stale threshold", async ({
	browserName: _browserName,
}, testInfo) => {
	// Allow 210s startup, 125s hidden, two 45s polls, and cleanup.
	test.setTimeout(8 * 60_000)
	const running = await startScene(vscodeExecutablePath, scenario, testInfo)
	try {
		const frame = await waitForContent(running.page)
		await frame.evaluate(() => {
			document.documentElement.dataset.heartbeatDocument = "retained"
		})
		const heartbeat = await observeHeartbeats(running.page, true)
		// Establish that the interceptor works before hiding. Chromium may
		// suspend hidden renderer timers entirely, so no hidden tick is promised.
		await expect.poll(() => heartbeat.evaluate((state) => state.blocked), { timeout: 45_000 }).toBeGreaterThan(0)
		await running.page.keyboard.press("Control+b")
		await expect(running.page.locator(".part.sidebar")).toBeHidden()
		const deadline = performance.now() + 125_000
		// Observe a complete production stale window and two watchdog ticks;
		// this is a negative assertion window, not a delay for UI readiness.
		await expect
			.poll(() => performance.now(), { timeout: 135_000, intervals: [1_000] })
			.toBeGreaterThanOrEqual(deadline)
		const logs = await glob("logs/**/*Zoo-Code.log", { cwd: running.userDataPath })
		expect(logs.length).toBeGreaterThan(0)
		for (const logPath of logs) {
			const output = await fs.readFile(path.join(running.userDataPath, logPath), "utf8")
			expect(output).not.toContain("Webview heartbeat stale while visible")
			expect(output).not.toContain("recreating this webview host")
		}
		await running.page.keyboard.press("Control+b")
		await expect(running.page.locator(".part.sidebar")).toBeVisible()
		const restored = await waitForContent(running.page)
		expect(await restored.evaluate(() => document.documentElement.dataset.heartbeatDocument)).toBe("retained")
		const parent = restored.parentFrame()
		if (!parent) throw new Error("Retained webview parent frame not found")
		await parent.evaluate(() => {
			const state: unknown = Reflect.get(window, Symbol.for("zooCode.heartbeatObservation"))
			if (!state || typeof state !== "object" || !("block" in state))
				throw new Error("Heartbeat observation was lost")
			state.block = false
		})
		await expect
			.poll(
				() =>
					parent.evaluate(() => {
						const state: unknown = Reflect.get(window, Symbol.for("zooCode.heartbeatObservation"))
						if (
							!state ||
							typeof state !== "object" ||
							!("forwarded" in state) ||
							typeof state.forwarded !== "number"
						) {
							throw new Error("Heartbeat observation was lost")
						}
						return state.forwarded
					}),
				{ timeout: 45_000 },
			)
			.toBeGreaterThan(0)
	} catch (error) {
		await attachFailureArtifacts(running, testInfo)
		throw error
	} finally {
		await stopScene(running, testInfo)
	}
})
