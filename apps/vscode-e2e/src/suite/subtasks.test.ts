import * as assert from "assert"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor, waitUntilCompleted } from "./utils"
import { SUBTASK_CHILD_FOLLOWUP_ANSWER, SUBTASK_PARENT_PROMPT } from "../fixtures/subtasks"

suite("Roo Code Subtasks", function () {
	setDefaultSuiteTimeout(this)

	// Race mitigation: skipDelegationRepair prevents removeClineFromStack from
	// auto-resuming the parent when the child is cancelled (Race 2).
	test("parent stays paused after subtask cancellation", async () => {
		const api = globalThis.api
		const asks: Record<string, ClineMessage[]> = {}
		const messages: Record<string, ClineMessage[]> = {}

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
			await waitFor(() => {
				const stack = api.getCurrentTaskStack()
				const current = stack[stack.length - 1]
				if (current && current !== parentTaskId) {
					spawnedTaskId = current
					return true
				}
				return false
			})

			await waitFor(
				() => asks[spawnedTaskId!]?.some(({ type, ask }) => type === "ask" && ask === "followup") ?? false,
			)

			await api.cancelCurrentTask()

			assert.ok(
				messages[parentTaskId]?.find(({ type, text }) => type === "say" && text === "Parent task resumed") ===
					undefined,
				"Parent task should not have resumed after subtask cancellation",
			)

			await waitFor(() => api.getCurrentTaskStack().at(-1) === spawnedTaskId)
			await waitFor(
				() => asks[spawnedTaskId!]?.some(({ type, ask }) => type === "ask" && ask === "resume_task") ?? false,
			)

			await api.clearCurrentTask()
			// The parent task is still in the stack; drain it so it doesn't leak into the next test.
			await api.clearCurrentTask()
			await waitFor(() => api.getCurrentTaskStack().length === 0)
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}
	})

	// Race mitigation: runDelegationTransition lock + cancelledDelegationChildIds guard
	// ensures cancelTask() wins over a concurrent reopenParentFromDelegation() (Race 3).
	test("cancelled child completes in-place and does not reopen parent", async () => {
		const api = globalThis.api
		const asks: Record<string, ClineMessage[]> = {}
		const messages: Record<string, ClineMessage[]> = {}

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
			await waitFor(() => {
				const stack = api.getCurrentTaskStack()
				const current = stack[stack.length - 1]
				if (current && current !== parentTaskId) {
					spawnedTaskId = current
					return true
				}
				return false
			})

			await waitFor(
				() => asks[spawnedTaskId!]?.some(({ type, ask }) => type === "ask" && ask === "followup") ?? false,
			)

			const cancelledChildTaskId = spawnedTaskId!
			await api.cancelCurrentTask()

			await waitFor(() => api.getCurrentTaskStack().at(-1) === cancelledChildTaskId)
			await waitFor(
				() =>
					asks[cancelledChildTaskId]?.some(({ type, ask }) => type === "ask" && ask === "resume_task") ??
					false,
			)

			const resumedChildTaskId = await waitUntilCompleted({
				api,
				start: async () => {
					await api.sendMessage(SUBTASK_CHILD_FOLLOWUP_ANSWER)
					return cancelledChildTaskId
				},
			})

			assert.strictEqual(
				resumedChildTaskId,
				cancelledChildTaskId,
				"Cancelled child task should be resumed in place",
			)
			assert.strictEqual(
				findErrorText(resumedChildTaskId),
				undefined,
				"Resumed child task should not emit an error",
			)
			assert.strictEqual(
				findCompletionText(resumedChildTaskId),
				"9",
				"Resumed child task should complete with `9`",
			)
			assert.strictEqual(
				api.getCurrentTaskStack().at(-1),
				cancelledChildTaskId,
				"Cancelled child task should remain the active completed task",
			)
			assert.ok(
				messages[parentTaskId]?.find(({ type, text }) => type === "say" && text === "Parent task resumed") ===
					undefined,
				"Parent task should not have resumed after the cancelled child completed",
			)

			await api.clearCurrentTask()
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}
	})
})
