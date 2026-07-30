import * as assert from "assert"

import { RooCodeEventName, type ClineMessage, type RooCodeAPI, type RooCodeResourceDiagnostics } from "@roo-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { sleep, waitFor, waitUntilCompleted } from "./utils"
import {
	assertResourceDiagnosticsConverged,
	getResourceDiagnosticsConvergenceIssues,
} from "../fixtures/resource-diagnostics"
import {
	ORCHESTRATOR_CANCELLATION_RECOVERY_CHILD_STEP,
	ORCHESTRATOR_CANCELLATION_RECOVERY_FINAL_RESULT,
	ORCHESTRATOR_CANCELLATION_RECOVERY_FOLLOWUP_ANSWER,
	ORCHESTRATOR_CANCELLATION_RECOVERY_PARENT_PROMPT,
	ORCHESTRATOR_FAN_OUT_CHILD_STEPS,
	ORCHESTRATOR_FAN_OUT_FINAL_RESULT,
	ORCHESTRATOR_FAN_OUT_PARENT_PROMPT,
	ORCHESTRATOR_NESTED_DELEGATION_CHILD_FINAL_RESULT,
	ORCHESTRATOR_NESTED_DELEGATION_CHILD_ORCHESTRATOR_STEP,
	ORCHESTRATOR_NESTED_DELEGATION_FINAL_RESULT,
	ORCHESTRATOR_NESTED_DELEGATION_GRANDCHILD_STEPS,
	ORCHESTRATOR_NESTED_DELEGATION_PARENT_PROMPT,
	ORCHESTRATOR_REPEATED_DELEGATION_CHILD_STEPS,
	ORCHESTRATOR_REPEATED_DELEGATION_FINAL_RESULT,
	ORCHESTRATOR_REPEATED_DELEGATION_PARENT_PROMPT,
} from "../fixtures/orchestrator"

const getDefaultOpenRouterConfiguration = () => {
	const aimockUrl = process.env.AIMOCK_URL
	const isRecord = process.env.AIMOCK_RECORD === "true"

	return {
		apiProvider: "openrouter" as const,
		openRouterApiKey: aimockUrl && !isRecord ? "mock-key" : process.env.OPENROUTER_API_KEY!,
		openRouterModelId: "openai/gpt-4.1",
		currentApiConfigName: "default",
		mode: "ask" as const,
		autoApprovalEnabled: false,
		alwaysAllowModeSwitch: false,
		alwaysAllowSubtasks: false,
		modeApiConfigs: {},
		...(aimockUrl && { openRouterBaseUrl: `${aimockUrl}/v1` }),
	}
}

async function restoreDefaultOpenRouterConfiguration(api: RooCodeAPI): Promise<void> {
	const configuration = getDefaultOpenRouterConfiguration()
	await api.upsertProfile("default", configuration, true)
	await api.setConfiguration(configuration)
}

async function drainTaskStack(api: RooCodeAPI, message: string, maxAttempts = 10): Promise<void> {
	let attempts = 0
	while (api.getCurrentTaskStack().length > 0) {
		assert.ok(attempts < maxAttempts, `Task stack did not drain within ${maxAttempts} clear attempts`)
		attempts += 1
		await api.clearCurrentTask()
	}
	await waitFor(() => api.getCurrentTaskStack().length === 0).catch(() => {})
	assert.strictEqual(api.getCurrentTaskStack().length, 0, message)
	await sleep(100)
}

async function expectDiagnosticsConverged({
	api,
	baseline,
	observedChildTaskIds,
}: {
	api: RooCodeAPI
	baseline: RooCodeResourceDiagnostics
	observedChildTaskIds: string[]
}): Promise<void> {
	await waitFor(() => {
		const final = api.getResourceDiagnostics()

		return (
			getResourceDiagnosticsConvergenceIssues({
				baseline,
				final,
				observedChildTaskIds,
			}).length === 0
		)
	}).catch(() => {})

	assertResourceDiagnosticsConverged({
		baseline,
		final: api.getResourceDiagnostics(),
		observedChildTaskIds,
	})
}

