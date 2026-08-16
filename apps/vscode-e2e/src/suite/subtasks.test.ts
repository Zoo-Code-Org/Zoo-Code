import * as assert from "assert"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { sleep, waitFor, waitUntilCompleted } from "./utils"
import {
	SCHED_COMPLETED_PROMPT,
	SCHED_COMPLETED_RESULT,
	SCHED_STANDALONE_FOLLOWUP_ANSWER,
	SCHED_STANDALONE_PROMPT,
	SUBTASK_ABANDON_CHILD_FOLLOWUP_ANSWER,
	SUBTASK_ABANDON_PARENT_PROMPT,
	SUBTASK_API_HANG_CHILD_MARKER,
	SUBTASK_API_HANG_CHILD_RESULT,
	SUBTASK_API_HANG_PARENT_MARKER,
	SUBTASK_API_HANG_PARENT_PROMPT,
	SUBTASK_API_HANG_PARENT_RESULT,
	SUBTASK_API_HANG_RESPONSE_LATENCY_MS,
	SUBTASK_API_HANG_RESUME_MESSAGE,
	SUBTASK_CHILD_FOLLOWUP_ANSWER,
	SUBTASK_FAST_CHILD_RESULT,
	SUBTASK_FANOUT_PARENT_FOLLOWUP,
	SUBTASK_FANOUT_PARENT_PROMPT,
	SUBTASK_FANOUT_XPROFILE_CHILD_MODEL,
	SUBTASK_FANOUT_XPROFILE_CHILD_RESULT,
	SUBTASK_FANOUT_XPROFILE_PARENT_FOLLOWUP,
	SUBTASK_FANOUT_XPROFILE_PARENT_MODEL,
	SUBTASK_FANOUT_XPROFILE_PARENT_PROMPT,
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
	timestamp?: number
	body?: {
		model?: string
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

const requestUserText = (entry: AimockJournalEntry) =>
	(entry.body?.messages ?? [])
		.filter((message) => message.role === "user")
		.map((message) => messageContentText(message.content))
		.join("")

const fetchAimockJournal = async () => {
	const aimockUrl = process.env.AIMOCK_URL
	assert.ok(aimockUrl, "AIMOCK_URL must be set for aimock journal assertions")

	const response = await fetch(`${aimockUrl}/__aimock/journal`)
	return (await response.json()) as AimockJournalEntry[]
}

const readAimockJournal = fetchAimockJournal

const findAimockRequest = (entries: AimockJournalEntry[], expectedText: string, excludeText?: string) =>
	entries.find((entry) => {
		const messages = entry.body?.messages
		if (!messages) return false
		const entryText = messages.map((m) => messageContentText(m.content)).join("")
		if (excludeText && entryText.includes(excludeText)) return false
		return messages.some(
			(message) => message.role === "user" && messageContentText(message.content).includes(expectedText),
		)
	})

// Waits for a matching request to appear in the aimock journal and returns its journal
// timestamp, so callers can anchor post-test drains to the exact request this test created.
const waitForAimockRequestContaining = async (
	expectedText: string,
	excludeText?: string,
): Promise<number | undefined> => {
	let matchedAt: number | undefined

	await waitFor(async () => {
		matchedAt = findAimockRequest(await fetchAimockJournal(), expectedText, excludeText)?.timestamp
		return matchedAt !== undefined
	})

	return matchedAt
}

const assertAimockRequest = (entries: AimockJournalEntry[], matches: (entry: AimockJournalEntry) => boolean) => {
	if (entries.some(matches)) return

	const summary = entries.map((entry) => ({
		model: entry.body?.model,
		userText: requestUserText(entry).slice(0, 180),
	}))
	assert.fail(`Expected aimock request was not found. Requests: ${JSON.stringify(summary, null, 2)}`)
}

const waitForAimockRequest = async (matches: (entry: AimockJournalEntry) => boolean) => {
	let latestEntries: AimockJournalEntry[] = []

	try {
		await waitFor(async () => {
			latestEntries = await readAimockJournal()
			return latestEntries.some(matches)
		})
	} catch {
		assertAimockRequest(latestEntries, matches)
	}
}

// Grace period after the delayed window for aimock to flush the stream's remaining chunks to
// the dead socket. 500ms is an empirical margin for that flush plus socket teardown; if this
// suite becomes flaky again on slow CI runners, widen this value first.
const SUBTASK_API_HANG_DRAIN_GRACE_MS = 500

// aimock does not observe client disconnects: after the API-hang child request is cancelled,
// the mock keeps the delayed stream pending server-side until the fixture's ttft has fully
// elapsed, then flushes the remaining chunks to the dead socket. A streamed request opened by
// the next test can interleave with that late flush, so wait out the remainder of the delayed
// window before the next test runs. The deadline is anchored to the journal timestamp of the
// request this test created (never earlier traffic), and bounded by one latency window plus
// grace, so it cannot hide a genuine hang.
const waitForDelayedSubtaskStreamDrain = async (delayedRequestStartedAt: number | undefined) => {
	if (delayedRequestStartedAt === undefined) {
		// The delayed request never reached the mock (the test failed before cancelling
		// an in-flight request), so there is no delayed stream to drain.
		return
	}

	const drainDeadlineMs =
		delayedRequestStartedAt + SUBTASK_API_HANG_RESPONSE_LATENCY_MS + SUBTASK_API_HANG_DRAIN_GRACE_MS
	const remainingMs = drainDeadlineMs - Date.now()

	if (remainingMs > 0) {
		await sleep(remainingMs)
	}
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
							({ say, text }) =>
								say === "completion_result" && text?.trim() === SUBTASK_FAST_CHILD_RESULT,
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

	test("fan-out keeps parent executing while child request is in flight", async () => {
		const api = globalThis.api
		const asks: Record<string, ClineMessage[]> = {}

		const messageHandler = ({ taskId, message }: { taskId: string; message: ClineMessage }) => {
			if (message.type === "ask") {
				asks[taskId] = asks[taskId] || []
				asks[taskId].push(message)
			}
		}

		api.on(RooCodeEventName.Message, messageHandler)

		try {
			api.setTaskSchedulerMaxConcurrency(2)

			const parentTaskId = await api.startNewTask({
				configuration: {
					mode: "ask",
					alwaysAllowModeSwitch: true,
					alwaysAllowSubtasks: true,
					autoApprovalEnabled: true,
					enableCheckpoints: false,
				},
				text: SUBTASK_FANOUT_PARENT_PROMPT,
			})

			let childTaskId: string | undefined
			await waitFor(() => {
				const stack = api.getCurrentTaskStack()
				const current = stack.at(-1)
				if (current && current !== parentTaskId) {
					childTaskId = current
					return stack.includes(parentTaskId)
				}
				return false
			})

			await waitFor(() =>
				(asks[parentTaskId] ?? []).some(
					({ ask, text }) => ask === "followup" && text?.includes(SUBTASK_FANOUT_PARENT_FOLLOWUP),
				),
			)

			const stack = api.getCurrentTaskStack()
			assert.ok(stack.includes(parentTaskId), "Fan-out parent should remain in the live task stack")
			assert.ok(stack.includes(childTaskId!), "Fan-out child should remain in the live task stack")
			assert.strictEqual(stack.at(-1), childTaskId, "Child should remain the focused task while parent runs")

			const parentHistory = await api.getTaskHistoryItem(parentTaskId)
			assert.strictEqual(parentHistory?.status, "delegated", "Fan-out parent history should stay delegated")
			assert.strictEqual(
				parentHistory?.awaitingChildId,
				childTaskId,
				"Fan-out parent history should point at the running child",
			)
			assert.strictEqual(
				parentHistory?.delegatedToId,
				childTaskId,
				"Fan-out parent history should record the delegated child",
			)
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
			while (api.getCurrentTaskStack().length > 0) {
				await api.clearCurrentTask()
			}
			api.setTaskSchedulerMaxConcurrency(1)
			await waitFor(() => api.getCurrentTaskStack().length === 0).catch(() => {})
		}
	})

	test("real-provider fan-out startup snapshot isolates parent and child profiles while both execute", async () => {
		const api = globalThis.api
		const asks: Record<string, ClineMessage[]> = {}

		const messageHandler = ({ taskId, message }: { taskId: string; message: ClineMessage }) => {
			if (message.type === "ask") {
				asks[taskId] = asks[taskId] || []
				asks[taskId].push(message)
			}
		}

		api.on(RooCodeEventName.Message, messageHandler)

		const aimockUrl = process.env.AIMOCK_URL
		const parentProfile = {
			apiProvider: "openrouter" as const,
			openRouterApiKey: "mock-key",
			openRouterModelId: SUBTASK_FANOUT_XPROFILE_PARENT_MODEL,
			rateLimitSeconds: 0,
			...(aimockUrl && { openRouterBaseUrl: `${aimockUrl}/v1` }),
		}
		const childProfile = {
			...parentProfile,
			openRouterModelId: SUBTASK_FANOUT_XPROFILE_CHILD_MODEL,
		}
		const priorModeApiConfigs = api.getConfiguration().modeApiConfigs ?? {}
		const parentProfileId = await api.upsertProfile("subtask-fanout-parent-profile", parentProfile, true)
		const childProfileId = await api.upsertProfile("subtask-fanout-child-profile", childProfile, false)
		assert.ok(parentProfileId, "Failed to create parent profile")
		assert.ok(childProfileId, "Failed to create child profile")
		await api.setConfiguration({
			modeApiConfigs: {
				...priorModeApiConfigs,
				code: parentProfileId,
				ask: childProfileId,
			},
		})

		try {
			// This is intentionally an extension-host boundary test. Unlike the unit delegation
			// tests, it exercises the real mode-switch producer and Task constructor: the child
			// must receive a snapshot of its profile while the already-running parent keeps its
			// own profile and mode.
			api.setTaskSchedulerMaxConcurrency(2)

			const parentTaskId = await api.startNewTask({
				configuration: {
					mode: "code",
					alwaysAllowModeSwitch: true,
					alwaysAllowSubtasks: true,
					autoApprovalEnabled: true,
					enableCheckpoints: false,
				},
				text: SUBTASK_FANOUT_XPROFILE_PARENT_PROMPT,
			})

			let childTaskId: string | undefined
			await waitFor(() => {
				const stack = api.getCurrentTaskStack()
				const current = stack.at(-1)
				if (current && current !== parentTaskId) {
					childTaskId = current
					return stack.includes(parentTaskId)
				}
				return false
			})

			await waitFor(() =>
				(asks[parentTaskId] ?? []).some(
					({ ask, text }) => ask === "followup" && text?.includes(SUBTASK_FANOUT_XPROFILE_PARENT_FOLLOWUP),
				),
			)

			assert.ok(
				(asks[parentTaskId] ?? []).some(
					({ ask, text }) => ask === "followup" && text?.includes(SUBTASK_FANOUT_XPROFILE_PARENT_FOLLOWUP),
				),
				"Parent should keep running and ask its follow-up using its own profile",
			)

			const stack = api.getCurrentTaskStack()
			assert.ok(stack.includes(parentTaskId), "Fan-out parent should remain in the live task stack")
			assert.ok(stack.includes(childTaskId!), "Fan-out child should remain in the live task stack")
			assert.strictEqual(stack.at(-1), childTaskId, "Child should remain the focused task while parent runs")

			await waitForAimockRequest((entry) => {
				const text = requestUserText(entry)
				const userMessageCount = (entry.body?.messages ?? []).filter(
					(message) => message.role === "user",
				).length
				return (
					entry.body?.model === SUBTASK_FANOUT_XPROFILE_PARENT_MODEL &&
					text.includes(SUBTASK_FANOUT_XPROFILE_PARENT_PROMPT) &&
					userMessageCount > 1
				)
			})
			await waitForAimockRequest(
				(entry) =>
					entry.body?.model === SUBTASK_FANOUT_XPROFILE_CHILD_MODEL &&
					(entry.body.messages ?? []).some(
						(message) =>
							message.role === "user" &&
							messageContentText(message.content).includes(SUBTASK_FANOUT_XPROFILE_CHILD_RESULT),
					),
			)

			const liveStackAfterChildRequest = api.getCurrentTaskStack()
			assert.ok(
				liveStackAfterChildRequest.includes(parentTaskId),
				"Parent should remain live after the child reaches the real provider",
			)
			assert.ok(
				liveStackAfterChildRequest.includes(childTaskId!),
				"Child should remain tracked after reaching the real provider",
			)

			const parentHistory = await api.getTaskHistoryItem(parentTaskId)
			assert.strictEqual(parentHistory?.mode, "code", "Parent task mode should remain isolated")
			assert.strictEqual(
				parentHistory?.apiConfigName,
				"subtask-fanout-parent-profile",
				"Parent task profile should remain isolated",
			)
			const childHistory = await api.getTaskHistoryItem(childTaskId!)
			assert.strictEqual(childHistory?.mode, "ask", "Child task should retain its requested mode")
			assert.strictEqual(
				childHistory?.apiConfigName,
				"subtask-fanout-child-profile",
				"Child task should retain its resolved profile",
			)
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
			while (api.getCurrentTaskStack().length > 0) {
				await api.clearCurrentTask()
			}
			api.setTaskSchedulerMaxConcurrency(1)
			await waitFor(() => api.getCurrentTaskStack().length === 0).catch(() => {})
			await api.setConfiguration({ modeApiConfigs: priorModeApiConfigs })
			await api.deleteProfile("subtask-fanout-child-profile").catch(() => {})
			await api.deleteProfile("subtask-fanout-parent-profile").catch(() => {})
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
			assert.ok(
				parent.status === "active" || parent.status === "completed",
				`Parent status should be 'active' or 'completed' after child completes (got '${parent.status}')`,
			)
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

			// Gate on the async settle before asserting the parent never resumed: a spurious
			// resume would be an async downstream effect of the cancellation, so a synchronous
			// check right after cancelCurrentTask() proves nothing.
			await waitFor(() => api.getCurrentTaskStack().at(-1) === spawnedTaskId)
			await waitFor(
				() => asks[spawnedTaskId!]?.some(({ type, ask }) => type === "ask" && ask === "resume_task") ?? false,
			)

			assert.ok(
				messages[parentTaskId]?.find(({ type, text }) => type === "say" && text === "Parent task resumed") ===
					undefined,
				"Parent task should not have resumed after subtask cancellation",
			)
			assert.strictEqual(
				messages[parentTaskId]?.find(({ say }) => say === "completion_result"),
				undefined,
				"Parent must not have completed after subtask cancellation",
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
		let delayedChildRequestStartedAt: number | undefined

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

			delayedChildRequestStartedAt = await waitForAimockRequestContaining(
				SUBTASK_API_HANG_CHILD_MARKER,
				SUBTASK_API_HANG_PARENT_MARKER,
			)

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
					.find((text): text is string => !!text),
				SUBTASK_API_HANG_CHILD_RESULT,
				"Child should complete with its expected result after resume",
			)
			assert.strictEqual(
				says[parentTaskId]
					?.filter(({ say }) => say === "completion_result")
					.map(({ text }) => text?.trim())
					.find((text): text is string => !!text),
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
			// Drain the cancelled delayed stream before the next test can open another
			// streamed request against the mock.
			await waitForDelayedSubtaskStreamDrain(delayedChildRequestStartedAt)
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
		const priorConfiguration = api.getConfiguration()
		const priorActiveProfile = api.getActiveProfile()
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
			await api.setConfiguration(priorConfiguration)
			if (priorActiveProfile) {
				await api.setActiveProfile(priorActiveProfile)
			}
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

	// Issue #559: explicit "Abandon subtask" action. Unlike cancellation alone (which leaves
	// the child "interrupted" and the parent "delegated" so the child can still resume and
	// report back), abandoning severs the link outright: the parent goes back to "active" and
	// the child's parentTaskId/rootTaskId are cleared so a later resume can never reattach it.
	test("abandoning an interrupted subtask severs the parent-child link", async () => {
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
				text: SUBTASK_ABANDON_PARENT_PROMPT,
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
			await waitFor(async () => (await api.getTaskApiConversationHistoryLength(childTaskId!)) > 0)

			// Cancel the child — marked "interrupted", parent stays "delegated".
			await api.cancelCurrentTask()

			await waitFor(() => api.getCurrentTaskStack().at(-1) === childTaskId)
			await waitFor(
				() => asks[childTaskId!]?.some(({ type, ask }) => type === "ask" && ask === "resume_task") ?? false,
			)

			const interruptedChild = await api.getTaskHistoryItem(childTaskId!)
			assert.strictEqual(interruptedChild?.status, "interrupted", "Child should be marked interrupted")

			const delegatedParent = await api.getTaskHistoryItem(parentTaskId)
			assert.strictEqual(delegatedParent?.status, "delegated", "Parent should still be delegated before abandon")
			assert.strictEqual(
				delegatedParent?.awaitingChildId,
				childTaskId,
				"Parent should await the interrupted child",
			)

			// The interrupted child is the live/open task at this point (cancelTask rehydrates
			// it onto the stack). Abandon must close that live instance before severing the
			// persisted link — otherwise a later save on the still-open child would rebuild
			// parentTaskId/rootTaskId from its live (readonly) fields and silently reattach it.
			const abandoned = await api.abandonSubtask(childTaskId!)
			assert.strictEqual(abandoned, true, "abandonSubtask should report the link was severed")

			await waitFor(() => api.getCurrentTaskStack().at(-1) !== childTaskId)

			const parentAfterAbandon = await api.getTaskHistoryItem(parentTaskId)
			assert.strictEqual(parentAfterAbandon?.status, "active", "Parent should return to active after abandon")
			assert.strictEqual(
				parentAfterAbandon?.awaitingChildId,
				undefined,
				"Parent awaitingChildId should be cleared",
			)
			assert.strictEqual(parentAfterAbandon?.delegatedToId, undefined, "Parent delegatedToId should be cleared")

			const childAfterAbandon = await api.getTaskHistoryItem(childTaskId!)
			// The child's own status is left untouched (VALID_TRANSITIONS only allows interrupted → completed);
			// only its parent/root links are cleared so it can never reattach to the parent again.
			assert.strictEqual(childAfterAbandon?.status, "interrupted", "Child status stays interrupted")
			assert.strictEqual(childAfterAbandon?.parentTaskId, undefined, "Child parentTaskId should be cleared")
			assert.strictEqual(childAfterAbandon?.rootTaskId, undefined, "Child rootTaskId should be cleared")

			// A second abandon call is a no-op since the parent is no longer delegated to this child.
			const secondAbandon = await api.abandonSubtask(childTaskId!)
			assert.strictEqual(secondAbandon, false, "Second abandonSubtask call should be a no-op")

			// Resume and complete the abandoned child — it must NOT reopen or reattach to the
			// parent. Before the abandon fix, a subsequent save on the still-live child could
			// silently rewrite its persisted parentTaskId back to the parent; this proves the
			// link stays severed all the way through a real resume/save/complete cycle.
			// api.resumeTask() re-instantiates the child from history, which re-raises its own
			// "resume_task" ask; answering it with the follow-up answer (same pattern the sibling
			// "cancelled child completes and reopens parent" test above uses) both resumes the
			// task and supplies the answer the re-asked follow-up question is waiting for.
			// asks[childTaskId] already holds the earlier resume_task ask from the pre-abandon
			// cancellation, so the wait below must look for a NEW one, not just any occurrence.
			const askCountBeforeResume = asks[childTaskId!]?.length ?? 0
			await api.resumeTask(childTaskId!)
			await waitFor(() =>
				(asks[childTaskId!] ?? [])
					.slice(askCountBeforeResume)
					.some(({ type, ask }) => type === "ask" && ask === "resume_task"),
			)

			const completedChildTaskId = await waitUntilCompleted({
				api,
				start: async () => {
					await api.sendMessage(SUBTASK_ABANDON_CHILD_FOLLOWUP_ANSWER)
					return childTaskId!
				},
			})

			assert.strictEqual(
				completedChildTaskId,
				childTaskId,
				"The abandoned child itself should be the task that completes, not the parent",
			)
			assert.strictEqual(
				says[parentTaskId]?.find(({ say }) => say === "completion_result"),
				undefined,
				"Parent must never complete/reopen after its abandoned child resumes and completes",
			)

			const parentAfterChildCompletes = await api.getTaskHistoryItem(parentTaskId)
			assert.strictEqual(
				parentAfterChildCompletes?.status,
				"active",
				"Parent status must remain untouched by the abandoned child's completion",
			)
			assert.strictEqual(
				parentAfterChildCompletes?.awaitingChildId,
				undefined,
				"Parent must not start awaiting the abandoned child again",
			)

			const childAfterCompletion = await api.getTaskHistoryItem(childTaskId!)
			assert.strictEqual(
				childAfterCompletion?.parentTaskId,
				undefined,
				"Child parentTaskId must still be cleared after it completes on its own — " +
					"proves the live-instance save did not resurrect the old link",
			)
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
			while (api.getCurrentTaskStack().length > 0) {
				await api.clearCurrentTask()
			}
			await waitFor(() => api.getCurrentTaskStack().length === 0).catch(() => {})
		}
	})

	// TaskScheduler regression: resumeTask on a completed task must show resume_completed_task ask.
	// Before the CodeRabbit fix, createTaskWithHistoryItem bypassed the scheduler and called
	// Task.run() via the constructor's startTask: true default, causing run() to call startTask()
	// (clearing history) instead of resumeTaskFromHistory().
	test("resumeTask on a completed task presents resume_completed_task ask", async () => {
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
			// Run a task to completion.
			const taskId = await waitUntilCompleted({
				api,
				start: () =>
					api.startNewTask({
						configuration: {
							mode: "ask",
							autoApprovalEnabled: true,
							enableCheckpoints: false,
						},
						text: SCHED_COMPLETED_PROMPT,
					}),
			})

			assert.strictEqual(
				says[taskId]?.find(({ say }) => say === "completion_result")?.text?.trim(),
				SCHED_COMPLETED_RESULT,
				"Task should complete with expected result",
			)

			// Re-open it via resumeTask — should hit resumeTaskFromHistory(), showing resume_completed_task.
			await api.resumeTask(taskId)

			await waitFor(
				() => asks[taskId]?.some(({ type, ask }) => type === "ask" && ask === "resume_completed_task") ?? false,
			)
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
			while (api.getCurrentTaskStack().length > 0) {
				await api.clearCurrentTask()
			}
			await sleep(500)
		}
	})

	// TaskScheduler regression: resumeTask on an interrupted standalone task must show resume_task
	// ask and allow the task to complete normally via the scheduler slot.
	test("resumeTask on an interrupted standalone task presents resume_task ask and completes", async () => {
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

		let taskId: string | undefined

		try {
			taskId = await api.startNewTask({
				configuration: {
					mode: "ask",
					autoApprovalEnabled: true,
					enableCheckpoints: false,
				},
				text: SCHED_STANDALONE_PROMPT,
			})

			// Wait until the task pauses at the follow-up question.
			await waitFor(() => asks[taskId!]?.some(({ type, ask }) => type === "ask" && ask === "followup") ?? false)

			// Cancel it — the task becomes interrupted.
			await api.cancelCurrentTask()

			await waitFor(
				() => asks[taskId!]?.some(({ type, ask }) => type === "ask" && ask === "resume_task") ?? false,
			)

			// Resume via scheduler path (createTaskWithHistoryItem).
			const askCountBeforeResume = asks[taskId!]?.length ?? 0
			await api.resumeTask(taskId!)

			await waitFor(() =>
				(asks[taskId!] ?? [])
					.slice(askCountBeforeResume)
					.some(({ type, ask }) => type === "ask" && ask === "resume_task"),
			)

			// Sending the answer both acknowledges the resume_task ask and answers the pending
			// follow-up question from the original task, completing the task.
			const completedTaskId = await waitUntilCompleted({
				api,
				start: async () => {
					await api.sendMessage(SCHED_STANDALONE_FOLLOWUP_ANSWER)
					return taskId!
				},
			})

			assert.strictEqual(completedTaskId, taskId, "The resumed standalone task should complete")
			assert.strictEqual(
				says[taskId!]?.find(({ say }) => say === "completion_result")?.text?.trim(),
				SCHED_STANDALONE_FOLLOWUP_ANSWER,
				"Task should complete with the follow-up answer as result",
			)
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
			while (api.getCurrentTaskStack().length > 0) {
				await api.clearCurrentTask()
			}
			await sleep(500)
		}
	})
})
