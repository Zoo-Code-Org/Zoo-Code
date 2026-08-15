import * as assert from "assert"
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
		const historyItem = await api.getTaskHistoryItem(taskId)
		assert.ok(historyItem, "Completed task should have a history item")
		assert.ok(historyItem.task.includes("RESTART_PERSISTENCE_SMOKE"), "History title should include the marker")
		const conversationLength = await api.getTaskApiConversationHistoryLength(taskId)
		assert.ok(conversationLength > 0, "Completed task should persist API conversation history")

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
	try {
		const createResult = await readPhaseResult(getResultsDir(), "create")
		assert.strictEqual(createResult.status, "passed")
		const taskId = createResult.values?.taskId
		assert.ok(taskId, "Create phase should record a task ID")

		await waitFor(() => api.isReady())
		assert.strictEqual(await api.isTaskInHistory(taskId), true, "Task should be present after restart")
		const historyItem = await api.getTaskHistoryItem(taskId)
		assert.ok(historyItem, "Task history item should be available after restart")
		assert.ok(historyItem.task.includes("RESTART_PERSISTENCE_SMOKE"), "History title should persist after restart")
		const conversationLength = await api.getTaskApiConversationHistoryLength(taskId)
		assert.ok(conversationLength > 0, "API conversation history should be available after restart")

		await writePhaseResult(getResultsDir(), {
			version: PHASE_RESULT_VERSION,
			phase: "verify",
			status: "passed",
			values: { taskId, conversationLength: String(conversationLength) },
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
	}
}

suite("Restart persistence", () => {
	test("persists completed task across a fresh extension host", async () => {
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
