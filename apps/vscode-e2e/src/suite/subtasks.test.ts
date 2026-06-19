import * as assert from "assert"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor, waitUntilCompleted } from "./utils"
import {
	SUBTASK_CHILD_FOLLOWUP_ANSWER,
	SUBTASK_FAST_PARENT_PROMPT,
	SUBTASK_PARENT_PROMPT,
	SUBTASK_XPROFILE_DIFFERENT_CHILD_RESULT,
	SUBTASK_XPROFILE_PARENT_PROMPT,
	SUBTASK_XPROFILE_PARENT_RESULT,
	SUBTASK_XPROFILE_SAME_CHILD_RESULT,
} from "../fixtures/subtasks"

suite("Roo Code Subtasks", function () {
	setDefaultSuiteTimeout(this)

	test("child completing on its first response returns to parent", async () => {
		const api = globalThis.api
		const says: Record<string, ClineMessage[]> = {}

		const messageHandler = ({ taskId, message }: { taskId: string; message: ClineMessage }) => {
			if (message.type === "say" && message.partial === false) {
				says[taskId] = says[taskId] || []
				says[taskId].push(message)
			}
		}

		api.on(RooCodeEventName.Message, messageHandler)

		try {
			const parentTaskId = await waitUntilCompleted({
				api,
				start: () =>
					api.startNewTask({
						configuration: {
							mode: "ask",
							alwaysAllowModeSwitch: true,
							alwaysAllowSubtasks: true,
							autoApprovalEnabled: true,
							enableCheckpoints: false,
						},
						text: SUBTASK_FAST_PARENT_PROMPT,
					}),
			})

			assert.ok(
				Object.entries(says).some(
					([taskId, messages]) =>
						taskId !== parentTaskId &&
						messages.some(
							({ say, text }) => say === "completion_result" && text?.trim() === "Fast child completed",
						),
				),
				"Immediately-completing child should emit its expected result",
			)
			assert.strictEqual(
				says[parentTaskId]
					?.filter(({ say }) => say === "completion_result")
					.map(({ text }) => text?.trim())
					.find((text): text is string => !!text),
				"Fast parent resumed",
				"Parent should resume after the child completes on its first response",
			)
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
			while (api.getCurrentTaskStack().length > 0) {
				await api.clearCurrentTask()
			}
		}
	})

	// Smoke: child completing normally must resume the parent task.
	test("child task returns to parent after normal completion", async () => {
		const api = globalThis.api
		const asks: Record<string, ClineMessage[]> = {}
		const says: Record<string, ClineMessage[]> = {}

		const messageHandler = ({ taskId, message }: { taskId: string; message: ClineMessage }) => {
			if (message.type === "ask") {
				asks[taskId] = asks[taskId] || []
				asks[taskId].push(message)
			}
			if (message.type === "say" && message.partial === false) {
				says[taskId] = says[taskId] || []
				says[taskId].push(message)
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

			// Wait for child to spawn.
			let childTaskId: string | undefined
			await waitFor(() => {
				const stack = api.getCurrentTaskStack()
				const current = stack[stack.length - 1]
				if (current && current !== parentTaskId) {
					childTaskId = current
					return true
				}
				return false
			})

			// Wait for the child's followup question, then answer so it can complete.
			// Register the completion listener before sending the answer to avoid a race.
			await waitFor(() => asks[childTaskId!]?.some(({ ask }) => ask === "followup") ?? false)
			await waitUntilCompleted({
				api,
				start: async () => {
					await api.sendMessage(SUBTASK_CHILD_FOLLOWUP_ANSWER)
					return parentTaskId
				},
			})

			const parentCompletionText = says[parentTaskId]
				?.filter(({ say }) => say === "completion_result")
				.map(({ text }) => text?.trim())
				.find((t): t is string => !!t)

			assert.strictEqual(
				parentCompletionText,
				"Parent task resumed",
				"Parent should complete with the expected result after child returns",
			)
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
			// Drain the stack so partially-completed tasks don't leak into the next test.
			// On the happy path the parent is already gone; on failure both tasks may still be active.
			if (api.getCurrentTaskStack().length > 0) {
				await api.clearCurrentTask()
			}
			if (api.getCurrentTaskStack().length > 0) {
				await api.clearCurrentTask()
			}
			await waitFor(() => api.getCurrentTaskStack().length === 0).catch(() => {})
		}
	})

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

	test("same-profile child returns before a different-profile child", async () => {
		const api = globalThis.api
		const says: Record<string, ClineMessage[]> = {}

		const messageHandler = ({ taskId, message }: { taskId: string; message: ClineMessage }) => {
			if (message.type === "say" && message.partial === false) {
				says[taskId] = says[taskId] || []
				says[taskId].push(message)
			}
		}

		api.on(RooCodeEventName.Message, messageHandler)

		const aimockUrl = process.env.AIMOCK_URL
		const parentProfile = {
			apiProvider: "openrouter" as const,
			openRouterApiKey: "mock-key",
			openRouterModelId: "openai/gpt-4.1",
			rateLimitSeconds: 0,
			...(aimockUrl && { openRouterBaseUrl: `${aimockUrl}/v1` }),
		}
		const childProfile = {
			...parentProfile,
			openRouterModelId: "openai/gpt-4.1-mini",
		}
		const priorModeApiConfigs = api.getConfiguration().modeApiConfigs ?? {}
		const parentProfileId = await api.upsertProfile("subtask-parent-profile", parentProfile, true)
		const childProfileId = await api.upsertProfile("subtask-child-profile", childProfile, false)
		await api.setConfiguration({
			modeApiConfigs: {
				code: parentProfileId!,
				ask: childProfileId!,
			},
		})

		try {
			let parentTaskId: string
			try {
				parentTaskId = await waitUntilCompleted({
					api,
					start: () =>
						api.startNewTask({
							configuration: {
								mode: "code",
								alwaysAllowModeSwitch: true,
								alwaysAllowSubtasks: true,
								autoApprovalEnabled: true,
								enableCheckpoints: false,
							},
							text: SUBTASK_XPROFILE_PARENT_PROMPT,
						}),
				})
			} catch (error) {
				const messageSummary = Object.fromEntries(
					Object.entries(says).map(([taskId, messages]) => [
						taskId,
						messages.map(({ say, text }) => ({ say, text: text?.slice(0, 200) })),
					]),
				)
				throw new Error(
					`Sequential cross-profile subtasks did not complete. Stack: ${JSON.stringify(api.getCurrentTaskStack())}; ` +
						`messages: ${JSON.stringify(messageSummary)}`,
					{ cause: error },
				)
			}

			const sameProfileChildId = Object.entries(says).find(
				([taskId, messages]) =>
					taskId !== parentTaskId &&
					messages.some(
						({ say, text }) =>
							say === "completion_result" && text?.trim() === SUBTASK_XPROFILE_SAME_CHILD_RESULT,
					),
			)?.[0]
			const differentProfileChildId = Object.entries(says).find(
				([taskId, messages]) =>
					taskId !== parentTaskId &&
					messages.some(
						({ say, text }) =>
							say === "completion_result" && text?.trim() === SUBTASK_XPROFILE_DIFFERENT_CHILD_RESULT,
					),
			)?.[0]

			assert.ok(sameProfileChildId, "Same-profile child should return to the parent")
			assert.ok(differentProfileChildId, "Different-profile child should return to the parent")
			assert.notStrictEqual(
				sameProfileChildId,
				differentProfileChildId,
				"Parent should delegate to two distinct child tasks",
			)
			assert.strictEqual(
				says[parentTaskId]
					?.filter(({ say }) => say === "completion_result")
					.map(({ text }) => text?.trim())
					.find((text): text is string => !!text),
				SUBTASK_XPROFILE_PARENT_RESULT,
				"Parent should resume after both sequential children complete",
			)
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
			await api.setConfiguration({ modeApiConfigs: priorModeApiConfigs })
			await api.deleteProfile("subtask-child-profile").catch(() => {})
			await api.deleteProfile("subtask-parent-profile").catch(() => {})
			while (api.getCurrentTaskStack().length > 0) {
				await api.clearCurrentTask()
			}
		}
	})
})
