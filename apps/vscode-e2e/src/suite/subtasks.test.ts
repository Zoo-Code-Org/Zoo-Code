import * as assert from "assert"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { sleep, waitFor, waitUntilCompleted } from "./utils"
import {
	SUBTASK_API_HANG_CHILD_RESULT,
	SUBTASK_API_HANG_CHILD_MARKER,
	SUBTASK_API_HANG_PARENT_MARKER,
	SUBTASK_API_HANG_PARENT_PROMPT,
	SUBTASK_API_HANG_PARENT_RESULT,
	SUBTASK_API_HANG_RESUME_MESSAGE,
	SUBTASK_CHILD_FOLLOWUP_ANSWER,
	SUBTASK_FAST_PARENT_PROMPT,
	SUBTASK_INTERRUPT_CHILD_FOLLOWUP_ANSWER,
	SUBTASK_INTERRUPT_PARENT_PROMPT,
	SUBTASK_INTERRUPT_PARENT_RESULT,
	SUBTASK_PARENT_PROMPT,
	SUBTASK_XPROFILE_DIFFERENT_CHILD_RESULT,
	SUBTASK_XPROFILE_PARENT_PROMPT,
	SUBTASK_XPROFILE_PARENT_RESULT,
	SUBTASK_XPROFILE_SAME_CHILD_RESULT,
} from "../fixtures/subtasks"

type AimockMessageContent = string | Array<{ type?: string; text?: string }>

type AimockJournalEntry = {
	body?: {
		messages?: Array<{
			role?: string
			content?: AimockMessageContent
		}>
	}
}

const messageContentText = (content?: AimockMessageContent) => {
	if (typeof content === "string") {
		return content
	}

	return content?.map((part) => part.text ?? "").join("") ?? ""
}

