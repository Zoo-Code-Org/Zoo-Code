import fs from "fs/promises"
import path from "path"
import * as vscode from "vscode"
import { providerIdentifiers, RooCodeEventName, type ClineMessage, type RooCodeTestAPI } from "@roo-code/types"
import { SMALL_TASK_MARKER } from "./workload"

async function poll(capture: () => Promise<boolean>, description: string): Promise<void> {
	const deadline = Date.now() + 120_000
	while (Date.now() < deadline) {
		if (await capture()) return
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
	throw new Error(`Timed out waiting for ${description}`)
}

export async function run(): Promise<void> {
	const runDirectory = process.env.HEAP_RUN_DIR
	const aimockUrl = process.env.AIMOCK_URL
	if (!runDirectory || !aimockUrl) throw new Error("HEAP_RUN_DIR and AIMOCK_URL are required")
	// The isolated host only needs the local model. Keep background catalogs and
	// authentication traffic from adding timing-dependent data to the webview.
	const originalFetch = globalThis.fetch
	globalThis.fetch = async (input, init) => {
		const url = typeof input === "string" || input instanceof URL ? String(input) : input.url
		return new URL(url).origin === new URL(aimockUrl).origin
			? originalFetch(input, init)
			: new Response("{}", { status: 503, statusText: "Heap benchmark: external network disabled" })
	}
	try {
		await runScene(runDirectory, aimockUrl)
	} finally {
		globalThis.fetch = originalFetch
	}
}

async function runScene(runDirectory: string, aimockUrl: string): Promise<void> {
	const storage = path.join(runDirectory, "storage")
	await vscode.workspace
		.getConfiguration("zoo-code")
		.update("customStoragePath", storage, vscode.ConfigurationTarget.Global)
	const extension = vscode.extensions.getExtension<RooCodeTestAPI>("ZooCodeOrganization.zoo-code")
	if (!extension) throw new Error("Zoo Code extension not found")
	const api = extension.isActive ? extension.exports : await extension.activate()
	await vscode.commands.executeCommand("zoo-code.SidebarProvider.focus")
	await poll(async () => api.isReady(), "webview activation")
	const configuration = {
		apiProvider: providerIdentifiers.openrouter,
		lastShownAnnouncementId: api.getLatestAnnouncementId(),
		openRouterApiKey: "mock-key",
		openRouterModelId: "openai/gpt-4.1",
		openRouterBaseUrl: `${aimockUrl}/v1`,
		telemetrySetting: "disabled" as const,
		enableCheckpoints: false,
	}
	await api.setConfiguration(configuration)
	const exists = (name: string) =>
		fs.access(path.join(runDirectory, name)).then(
			() => true,
			() => false,
		)
	if (process.env.HEAP_PHASE === "seed") {
		const createTask = async (marker: string) => {
			const taskId = await api.startNewTask({
				text: marker,
				configuration: { mode: "ask", autoApprovalEnabled: true },
			})
			await poll(() => api.hasTaskUiMessageText(taskId, `${marker}_COMPLETED`), marker)
			await api.clearCurrentTask()
			return taskId
		}
		const smallTaskId = await createTask(SMALL_TASK_MARKER)
		const largeTaskId = await createTask("HEAP_TRANSCRIPT_SEED")
		await fs.writeFile(path.join(runDirectory, "seed.ready"), JSON.stringify({ largeTaskId, smallTaskId }))
		await poll(() => exists("seed.close"), "seed shutdown")
		return
	}
	const { largeTaskId, smallTaskId } = JSON.parse(
		await fs.readFile(path.join(runDirectory, "seed.ready"), "utf8"),
	) as { largeTaskId: string; smallTaskId: string }
	const resume = async (taskId: string) => {
		let ready = false
		const listener = (event: { taskId: string; message: ClineMessage }) => {
			if (
				event.taskId === taskId &&
				(event.message.ask === "resume_completed_task" || event.message.ask === "resume_task") &&
				event.message.partial !== true
			)
				ready = true
		}
		api.on(RooCodeEventName.Message, listener)
		try {
			await api.resumeTask(taskId)
			await poll(async () => ready, `resumed task ${taskId}`)
			// Exercise a normal full-state refresh after hydration, and after the
			// switch let React commit the small task again before measuring retention.
			await api.setConfiguration(configuration)
		} finally {
			api.off(RooCodeEventName.Message, listener)
		}
	}
	const stage = async (name: string, action: () => Promise<void>) => {
		await action()
		await fs.writeFile(path.join(runDirectory, `${name}.ready`), JSON.stringify({ largeTaskId, smallTaskId }))
		await poll(() => exists(`${name}.continue`), `${name} measurement`)
	}
	if (api.getCurrentTaskStack().length) throw new Error("Measurement must begin without an active task")
	await stage("empty", async () => {})
	await stage("loaded", () => resume(largeTaskId))
	await stage("switched", () => resume(smallTaskId))
	await fs.writeFile(path.join(runDirectory, "done"), "done")
	await poll(() => exists("close"), "benchmark shutdown")
}
