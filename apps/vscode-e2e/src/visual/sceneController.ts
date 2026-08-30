import fs from "fs/promises"

import * as vscode from "vscode"

import { RooCodeEventName, type ClineMessage, type RooCodeTestAPI, type WebviewThemeFixture } from "@roo-code/types"

import { isCompletedAsk } from "../suite/utils"

const POLL_INTERVAL_MS = 100
const SCENE_TIMEOUT_MS = 60_000

const themeKinds: Record<string, vscode.ColorThemeKind> = {
	"Default Dark Modern": vscode.ColorThemeKind.Dark,
	"Default High Contrast": vscode.ColorThemeKind.HighContrast,
}

async function poll<T>(capture: () => Promise<T>, matches: (value: T) => boolean, description: string): Promise<T> {
	const deadline = Date.now() + SCENE_TIMEOUT_MS
	let latest: T | undefined

	while (Date.now() < deadline) {
		latest = await capture()
		if (matches(latest)) return latest
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
	}

	throw new Error(`Timed out waiting for ${description}; latest value: ${JSON.stringify(latest)}`)
}

async function waitForFile(filePath: string) {
	await poll(
		async () => {
			try {
				await fs.access(filePath)
				return true
			} catch {
				return false
			}
		},
		Boolean,
		`file ${filePath}`,
	)
}

export async function run(): Promise<void> {
	const scene = process.env.ROO_CODE_VISUAL_SCENE
	const themeId = process.env.ROO_CODE_VISUAL_THEME
	const readyPath = process.env.ROO_CODE_VISUAL_READY_PATH
	const donePath = process.env.ROO_CODE_VISUAL_DONE_PATH
	const logPath = process.env.ROO_CODE_VISUAL_LOG_PATH
	const aimockUrl = process.env.AIMOCK_URL

	if (!scene || !themeId || !readyPath || !donePath || !logPath) {
		throw new Error("Electron visual scene, theme, ready path, done path, and log path are required")
	}
	const log = (message: string) => fs.appendFile(logPath, `${message}\n`, "utf8")
	await log(`scene=${scene} theme=${themeId}`)
	if (scene !== "welcome" && scene !== "chat") throw new Error(`Unknown Electron visual scene: ${scene}`)
	if (!themeKinds[themeId]) throw new Error(`Unsupported Electron visual theme: ${themeId}`)

	const extension = vscode.extensions.getExtension<RooCodeTestAPI>("ZooCodeOrganization.zoo-code")
	if (!extension) throw new Error("Zoo Code extension not found")
	const api = extension.isActive ? extension.exports : await extension.activate()

	await vscode.commands.executeCommand("zoo-code.SidebarProvider.focus")
	await poll(async () => api.isReady(), Boolean, "Zoo Code webview activation")
	await log("webview-ready")
	await vscode.workspace
		.getConfiguration("workbench")
		.update("colorTheme", themeId, vscode.ConfigurationTarget.Global)
	await poll(
		async () => vscode.window.activeColorTheme.kind,
		(kind) => kind === themeKinds[themeId],
		`${themeId} color theme kind`,
	)

	const themeFixture = await poll<WebviewThemeFixture>(
		() => api.captureWebviewThemeFixture(),
		(fixture) => fixture.themeId === themeId,
		`${themeId} Zoo Code webview theme`,
	)
	await log(`theme-ready=${themeFixture.themeId}`)

	let landmark = "Welcome to Zoo Code!"
	if (scene === "chat") {
		if (!aimockUrl) throw new Error("AIMOCK_URL is required for the populated chat scene")
		const prompt = process.env.ROO_CODE_VISUAL_CHAT_PROMPT
		const result = process.env.ROO_CODE_VISUAL_CHAT_RESULT
		if (!prompt || !result) throw new Error("Chat prompt and result are required for the populated chat scene")

		await api.setConfiguration({
			apiProvider: "openrouter",
			lastShownAnnouncementId: api.getLatestAnnouncementId(),
			openRouterApiKey: "mock-key",
			openRouterModelId: "openai/gpt-4.1",
			openRouterBaseUrl: `${aimockUrl}/v1`,
			telemetrySetting: "disabled",
		})
		await log(`aimock=${aimockUrl}`)
		let completionHandler: ((event: { message: ClineMessage }) => void) | undefined
		const completionVisible = new Promise<void>((resolve) => {
			completionHandler = ({ message }: { message: ClineMessage }) => {
				void log(
					`message type=${message.type} ask=${message.type === "ask" ? message.ask : ""} say=${message.type === "say" ? message.say : ""} text=${message.text?.slice(0, 160) ?? ""}`,
				)
				if (
					(message.type === "say" && message.say === "completion_result" && message.text?.includes(result)) ||
					(isCompletedAsk(message) && message.ask === "completion_result" && message.text?.includes(result))
				) {
					resolve()
				}
			}
			api.on(RooCodeEventName.Message, completionHandler)
		})
		await api.startNewTask({
			configuration: { mode: "ask", alwaysAllowModeSwitch: true, autoApprovalEnabled: true },
			text: prompt,
		})
		await log("task-started")
		let timeout: NodeJS.Timeout | undefined
		try {
			await Promise.race([
				completionVisible,
				new Promise((_, reject) => {
					timeout = setTimeout(() => reject(new Error("Timed out waiting for chat result")), SCENE_TIMEOUT_MS)
				}),
			])
		} finally {
			if (timeout) clearTimeout(timeout)
			if (completionHandler) api.off(RooCodeEventName.Message, completionHandler)
		}
		landmark = result
	}

	await fs.writeFile(readyPath, `${JSON.stringify({ scene, themeId, landmark, themeFixture }, null, 2)}\n`, "utf8")
	await waitForFile(donePath)
}