const waitForAimockRequestContaining = async (expectedText: string, excludeText?: string) => {
	const aimockUrl = process.env.AIMOCK_URL
	assert.ok(aimockUrl, "AIMOCK_URL must be set for aimock journal assertions")

	await waitFor(async () => {
		const response = await fetch(`${aimockUrl}/__aimock/journal`)
		const entries = (await response.json()) as AimockJournalEntry[]

		return entries.some((entry) => {
			const messages = entry.body?.messages
			if (!messages) return false
			const entryText = messages.map((m) => messageContentText(m.content)).join("")
			if (excludeText && entryText.includes(excludeText)) return false
			return messages.some(
				(message) => message.role === "user" && messageContentText(message.content).includes(expectedText),
			)
		})
	})
}

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
			await sleep(1_500)
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

	test("delegated child completion persists parent and child history state", async () => {
		const api = globalThis.api
		const asks: Record<string, ClineMessage[]> = {}
		const says: Record<string, ClineMessage[]> = {}

		let delegationCompletedParentId: string | undefined
		let delegationCompletedChildId: string | undefined
		let delegationCompletedSummary: string | undefined

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

		const delegationCompletedHandler = (parentId: string, childId: string, summary: string) => {
			delegationCompletedParentId = parentId
			delegationCompletedChildId = childId
			delegationCompletedSummary = summary
		}

		api.on(RooCodeEventName.Message, messageHandler)
		api.on(RooCodeEventName.TaskDelegationCompleted, delegationCompletedHandler)

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

			await waitFor(() => asks[childTaskId!]?.some(({ ask }) => ask === "followup") ?? false)

			// Send the answer, then wait for TaskDelegationCompleted. That event fires after
			// atomicUpdatePair writes the persisted history but before the parent is re-created,
			// so it is the right gate for history assertions. waitUntilCompleted alone is not
			// sufficient because the resumed parent runs into a mock 404 and never emits
			// TaskCompleted in the test environment.
			await api.sendMessage(SUBTASK_CHILD_FOLLOWUP_ANSWER)
			await waitFor(() => delegationCompletedParentId !== undefined)

			assert.strictEqual(
				delegationCompletedParentId,
				parentTaskId,
				"TaskDelegationCompleted should fire for parent",
			)
			assert.strictEqual(delegationCompletedChildId, childTaskId, "TaskDelegationCompleted should fire for child")
			assert.strictEqual(delegationCompletedSummary, "9", "TaskDelegationCompleted summary should be '9'")

			const parent = await api.getTaskHistoryItem(parentTaskId)
			assert.ok(parent, "Parent history item should exist")
			assert.strictEqual(parent.status, "active", "Parent status should be 'active' after child completes")
			assert.strictEqual(parent.awaitingChildId, undefined, "Parent awaitingChildId should be cleared")
			assert.strictEqual(parent.delegatedToId, undefined, "Parent delegatedToId should be cleared")
			assert.strictEqual(parent.completedByChildId, childTaskId, "Parent completedByChildId should be the child")
			assert.strictEqual(parent.completionResultSummary, "9", "Parent completionResultSummary should be '9'")
			assert.ok(parent.childIds?.includes(childTaskId!), "Parent childIds should include the child")

			const child = await api.getTaskHistoryItem(childTaskId!)
			assert.ok(child, "Child history item should exist")
			assert.strictEqual(child.status, "completed", "Child status should be 'completed'")
			assert.strictEqual(child.parentTaskId, parentTaskId, "Child parentTaskId should point to parent")
			assert.strictEqual(child.completionResultSummary, "9", "Child completionResultSummary should be '9'")
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
			api.off(RooCodeEventName.TaskDelegationCompleted, delegationCompletedHandler)
			// TaskDelegationCompleted fires before createTaskWithHistoryItem completes,
			// so the reopened parent may not be on the stack yet. Wait for it to appear
			// before draining, otherwise the next test sees a late-rehydrated stray task.
			if (delegationCompletedParentId) {
				await waitFor(
					() =>
						api.getCurrentTaskStack().length > 0 ||
						api.getCurrentTaskStack().includes(delegationCompletedParentId!),
				).catch(() => {})
			}
			while (api.getCurrentTaskStack().length > 0) {
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
	// Before issue #560 was fixed, a cancelled child would have its parent link severed on cancel, so
	// it would complete in-place without reopening the parent. The correct behavior (post-fix) is that
	// the cancelled child is marked "interrupted", and when it resumes and completes it reopens the parent.
	test("cancelled child completes and reopens parent", async () => {
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
			await waitFor(async () => (await api.getTaskApiConversationHistoryLength(spawnedTaskId!)) > 0)

			const cancelledChildTaskId = spawnedTaskId!
			await api.cancelCurrentTask()

			await waitFor(() => api.getCurrentTaskStack().at(-1) === cancelledChildTaskId)
			await waitFor(
				() =>
					asks[cancelledChildTaskId]?.some(({ type, ask }) => type === "ask" && ask === "resume_task") ??
					false,
			)

			// Resume the child — it should complete and reopen the parent (fix for #560)
			const completedTaskId = await waitUntilCompleted({
				api,
				start: async () => {
					await api.sendMessage(SUBTASK_CHILD_FOLLOWUP_ANSWER)
					return parentTaskId
				},
			})

			assert.strictEqual(
				completedTaskId,
				parentTaskId,
				"Parent task should complete after interrupted child reports back",
			)
			assert.strictEqual(
				says[parentTaskId]?.find(({ say }) => say === "completion_result")?.text?.trim(),
				"Parent task resumed",
				"Parent task should complete with its expected result",
			)
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
		}
	})

	// Issue #566: a child interrupted while its provider request is still pending
	// must keep its parent link when manually resumed and completed.
	test("API-hung interrupted child resumes and returns to parent", async () => {
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
				text: SUBTASK_API_HANG_PARENT_PROMPT,
			})

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

			await waitForAimockRequestContaining(SUBTASK_API_HANG_CHILD_MARKER, SUBTASK_API_HANG_PARENT_MARKER)

			await api.cancelCurrentTask()

			await waitFor(() => api.getCurrentTaskStack().at(-1) === childTaskId)
			await waitFor(
				() => asks[childTaskId!]?.some(({ type, ask }) => type === "ask" && ask === "resume_task") ?? false,
			)

			const interruptedChild = await api.getTaskHistoryItem(childTaskId!)
			assert.strictEqual(interruptedChild?.status, "interrupted", "Child should be interrupted after manual stop")
			assert.strictEqual(
				interruptedChild?.parentTaskId,
				parentTaskId,
				"Interrupted child should retain its parent link before resume",
			)

			const completedParentTaskId = await waitUntilCompleted({
				api,
				start: async () => {
					await api.sendMessage(SUBTASK_API_HANG_RESUME_MESSAGE)
					return parentTaskId
				},
			})

			assert.strictEqual(
				completedParentTaskId,
				parentTaskId,
				"Parent task should complete after API-hung child resumes and reports back",
			)
			assert.strictEqual(
				says[childTaskId!]
					?.filter(({ say }) => say === "completion_result")
					.map(({ text }) => text?.trim())
					.find((text) => text === SUBTASK_API_HANG_CHILD_RESULT),
				SUBTASK_API_HANG_CHILD_RESULT,
				"Child should complete with its expected result after resume",
			)
			assert.strictEqual(
				says[parentTaskId]
					?.filter(({ say }) => say === "completion_result")
					.map(({ text }) => text?.trim())
					.find((text) => text === SUBTASK_API_HANG_PARENT_RESULT),
				SUBTASK_API_HANG_PARENT_RESULT,
				"Parent should resume and complete with its expected result",
			)

			const parent = await api.getTaskHistoryItem(parentTaskId)
			assert.notStrictEqual(parent?.status, "delegated", "Parent history should not remain delegated")
			assert.strictEqual(parent?.awaitingChildId, undefined, "Parent awaitingChildId should be cleared")
			assert.strictEqual(parent?.completedByChildId, childTaskId, "Parent should record completed child")

			const child = await api.getTaskHistoryItem(childTaskId!)
			assert.strictEqual(child?.status, "completed", "Child history should be completed")
			assert.strictEqual(child?.parentTaskId, parentTaskId, "Completed child should still point to parent")
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
			while (api.getCurrentTaskStack().length > 0) {
				await api.clearCurrentTask()
			}
			await waitFor(() => api.getCurrentTaskStack().length === 0).catch(() => {})
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

	// Issue #560: interrupted child resumes and reports back to parent.
	// Before the fix, cancelTask() severed the parent link, so the resumed child
	// fell through to "Start New Task" instead of delegating back to the parent.
	test("interrupted child resumes and reports back to parent", async () => {
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
				text: SUBTASK_INTERRUPT_PARENT_PROMPT,
			})

			// Wait for child to spawn
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

			// Wait for the child's followup question
			await waitFor(() => asks[childTaskId!]?.some(({ ask }) => ask === "followup") ?? false)
			await waitFor(async () => (await api.getTaskApiConversationHistoryLength(childTaskId!)) > 0)

			// Cancel the child — it should be marked "interrupted", parent stays "delegated"
			await api.cancelCurrentTask()

			// Child should be back on the stack (rehydrated as interrupted)
			await waitFor(() => api.getCurrentTaskStack().at(-1) === childTaskId)
			await waitFor(
				() => asks[childTaskId!]?.some(({ type, ask }) => type === "ask" && ask === "resume_task") ?? false,
			)

			// Parent must not have resumed yet
			assert.strictEqual(
				says[parentTaskId]?.find(({ say }) => say === "completion_result"),
				undefined,
				"Parent must not have resumed while child is interrupted",
			)

			// Resume the child and answer the followup — child should complete and reopen parent.
			const completedParentTaskId = await waitUntilCompleted({
				api,
				start: async () => {
					await api.sendMessage(SUBTASK_INTERRUPT_CHILD_FOLLOWUP_ANSWER)
					return parentTaskId
				},
			})

			assert.strictEqual(
				completedParentTaskId,
				parentTaskId,
				"Parent task should be the one that completes after interrupted child reports back",
			)

			assert.strictEqual(
				says[parentTaskId]
					?.filter(({ say }) => say === "completion_result")
					.map(({ text }) => text?.trim())
					.find((text) => text === SUBTASK_INTERRUPT_PARENT_RESULT),
				SUBTASK_INTERRUPT_PARENT_RESULT,
				"Parent should complete with expected result after interrupted child reports back",
			)
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
			while (api.getCurrentTaskStack().length > 0) {
				await api.clearCurrentTask()
			}
			await waitFor(() => api.getCurrentTaskStack().length === 0).catch(() => {})
		}
	})
})
