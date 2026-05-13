import * as assert from "assert"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { sleep, waitFor, waitUntilCompleted } from "./utils"
import { SUBTASK_CHILD_FOLLOWUP_ANSWER, SUBTASK_CHILD_PROMPT, SUBTASK_PARENT_PROMPT } from "../fixtures/subtasks"

suite("Roo Code Subtasks", function () {
	setDefaultSuiteTimeout(this)

	test("Should handle subtask cancellation and resumption correctly", async () => {
		const api = globalThis.api
		const asks: Record<string, ClineMessage[]> = {}
		const messages: Record<string, ClineMessage[]> = {}
		const waitForStage = async (label: string, condition: Parameters<typeof waitFor>[0]) => {
			try {
				await waitFor(condition)
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				throw new Error(`${label}: ${message}`)
			}
		}

		const messageHandler = ({ taskId, message }: { taskId: string; message: ClineMessage }) => {
			if (message.type === "ask") {
				asks[taskId] = asks[taskId] || []
				asks[taskId].push(message)
			}

			if (message.type === "say" && message.partial === false) {
				messages[taskId] = messages[taskId] || []
				messages[taskId].push(message)
			}
		}

		api.on(RooCodeEventName.Message, messageHandler)

		try {
			const parentTaskId = await api.startNewTask({
				configuration: {
					mode: "ask",
					alwaysAllowModeSwitch: true,
					alwaysAllowSubtasks: true,
					autoApprovalEnabled: true,
					enableCheckpoints: false,
				},
				text: SUBTASK_PARENT_PROMPT,
			})

			let spawnedTaskId: string | undefined
			await waitForStage("wait for spawned subtask", () => {
				const currentTaskStack = api.getCurrentTaskStack()
				const currentTaskId = currentTaskStack[currentTaskStack.length - 1]
				if (currentTaskId && currentTaskId !== parentTaskId) {
					spawnedTaskId = currentTaskId
					return true
				}
				return false
			})
			await waitForStage(
				"wait for delegated child followup ask",
				() => asks[spawnedTaskId!]?.some(({ type, ask }) => type === "ask" && ask === "followup") ?? false,
			)

			await api.cancelCurrentTask()

			await sleep(2_000)

			assert.ok(
				messages[parentTaskId]?.find(({ type, text }) => type === "say" && text === "Parent task resumed") ===
					undefined,
				"Parent task should not have resumed after subtask cancellation",
			)

			const anotherTaskId = await api.startNewTask({ text: SUBTASK_CHILD_PROMPT })
			await waitForStage(
				"wait for standalone child followup ask",
				() => asks[anotherTaskId]?.some(({ type, ask }) => type === "ask" && ask === "followup") ?? false,
			)
			await api.sendMessage(SUBTASK_CHILD_FOLLOWUP_ANSWER)
			await waitUntilCompleted({ api, taskId: anotherTaskId })

			await sleep(2_000)

			assert.ok(
				messages[parentTaskId]?.find(({ type, text }) => type === "say" && text === "Parent task resumed") ===
					undefined,
				"Parent task should not have resumed after subtask cancellation",
			)

			await api.clearCurrentTask()
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}
	})
})
