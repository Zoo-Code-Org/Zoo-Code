import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import { RooCodeEventName, type RooCodeAPI } from "@roo-code/types"

import {
	PHASE_RESULT_VERSION,
	readPhaseResult,
	serializePhaseError,
	type PhaseResult,
	writePhaseResult,
} from "../restart/phaseProtocol"
import { waitFor, waitUntilCompleted } from "./utils"

const SCENARIO = "restart-persistence"
const MARKER = "RESTART_PERSISTENCE_MARKER"

function getResultsDir(): string {
	const resultsDir = process.env.E2E_RESULTS_DIR
	if (!resultsDir) throw new Error("E2E_RESULTS_DIR is required")
	return resultsDir
}

async function quitGracefully(): Promise<void> {
	await vscode.commands.executeCommand("workbench.action.quit")
}

async function waitForMarkedCompletion(api: RooCodeAPI, taskId: string): Promise<void> {
	await waitFor(() =>
		api.hasTaskApiConversationHistorySequence(taskId, {
			userText: "RESTART_PERSISTENCE_SMOKE",
			assistantToolName: "attempt_completion",
			assistantToolInputText: MARKER,
		}),
	)
}

async function runCreate(api: RooCodeAPI): Promise<void> {
	let taskId: string | undefined
	let createPhasePassed = false
	let sawMarker = false
	const messageHandler = ({ message }: { message: { type: string; text?: string; partial?: boolean } }) => {
		if (message.type === "say" && message.partial === false && message.text?.includes(MARKER)) {
			sawMarker = true
		}
	}
	api.on(RooCodeEventName.Message, messageHandler)

	try {
		taskId = await api.startNewTask({
			configuration: { mode: "ask", alwaysAllowModeSwitch: true, autoApprovalEnabled: true },
			text: `${SCENARIO}: RESTART_PERSISTENCE_SMOKE`,
		})
		await waitUntilCompleted({ api, taskId })
		assert.strictEqual(sawMarker, true, `Completion should include ${MARKER}`)

		// TaskCompleted fires before the final saveClineMessages() write is
		// necessarily durable on disk. Wait until the completion marker is
		// persisted in ui_messages.json before quitting, so the verify phase
		// never reads a task directory whose final write has not landed yet.
		const createdTaskId: string = taskId
		await waitFor(() => api.hasTaskUiMessageText(createdTaskId, MARKER))
		const globalStoragePath = process.env.E2E_GLOBAL_STORAGE_PATH
		if (!globalStoragePath) throw new Error("E2E_GLOBAL_STORAGE_PATH is required")
		// The public history API reads the cache; check the committed file
		// before quitting so the fresh host has both history and messages.
		await waitFor(async () => {
			try {
				const persisted: unknown = JSON.parse(
					await fs.readFile(
						path.join(globalStoragePath, "tasks", createdTaskId, "history_item.json"),
						"utf8",
					),
				)
				return (
					typeof persisted === "object" &&
					persisted !== null &&
					"id" in persisted &&
					persisted.id === createdTaskId
				)
			} catch {
				return false
			}
		})

		const result: PhaseResult = {
			version: PHASE_RESULT_VERSION,
			phase: "create",
			status: "passed",
			values: { taskId },
		}
		await writePhaseResult(getResultsDir(), result)
		createPhasePassed = true
		await quitGracefully()
	} catch (error) {
		await writePhaseResult(getResultsDir(), {
			version: PHASE_RESULT_VERSION,
			phase: "create",
			status: "failed",
			error: serializePhaseError(error),
		})
		throw error
	} finally {
		api.off(RooCodeEventName.Message, messageHandler)
		if (!createPhasePassed && taskId && api.getCurrentTaskStack().includes(taskId)) await api.cancelCurrentTask()
	}
}

