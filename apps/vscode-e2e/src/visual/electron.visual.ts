import fs from "fs/promises"
import { readFileSync } from "fs"
import os from "os"
import path from "path"

import { LLMock } from "@copilotkit/aimock"
import { downloadAndUnzipVSCode } from "@vscode/test-electron"
import { _electron, expect, test, type ElectronApplication, type Page, type TestInfo } from "@playwright/test"
import { glob } from "glob"

const packageRoot = path.resolve(__dirname, "../..")
const repositoryRoot = path.resolve(packageRoot, "../..")
const extensionDevelopmentPath = path.join(repositoryRoot, "src")
const extensionTestsPath = path.join(packageRoot, "out", "visual", "sceneController")
const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
	devDependencies: Record<string, string>
}
const vscodeVersion = packageJson.devDependencies["@types/vscode"]

const CHAT_PROMPT = "electron-visual-smoke: render a deterministic completion"
const CHAT_RESULT = "Electron visual smoke response rendered inside the real VS Code webview."

interface VisualScenario {
	name: string
	scene: "welcome" | "chat"
	themeId: "Default Dark Modern" | "Default High Contrast"
	landmark: string
	webviewSnapshot?: string
	startMock?: boolean
}

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

interface RunningScene {
	app: ElectronApplication
	donePath: string
	logPath: string
	mock?: InstanceType<typeof LLMock>
	page: Page
	temporaryRoot: string
	userDataPath: string
}

async function waitForJson(filePath: string): Promise<{ landmark: string; scene: string; themeId: string }> {
	const deadline = Date.now() + 90_000
	while (Date.now() < deadline) {
		try {
			return JSON.parse(await fs.readFile(filePath, "utf8")) as {
				landmark: string
				scene: string
				themeId: string
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
	}
	throw new Error(`Timed out waiting for Electron visual readiness file: ${filePath}`)
}

async function attachLogs(userDataPath: string, logPath: string, testInfo: TestInfo) {
	const sceneLog = await fs.readFile(logPath, "utf8").catch(() => "")
	if (sceneLog) await testInfo.attach("scene.log", { body: sceneLog, contentType: "text/plain" })

	for (const pattern of ["logs/**/exthost.log", "logs/**/renderer.log", "logs/**/*Zoo-Code.log"]) {
		const logs = await glob(pattern, { cwd: userDataPath })
		const latest = logs.at(-1)
		if (!latest) continue
		const contents = await fs.readFile(path.join(userDataPath, latest), "utf8").catch(() => "")
		if (contents) await testInfo.attach(path.basename(latest), { body: contents, contentType: "text/plain" })
	}
}

async function stopTracing(app: ElectronApplication, testInfo: TestInfo) {
	await app
		.context()
		.tracing.stop({ path: testInfo.outputPath("trace.zip") })
		.catch(() => undefined)
}

async function startScene(
	vscodeExecutablePath: string,
	scenario: VisualScenario,
	testInfo: TestInfo,
): Promise<RunningScene> {
	const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-code-electron-visual-"))
	const workspacePath = path.join(temporaryRoot, "workspace")
	const userDataPath = path.join(temporaryRoot, "user-data")
	const extensionsPath = path.join(temporaryRoot, "extensions")
	const readyPath = path.join(temporaryRoot, "ready.json")
	const donePath = path.join(temporaryRoot, "done")
	const logPath = path.join(temporaryRoot, "scene.log")
	await Promise.all([fs.mkdir(workspacePath), fs.mkdir(userDataPath), fs.mkdir(extensionsPath)])

	let app: ElectronApplication | undefined
	let mock: InstanceType<typeof LLMock> | undefined
	let page: Page | undefined
	try {
		if (scenario.startMock) {
			mock = new LLMock({ port: 0 })
			mock.addFixture({
				match: { userMessage: CHAT_PROMPT },
				response: {
					toolCalls: [
						{
							name: "attempt_completion",
							arguments: JSON.stringify({ result: CHAT_RESULT }),
							id: "call_electron_visual_completion",
						},
					],
				},
			})
			await mock.start()
		}

		app = await _electron.launch({
			executablePath: vscodeExecutablePath,
			args: [
				workspacePath,
				`--extensionDevelopmentPath=${extensionDevelopmentPath}`,
				`--extensionTestsPath=${extensionTestsPath}`,
				`--user-data-dir=${userDataPath}`,
				`--extensions-dir=${extensionsPath}`,
				"--disable-workspace-trust",
				"--skip-welcome",
				"--skip-release-notes",
				"--disable-updates",
				"--disable-gpu",
				"--force-device-scale-factor=1",
			],
			env: {
				...process.env,
				AIMOCK_URL: mock?.url ?? "",
				ROO_CODE_VISUAL_CHAT_PROMPT: CHAT_PROMPT,
				ROO_CODE_VISUAL_CHAT_RESULT: CHAT_RESULT,
				ROO_CODE_VISUAL_DONE_PATH: donePath,
				ROO_CODE_VISUAL_LOG_PATH: logPath,
				ROO_CODE_VISUAL_READY_PATH: readyPath,
				ROO_CODE_VISUAL_SCENE: scenario.scene,
				ROO_CODE_VISUAL_THEME: scenario.themeId,
				ROO_CODE_THEME_FIXTURE_PROBE: "1",
			},
			locale: "en-US",
			timeout: 60_000,
			timezoneId: "UTC",
		})
		await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
		page = await app.firstWindow({ timeout: 60_000 })
		await app.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows()[0]
			window?.setBounds({ x: 0, y: 0, width: 1200, height: 800 })
			window?.focus()
		})
		const ready = await waitForJson(readyPath)
		expect(ready).toMatchObject({ landmark: scenario.landmark, scene: scenario.scene, themeId: scenario.themeId })
		return { app, donePath, logPath, mock, page, temporaryRoot, userDataPath }
	} catch (error) {
		if (page) await page.screenshot({ path: testInfo.outputPath("workbench.png") }).catch(() => undefined)
		await attachLogs(userDataPath, logPath, testInfo)
		await fs.writeFile(donePath, "done\n", "utf8").catch(() => undefined)
		if (app) await stopTracing(app, testInfo)
		await app?.close().catch(() => undefined)
		await mock?.stop().catch(() => undefined)
		await fs.rm(temporaryRoot, { recursive: true, force: true })
		if (error instanceof Error) throw error
		throw new Error(String(error))
	}
}

async function attachFailureArtifacts(scene: RunningScene, testInfo: TestInfo) {
	await scene.page.screenshot({ path: testInfo.outputPath("workbench.png") }).catch(() => undefined)
	await attachLogs(scene.userDataPath, scene.logPath, testInfo)
}

async function stopScene(scene: RunningScene, testInfo: TestInfo) {
	await fs.writeFile(scene.donePath, "done\n", "utf8").catch(() => undefined)
	await stopTracing(scene.app, testInfo)
	await scene.app.close().catch(() => undefined)
	await scene.mock?.stop().catch(() => undefined)
	await fs.rm(scene.temporaryRoot, { recursive: true, force: true })
}

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

			const sidebar = running.page.locator(".part.sidebar")
			await expect(sidebar).toBeVisible()
			await expect(sidebar).toHaveScreenshot(`electron-${scenario.name}-sidebar.png`)

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
