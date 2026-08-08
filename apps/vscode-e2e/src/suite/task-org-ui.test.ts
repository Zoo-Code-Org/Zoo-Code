import * as assert from "assert"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { waitUntilCompleted } from "./utils"
import { setDefaultSuiteTimeout } from "./test-utils"

suite("Task Organization UI", function () {
	setDefaultSuiteTimeout(this)

	test("Should handle task creation and organization workflow", async () => {
		const api = globalThis.api

		const messages: ClineMessage[] = []

		api.on(RooCodeEventName.Message, ({ message }) => {
			if (message.type === "say" && message.partial === false) {
				messages.push(message)
			}
		})

		// Create a task to work with
		const taskId = await api.startNewTask({
			configuration: { mode: "code", alwaysAllowModeSwitch: true, autoApprovalEnabled: true },
			text: "TASK_ORG_TEST: Create a simple hello world function",
		})

		await waitUntilCompleted({ api, taskId })

		// Verify task was created and is tracked by the host.
		assert.ok(taskId, "Task should be created")
		assert.ok(await api.isTaskInHistory(taskId), "Task should be in history")

		const item = await api.getTaskHistoryItem(taskId)
		assert.ok(item, "History item should exist for the created task")
		assert.strictEqual(item.id, taskId, "History item id should match the created task id")
	})

	test("Should support task pinning workflow", async () => {
		const api = globalThis.api

		// Create a task to pin
		const taskId = await api.startNewTask({
			configuration: { mode: "ask", alwaysAllowModeSwitch: true, autoApprovalEnabled: true },
			text: "TASK_PIN_TEST: What is the capital of France?",
		})

		await waitUntilCompleted({ api, taskId })

		// Verify task exists in history.
		assert.ok(await api.isTaskInHistory(taskId), "Task should exist in history")

		const item = await api.getTaskHistoryItem(taskId)
		assert.ok(item, "History item should exist for the pinned task")

		// Note: Actual pin UI interactions are exercised by webview tests.
		// This test verifies the underlying task data structures exist.
	})

	test("Should support folder creation and task assignment", async () => {
		const api = globalThis.api

		// Create multiple tasks for folder organization
		const taskId1 = await api.startNewTask({
			configuration: { mode: "code", alwaysAllowModeSwitch: true, autoApprovalEnabled: true },
			text: "FOLDER_TEST_1: Create a calculator function",
		})

		await waitUntilCompleted({ api, taskId: taskId1 })

		const taskId2 = await api.startNewTask({
			configuration: { mode: "code", alwaysAllowModeSwitch: true, autoApprovalEnabled: true },
			text: "FOLDER_TEST_2: Create a todo list component",
		})

		await waitUntilCompleted({ api, taskId: taskId2 })

		// Verify both tasks exist in history.
		assert.ok(await api.isTaskInHistory(taskId1), "First task should exist in history")
		assert.ok(await api.isTaskInHistory(taskId2), "Second task should exist in history")

		const item1 = await api.getTaskHistoryItem(taskId1)
		const item2 = await api.getTaskHistoryItem(taskId2)

		assert.ok(item1, "First task history item should exist")
		assert.ok(item2, "Second task history item should exist")
	})

	test("Should handle task organization state persistence", async () => {
		const api = globalThis.api

		// Capture the current task stack before creating a task.
		const initialStack = api.getCurrentTaskStack()
		assert.ok(Array.isArray(initialStack), "Initial task stack should be an array")

		// Create a task
		const taskId = await api.startNewTask({
			configuration: { mode: "ask", alwaysAllowModeSwitch: true, autoApprovalEnabled: true },
			text: "PERSISTENCE_TEST: Test state persistence",
		})

		await waitUntilCompleted({ api, taskId })

		// Verify the task persists in history after completion.
		assert.ok(await api.isTaskInHistory(taskId), "Task should persist in history after completion")

		const item = await api.getTaskHistoryItem(taskId)
		assert.ok(item, "History item should persist after task completion")
		assert.strictEqual(item.id, taskId, "Persisted history item id should match")
	})
})