suite("Roo Code Orchestrator", function () {
	setDefaultSuiteTimeout(this)

	setup(async () => {
		await drainTaskStack(globalThis.api, "Task stack should be empty before orchestrator test")
	})

	suiteTeardown(async () => {
		await restoreDefaultOpenRouterConfiguration(globalThis.api)
	})

	test("orchestrator parent fans out once and fans in three delegated child summaries", async () => {
		const api = globalThis.api
		const baselineDiagnostics = api.getResourceDiagnostics()
		const says: Record<string, ClineMessage[]> = {}
		const delegationCompletions: Array<{ parentId: string; childId: string; summary: string }> = []

		const messageHandler = ({ taskId, message }: { taskId: string; message: ClineMessage }) => {
			if (message.type === "say" && message.partial === false) {
				says[taskId] = says[taskId] || []
				says[taskId].push(message)
			}
		}

		const delegationCompletedHandler = (parentId: string, childId: string, summary: string) => {
			delegationCompletions.push({ parentId, childId, summary })
		}

		api.on(RooCodeEventName.Message, messageHandler)
		api.on(RooCodeEventName.TaskDelegationCompleted, delegationCompletedHandler)

		try {
			const parentTaskId = await waitUntilCompleted({
				api,
				start: () =>
					api.startNewTask({
						configuration: {
							mode: "orchestrator",
							alwaysAllowModeSwitch: true,
							alwaysAllowSubtasks: true,
							autoApprovalEnabled: true,
							enableCheckpoints: false,
						},
						text: ORCHESTRATOR_FAN_OUT_PARENT_PROMPT,
					}),
			})

			await waitFor(() => delegationCompletions.length === ORCHESTRATOR_FAN_OUT_CHILD_STEPS.length)

			const childIds = delegationCompletions.map(({ childId }) => childId)
			assert.strictEqual(new Set(childIds).size, 3, "Orchestrator should create three distinct child tasks")
			assert.deepStrictEqual(
				delegationCompletions.map(({ parentId }) => parentId),
				[parentTaskId, parentTaskId, parentTaskId],
				"Every delegation completed event should point to the orchestrator parent",
			)
			assert.deepStrictEqual(
				delegationCompletions.map(({ summary }) => summary),
				ORCHESTRATOR_FAN_OUT_CHILD_STEPS.map(({ summary }) => summary),
				"Delegation completed events should preserve each child summary in order",
			)

			const parent = await api.getTaskHistoryItem(parentTaskId)
			assert.ok(parent, "Parent history item should exist")
			assert.strictEqual(parent.status, "completed", "Parent should be completed after final fan-in")
			assert.deepStrictEqual(parent.childIds, childIds, "Parent childIds should contain all three children")

			for (const [index, childId] of childIds.entries()) {
				const child = await api.getTaskHistoryItem(childId)
				assert.ok(child, `Child ${index + 1} history item should exist`)
				assert.strictEqual(child.parentTaskId, parentTaskId, `Child ${index + 1} should point back to parent`)
				assert.strictEqual(child.status, "completed", `Child ${index + 1} should be completed`)
				assert.strictEqual(
					child.completionResultSummary,
					ORCHESTRATOR_FAN_OUT_CHILD_STEPS[index]!.summary,
					`Child ${index + 1} completion summary should be persisted`,
				)
			}

			const parentCompletionText = says[parentTaskId]
				?.filter(({ say }) => say === "completion_result")
				.map(({ text }) => text?.trim())
				.find((text): text is string => !!text)

			assert.strictEqual(parentCompletionText, ORCHESTRATOR_FAN_OUT_FINAL_RESULT)
			for (const { summary } of ORCHESTRATOR_FAN_OUT_CHILD_STEPS) {
				assert.ok(parentCompletionText.includes(summary), `Final parent completion should include ${summary}`)
			}
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
			api.off(RooCodeEventName.TaskDelegationCompleted, delegationCompletedHandler)
			await drainTaskStack(api, "Task stack should be empty after cleanup")
			await expectDiagnosticsConverged({
				api,
				baseline: baselineDiagnostics,
				observedChildTaskIds: delegationCompletions.map(({ childId }) => childId),
			})
		}
	})

	test("orchestrator parent repeats three rounds of delegated child fan-in without stack duplication", async () => {
		const api = globalThis.api
		const baselineDiagnostics = api.getResourceDiagnostics()
		const says: Record<string, ClineMessage[]> = {}
		const delegationCompletions: Array<{ parentId: string; childId: string; summary: string }> = []
		const parentStackSnapshots: string[][] = []

		const messageHandler = ({ taskId, message }: { taskId: string; message: ClineMessage }) => {
			if (message.type === "say" && message.partial === false) {
				says[taskId] = says[taskId] || []
				says[taskId].push(message)
			}
		}

		const delegationCompletedHandler = (parentId: string, childId: string, summary: string) => {
			delegationCompletions.push({ parentId, childId, summary })
			parentStackSnapshots.push(api.getCurrentTaskStack())
		}

		api.on(RooCodeEventName.Message, messageHandler)
		api.on(RooCodeEventName.TaskDelegationCompleted, delegationCompletedHandler)

		try {
			const parentTaskId = await waitUntilCompleted({
				api,
				start: () =>
					api.startNewTask({
						configuration: {
							mode: "orchestrator",
							alwaysAllowModeSwitch: true,
							alwaysAllowSubtasks: true,
							autoApprovalEnabled: true,
							enableCheckpoints: false,
						},
						text: ORCHESTRATOR_REPEATED_DELEGATION_PARENT_PROMPT,
					}),
			})

			await waitFor(() => delegationCompletions.length === ORCHESTRATOR_REPEATED_DELEGATION_CHILD_STEPS.length)

			const childIds = delegationCompletions.map(({ childId }) => childId)
			assert.strictEqual(childIds.length, 9, "Repeated delegation should create nine child tasks")
			assert.strictEqual(new Set(childIds).size, 9, "Repeated delegation should create nine distinct child tasks")
			assert.deepStrictEqual(
				delegationCompletions.map(({ parentId }) => parentId),
				ORCHESTRATOR_REPEATED_DELEGATION_CHILD_STEPS.map(() => parentTaskId),
				"Every repeated delegation completed event should point to the orchestrator parent",
			)
			assert.deepStrictEqual(
				delegationCompletions.map(({ summary }) => summary),
				ORCHESTRATOR_REPEATED_DELEGATION_CHILD_STEPS.map(({ summary }) => summary),
				"Repeated delegation completed events should preserve every round summary in order",
			)

			for (const [index, snapshot] of parentStackSnapshots.entries()) {
				const parentOccurrences = snapshot.filter((taskId) => taskId === parentTaskId).length
				assert.ok(
					parentOccurrences <= 1,
					`Parent should not be duplicated in stack after child ${index + 1} resumes`,
				)
			}

			const parent = await api.getTaskHistoryItem(parentTaskId)
			assert.ok(parent, "Repeated delegation parent history item should exist")
			assert.strictEqual(
				parent.status,
				"completed",
				"Repeated delegation parent should complete after final fan-in",
			)
			assert.deepStrictEqual(
				parent.childIds,
				childIds,
				"Parent childIds should contain all nine children in order",
			)
			assert.strictEqual(new Set(parent.childIds ?? []).size, 9, "Parent childIds should not contain duplicates")

			for (const [index, childId] of childIds.entries()) {
				const expectedStep = ORCHESTRATOR_REPEATED_DELEGATION_CHILD_STEPS[index]!
				const child = await api.getTaskHistoryItem(childId)
				assert.ok(child, `Repeated delegation child ${index + 1} history item should exist`)
				assert.strictEqual(child.parentTaskId, parentTaskId, `Child ${index + 1} should point back to parent`)
				assert.strictEqual(child.status, "completed", `Child ${index + 1} should be completed`)
				assert.strictEqual(
					child.mode,
					expectedStep.mode,
					`Child ${index + 1} mode should match the repeated plan`,
				)
				assert.strictEqual(
					child.completionResultSummary,
					expectedStep.summary,
					`Child ${index + 1} round ${expectedStep.round} ${expectedStep.role} summary should be persisted`,
				)
			}

			const parentCompletionText = says[parentTaskId]
				?.filter(({ say }) => say === "completion_result")
				.map(({ text }) => text?.trim())
				.find((text): text is string => !!text)

			assert.strictEqual(parentCompletionText, ORCHESTRATOR_REPEATED_DELEGATION_FINAL_RESULT)
			for (const { round, role, summary } of ORCHESTRATOR_REPEATED_DELEGATION_CHILD_STEPS) {
				assert.ok(
					parentCompletionText.includes(`Round ${round} ${role}: ${summary}`),
					`Final parent completion should include round ${round} ${role} summary`,
				)
			}
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
			api.off(RooCodeEventName.TaskDelegationCompleted, delegationCompletedHandler)
			await drainTaskStack(api, "Task stack should be empty after cleanup")
			await expectDiagnosticsConverged({
				api,
				baseline: baselineDiagnostics,
				observedChildTaskIds: delegationCompletions.map(({ childId }) => childId),
			})
		}
	})

	test("orchestrator parent fans in through a nested child orchestrator", async () => {
		const api = globalThis.api
		const baselineDiagnostics = api.getResourceDiagnostics()
		const says: Record<string, ClineMessage[]> = {}
		const delegationCompletions: Array<{ parentId: string; childId: string; summary: string }> = []

		const messageHandler = ({ taskId, message }: { taskId: string; message: ClineMessage }) => {
			if (message.type === "say" && message.partial === false) {
				says[taskId] = says[taskId] || []
				says[taskId].push(message)
			}
		}

		const delegationCompletedHandler = (parentId: string, childId: string, summary: string) => {
			delegationCompletions.push({ parentId, childId, summary })
		}

		api.on(RooCodeEventName.Message, messageHandler)
		api.on(RooCodeEventName.TaskDelegationCompleted, delegationCompletedHandler)

		try {
			const parentTaskId = await waitUntilCompleted({
				api,
				start: () =>
					api.startNewTask({
						configuration: {
							mode: "orchestrator",
							alwaysAllowModeSwitch: true,
							alwaysAllowSubtasks: true,
							autoApprovalEnabled: true,
							enableCheckpoints: false,
						},
						text: ORCHESTRATOR_NESTED_DELEGATION_PARENT_PROMPT,
					}),
			})

			await waitFor(() => delegationCompletions.length === 3)

			assert.deepStrictEqual(
				delegationCompletions.map(({ summary }) => summary),
				[
					ORCHESTRATOR_NESTED_DELEGATION_GRANDCHILD_STEPS[0]!.summary,
					ORCHESTRATOR_NESTED_DELEGATION_GRANDCHILD_STEPS[1]!.summary,
					ORCHESTRATOR_NESTED_DELEGATION_CHILD_FINAL_RESULT,
				],
				"Nested fan-in events should complete C/D before B completes to A",
			)

			const childOrchestratorCompletion = delegationCompletions.find(
				({ parentId, summary }) =>
					parentId === parentTaskId && summary === ORCHESTRATOR_NESTED_DELEGATION_CHILD_FINAL_RESULT,
			)
			assert.ok(childOrchestratorCompletion, "A should receive B's nested orchestrator completion")

			const childOrchestratorId = childOrchestratorCompletion.childId
			const grandchildCompletions = delegationCompletions.filter(
				({ parentId }) => parentId === childOrchestratorId,
			)
			const grandchildIds = grandchildCompletions.map(({ childId }) => childId)
			assert.deepStrictEqual(
				grandchildCompletions.map(({ summary }) => summary),
				ORCHESTRATOR_NESTED_DELEGATION_GRANDCHILD_STEPS.map(({ summary }) => summary),
				"C/D completions should resume only B before B resumes A",
			)
			assert.ok(
				delegationCompletions
					.filter(({ summary }) =>
						ORCHESTRATOR_NESTED_DELEGATION_GRANDCHILD_STEPS.some((step) => step.summary === summary),
					)
					.every(({ parentId }) => parentId === childOrchestratorId),
				"C/D completion events should not directly resume A",
			)

			const parent = await api.getTaskHistoryItem(parentTaskId)
			assert.ok(parent, "Nested parent A history item should exist")
			assert.strictEqual(parent.status, "completed", "Nested parent A should complete after B fan-in")
			assert.deepStrictEqual(parent.childIds, [childOrchestratorId], "A childIds should contain only B")

			const childOrchestrator = await api.getTaskHistoryItem(childOrchestratorId)
			assert.ok(childOrchestrator, "Nested child orchestrator B history item should exist")
			assert.strictEqual(childOrchestrator.parentTaskId, parentTaskId, "B parentTaskId should point to A")
			assert.strictEqual(childOrchestrator.mode, ORCHESTRATOR_NESTED_DELEGATION_CHILD_ORCHESTRATOR_STEP.mode)
			assert.strictEqual(childOrchestrator.status, "completed", "B should complete after C/D fan-in")
			assert.deepStrictEqual(childOrchestrator.childIds, grandchildIds, "B childIds should contain C/D")
			assert.strictEqual(
				childOrchestrator.completionResultSummary,
				ORCHESTRATOR_NESTED_DELEGATION_CHILD_FINAL_RESULT,
				"B completion summary should include nested C/D result",
			)

			for (const [index, grandchildId] of grandchildIds.entries()) {
				const expectedStep = ORCHESTRATOR_NESTED_DELEGATION_GRANDCHILD_STEPS[index]!
				const grandchild = await api.getTaskHistoryItem(grandchildId)
				assert.ok(grandchild, `Nested grandchild ${index + 1} history item should exist`)
				assert.strictEqual(
					grandchild.parentTaskId,
					childOrchestratorId,
					`Grandchild ${index + 1} should point to B`,
				)
				assert.strictEqual(
					grandchild.mode,
					expectedStep.mode,
					`Grandchild ${index + 1} mode should match the nested plan`,
				)
				assert.strictEqual(grandchild.status, "completed", `Grandchild ${index + 1} should be completed`)
				assert.strictEqual(
					grandchild.completionResultSummary,
					expectedStep.summary,
					`Grandchild ${index + 1} summary should be persisted`,
				)
			}

			const childCompletionText = says[childOrchestratorId]
				?.filter(({ say }) => say === "completion_result")
				.map(({ text }) => text?.trim())
				.find((text) => text === ORCHESTRATOR_NESTED_DELEGATION_CHILD_FINAL_RESULT)
			assert.strictEqual(childCompletionText, ORCHESTRATOR_NESTED_DELEGATION_CHILD_FINAL_RESULT)
			for (const { summary } of ORCHESTRATOR_NESTED_DELEGATION_GRANDCHILD_STEPS) {
				assert.ok(childCompletionText.includes(summary), `B completion should include nested ${summary}`)
			}

			const parentCompletionText = says[parentTaskId]
				?.filter(({ say }) => say === "completion_result")
				.map(({ text }) => text?.trim())
				.find((text) => text === ORCHESTRATOR_NESTED_DELEGATION_FINAL_RESULT)
			assert.strictEqual(parentCompletionText, ORCHESTRATOR_NESTED_DELEGATION_FINAL_RESULT)
			assert.ok(
				parentCompletionText.includes(ORCHESTRATOR_NESTED_DELEGATION_CHILD_FINAL_RESULT),
				"Final top-level completion should include B's nested summary",
			)
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
			api.off(RooCodeEventName.TaskDelegationCompleted, delegationCompletedHandler)
			await drainTaskStack(api, "Task stack should be empty after nested cleanup")
			await expectDiagnosticsConverged({
				api,
				baseline: baselineDiagnostics,
				observedChildTaskIds: delegationCompletions.map(({ childId }) => childId),
			})
		}
	})

	test("orchestrator child cancellation stays delegated until explicit recovery", async () => {
		const api = globalThis.api
		const baselineDiagnostics = api.getResourceDiagnostics()
		const asks: Record<string, ClineMessage[]> = {}
		const says: Record<string, ClineMessage[]> = {}
		const delegationCompletions: Array<{ parentId: string; childId: string; summary: string }> = []

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
			delegationCompletions.push({ parentId, childId, summary })
		}

		api.on(RooCodeEventName.Message, messageHandler)
		api.on(RooCodeEventName.TaskDelegationCompleted, delegationCompletedHandler)

		try {
			const parentTaskId = await api.startNewTask({
				configuration: {
					mode: "orchestrator",
					alwaysAllowModeSwitch: true,
					alwaysAllowSubtasks: true,
					autoApprovalEnabled: true,
					enableCheckpoints: false,
				},
				text: ORCHESTRATOR_CANCELLATION_RECOVERY_PARENT_PROMPT,
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

			const delegatedChild = await api.getTaskHistoryItem(childTaskId!)
			assert.ok(delegatedChild, "Cancellation child history item should exist after delegation")
			assert.strictEqual(delegatedChild.parentTaskId, parentTaskId, "B parentTaskId should point to A")
			assert.strictEqual(delegatedChild.mode, ORCHESTRATOR_CANCELLATION_RECOVERY_CHILD_STEP.mode)

			await api.cancelCurrentTask()

			await waitFor(() => api.getCurrentTaskStack().at(-1) === childTaskId)
			await waitFor(
				() => asks[childTaskId!]?.some(({ type, ask }) => type === "ask" && ask === "resume_task") ?? false,
			)

			const interruptedChild = await api.getTaskHistoryItem(childTaskId!)
			assert.strictEqual(interruptedChild?.status, "interrupted", "B should be interrupted after cancellation")
			assert.strictEqual(
				interruptedChild?.parentTaskId,
				parentTaskId,
				"Interrupted B should retain its parent link to A",
			)

			const delegatedParent = await api.getTaskHistoryItem(parentTaskId)
			assert.strictEqual(delegatedParent?.status, "delegated", "A should stay delegated after B cancellation")
			assert.strictEqual(delegatedParent?.awaitingChildId, childTaskId, "A should keep awaiting interrupted B")
			assert.strictEqual(delegationCompletions.length, 0, "B cancellation should not emit a completion to A")
			assert.strictEqual(
				says[parentTaskId]?.find(({ say }) => say === "completion_result"),
				undefined,
				"A must not receive premature final completion after B cancellation",
			)

			const completedParentTaskId = await waitUntilCompleted({
				api,
				start: async () => {
					await api.sendMessage(ORCHESTRATOR_CANCELLATION_RECOVERY_FOLLOWUP_ANSWER)
					return parentTaskId
				},
			})

			assert.strictEqual(
				completedParentTaskId,
				parentTaskId,
				"Explicitly recovered B should report back and complete A",
			)
			assert.deepStrictEqual(
				delegationCompletions,
				[
					{
						parentId: parentTaskId,
						childId: childTaskId,
						summary: ORCHESTRATOR_CANCELLATION_RECOVERY_CHILD_STEP.summary,
					},
				],
				"Recovered B should emit exactly one completion to A",
			)

			const recoveredChild = await api.getTaskHistoryItem(childTaskId!)
			assert.strictEqual(recoveredChild?.status, "completed", "B should complete after explicit recovery")
			assert.strictEqual(
				recoveredChild?.completionResultSummary,
				ORCHESTRATOR_CANCELLATION_RECOVERY_CHILD_STEP.summary,
				"B recovery summary should be persisted",
			)

			const completedParent = await api.getTaskHistoryItem(parentTaskId)
			assert.strictEqual(completedParent?.status, "completed", "A should complete after explicit recovery")
			assert.deepStrictEqual(completedParent?.childIds, [childTaskId], "A childIds should contain only B")

			const parentCompletionText = says[parentTaskId]
				?.filter(({ say }) => say === "completion_result")
				.map(({ text }) => text?.trim())
				.find((text): text is string => text === ORCHESTRATOR_CANCELLATION_RECOVERY_FINAL_RESULT)
			assert.strictEqual(parentCompletionText, ORCHESTRATOR_CANCELLATION_RECOVERY_FINAL_RESULT)
			assert.ok(
				parentCompletionText.includes("cancellation recovery"),
				"A final summary should explicitly identify cancellation recovery",
			)
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
			api.off(RooCodeEventName.TaskDelegationCompleted, delegationCompletedHandler)
			await drainTaskStack(api, "Task stack should be empty after recovery cleanup")
			await expectDiagnosticsConverged({
				api,
				baseline: baselineDiagnostics,
				observedChildTaskIds: delegationCompletions.map(({ childId }) => childId),
			})
		}
	})
})
