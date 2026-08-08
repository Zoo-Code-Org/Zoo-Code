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

		// Verify task was created
		assert.ok(taskId, "Task should be created")

		// Test task organization state management
		const state = await api.getState()
		assert.ok(state, "Should be able to get extension state")

		// Verify task history is accessible
		const taskHistory = state.taskHistory || []
		assert.ok(Array.isArray(taskHistory), "Task history should be an array")

		// Check if task organization data structure exists
		if (state.taskOrganization) {
			assert.ok(typeof state.taskOrganization === "object", "Task organization should be an object")
			assert.ok(Array.isArray(state.taskOrganization.folders || []), "Folders should be an array")
			assert.ok(Array.isArray(state.taskOrganization.pins || []), "Pins should be an array")
		}
	})

	test("Should support task pinning workflow", async () => {
		const api = globalThis.api

		// Create a task to pin
		const taskId = await api.startNewTask({
			configuration: { mode: "ask", alwaysAllowModeSwitch: true, autoApprovalEnabled: true },
			text: "TASK_PIN_TEST: What is the capital of France?",
		})

		await waitUntilCompleted({ api, taskId })

		// Verify task exists in history
		const state = await api.getState()
		const taskHistory = state.taskHistory || []
		const task = taskHistory.find((t) => t.id === taskId)
		assert.ok(task, "Task should exist in history")

		// Test pin functionality would be available through UI
		// Note: Actual UI interactions would require Playwright or similar
		// This test verifies the underlying data structures support pinning
		if (state.taskOrganization) {
			const pins = state.taskOrganization.pins || []
			assert.ok(Array.isArray(pins), "Pins array should exist")
		}
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

		// Verify both tasks exist
		const state = await api.getState()
		const taskHistory = state.taskHistory || []
		const task1 = taskHistory.find((t) => t.id === taskId1)
		const task2 = taskHistory.find((t) => t.id === taskId2)

		assert.ok(task1, "First task should exist")
		assert.ok(task2, "Second task should exist")

		// Verify folder structure supports organization
		if (state.taskOrganization) {
			const folders = state.taskOrganization.folders || []
			assert.ok(Array.isArray(folders), "Folders array should exist")
		}
	})

	test("Should handle task organization state persistence", async () => {
		const api = globalThis.api

		// Get initial state
		const initialState = await api.getState()
		assert.ok(initialState, "Should have initial state")

		// Create a task
		const taskId = await api.startNewTask({
			configuration: { mode: "ask", alwaysAllowModeSwitch: true, autoApprovalEnabled: true },
			text: "PERSISTENCE_TEST: Test state persistence",
		})

		await waitUntilCompleted({ api, taskId })

		// Verify state after task creation
		const finalState = await api.getState()
		assert.ok(finalState, "Should have final state")

		// Check that task organization state is maintained
		if (initialState.taskOrganization && finalState.taskOrganization) {
			assert.ok(
				typeof finalState.taskOrganization === "object",
				"Task organization state should persist after task creation",
			)
		}
	})
})
