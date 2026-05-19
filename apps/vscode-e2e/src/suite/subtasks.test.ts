import * as assert from "assert"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { sleep, waitFor, waitUntilCompleted } from "./utils"
import { SUBTASK_CHILD_FOLLOWUP_ANSWER, SUBTASK_PARENT_PROMPT } from "../fixtures/subtasks"

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

		const findCompletionText = (taskId: string) =>
			messages[taskId]
				?.filter(
					(message) =>
						message.type === "say" && (message.say === "completion_result" || message.say === "text"),
				)
				.map((message) => message.text?.trim())
				.find((text): text is string => !!text)

		const findErrorText = (taskId: string) =>
			messages[taskId]
				?.filter((message) => message.type === "say" && message.say === "error")
				.map((message) => message.text?.trim())
				.find((text): text is string => !!text)

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
			const cancelledChildTaskId = spawnedTaskId!
			const delegatedFollowupCount =
				asks[cancelledChildTaskId]?.filter(({ type, ask }) => type === "ask" && ask === "followup").length ?? 0

			await api.cancelCurrentTask()

			await sleep(2_000)

			assert.ok(
				messages[parentTaskId]?.find(({ type, text }) => type === "say" && text === "Parent task resumed") ===
					undefined,
				"Parent task should not have resumed after subtask cancellation",
			)

			await waitForStage(
				"wait for cancelled child task to remain active",
				() => api.getCurrentTaskStack().at(-1) === cancelledChildTaskId,
			)
			await waitForStage(
				"wait for cancelled child resume ask",
				() =>
					asks[cancelledChildTaskId]?.some(({ type, ask }) => type === "ask" && ask === "resume_task") ??
					false,
			)
			await api.approveCurrentAsk()
			await waitForStage(
				"wait for resumed child followup ask",
				() =>
					(asks[cancelledChildTaskId]?.filter(({ type, ask }) => type === "ask" && ask === "followup")
						.length ?? 0) > delegatedFollowupCount,
			)
			await api.sendMessage(SUBTASK_CHILD_FOLLOWUP_ANSWER)
			await waitUntilCompleted({ api, taskId: cancelledChildTaskId })

			assert.strictEqual(
				findErrorText(cancelledChildTaskId),
				undefined,
				"Cancelled child should not emit an error",
			)
			assert.strictEqual(
				findCompletionText(cancelledChildTaskId),
				"9",
				"Cancelled child should complete with `9`",
			)
			assert.strictEqual(
				api.getCurrentTaskStack().at(-1),
				cancelledChildTaskId,
				"Cancelled child should stay active after resuming from cancellation",
			)

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