async function runVerify(api: RooCodeAPI): Promise<void> {
	const taskMessages: Array<{ type: string; ask?: string }> = []
	const messageHandler = ({ taskId, message }: { taskId: string; message: (typeof taskMessages)[number] }) => {
		if (taskId === verifiedTaskId) taskMessages.push(message)
	}
	let verifiedTaskId: string | undefined
	try {
		const createResult = await readPhaseResult(getResultsDir(), "create")
		assert.strictEqual(createResult.status, "passed")
		const taskId = createResult.values?.taskId
		assert.ok(taskId, "Create phase should record a task ID")
		verifiedTaskId = taskId
		api.on(RooCodeEventName.Message, messageHandler)

		await waitFor(() => api.isReady())
		assert.strictEqual(await api.isTaskInHistory(taskId), true, "Task should be present after restart")
		const historyItem = await api.getTaskHistoryItem(taskId)
		assert.ok(historyItem, "Task history item should be available after restart")
		assert.ok(historyItem.task.includes("RESTART_PERSISTENCE_SMOKE"), "History title should persist after restart")

		// No task is running in this fresh host yet. Recreate the on-disk
		// state left by an interrupted two-step replacement, then require
		// public reads to recover it before resume can write anything.
		const globalStoragePath = process.env.E2E_GLOBAL_STORAGE_PATH
		if (!globalStoragePath) throw new Error("E2E_GLOBAL_STORAGE_PATH is required")
		const taskDir = path.join(globalStoragePath, "tasks", taskId)
		const interruptedFiles = []
		for (const file of ["ui_messages.json", "api_conversation_history.json"]) {
			const canonical = path.join(taskDir, file)
			const backup = path.join(taskDir, `.${file}.bak_restart_e2e.tmp`)
			const committed = await fs.readFile(canonical, "utf8")
			await fs.rename(canonical, backup)
			interruptedFiles.push({ canonical, backup, committed })
		}
		assert.strictEqual(await api.hasTaskUiMessageText(taskId, MARKER), true, "Read should recover the UI marker")
		await waitForMarkedCompletion(api, taskId)
		for (const { canonical, backup, committed } of interruptedFiles) {
			assert.strictEqual(
				await fs.readFile(canonical, "utf8"),
				committed,
				"Read recovery must retain committed bytes",
			)
			await assert.rejects(fs.access(backup), { code: "ENOENT" }, "Recovery should consume the backup")
		}

		await api.resumeTask(taskId)
		await waitFor(() => taskMessages.some(({ type, ask }) => type === "ask" && ask === "resume_completed_task"))
		assert.strictEqual(await api.isTaskInHistory(taskId), true, "Reopened task should remain in history")
		const reopenedHistoryItem = await api.getTaskHistoryItem(taskId)
		assert.ok(reopenedHistoryItem, "Reopened task should retain its history item")
		assert.ok(
			reopenedHistoryItem.task.includes("RESTART_PERSISTENCE_SMOKE"),
			"Reopened task should retain its persisted history title",
		)
		await waitForMarkedCompletion(api, taskId)

		await writePhaseResult(getResultsDir(), {
			version: PHASE_RESULT_VERSION,
			phase: "verify",
			status: "passed",
			values: { taskId },
		})
		await quitGracefully()
	} catch (error) {
		await writePhaseResult(getResultsDir(), {
			version: PHASE_RESULT_VERSION,
			phase: "verify",
			status: "failed",
			error: serializePhaseError(error),
		})
		throw error
	} finally {
		api.off(RooCodeEventName.Message, messageHandler)
	}
}

suite("Restart persistence", () => {
	test("persists and recovers completed task history across a fresh extension host", async () => {
		const api = globalThis.api
		if (process.env.E2E_PHASE === "create") {
			await runCreate(api)
		} else if (process.env.E2E_PHASE === "verify") {
			await runVerify(api)
		} else {
			throw new Error(`Unknown E2E_PHASE: ${process.env.E2E_PHASE ?? "unset"}`)
		}
	})
})
