import * as assert from "assert"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitUntilCompleted, waitFor } from "./utils"

// Regression test for the "Work #1 (no message)" title-clobber bug reported
// against Zoo Code v3.76.0 (Discord, 2026-08-06).
//
// Root cause: Task#resumeTaskFromHistory() is started fire-and-forget by
// scheduleTask() after createTaskWithHistoryItem() adds the task to the
// registry, so `clineMessages` is [] until the first disk read resolves.
// ClineProvider#evictCurrentTask() (called by clearCurrentTask / the
// Back-to-parent / Go-to-subtask buttons) calls abortTask(), which calls
// saveClineMessages() → taskMetadata() while the array is still empty.
// taskMetadata() then persists the "no_messages" placeholder title,
// permanently clobbering the real title in the history store.
//
// The test exercises the race by:
//   1. Running a task to completion so a real title is persisted.
//   2. Starting resumeTask() (same path as showTaskWithId) without awaiting it.
//   3. Polling until the task appears on the stack, then immediately evicting —
//      the task is on the stack but its message load is still in flight.
//   4. Asserting the stored title still matches the original.
//
// NOTE: Because the extension host reads task messages from disk in the same
// process as this test, the I/O window is very tight (< 1ms on local disk).
// The race is not reliably triggerable from the e2e layer; the canonical
// regression anchor is the unit test in
// src/core/task/__tests__/Task.resume-eviction-race.spec.ts, which controls
// the timing via a deferred promise. This e2e test serves as a smoke test that
// the resume-then-evict flow does not blow up and that the stored title is
// correct after a round-trip.
suite("Resume eviction race (title clobber regression)", function () {
	setDefaultSuiteTimeout(this)

	test("evicting a mid-resume task does not overwrite its stored title", async () => {
		const api = globalThis.api

		const ORIGINAL_TITLE =
			"RESUME_EVICTION_RACE_SMOKE: complete immediately with 'Resume eviction smoke completed.'"

		// Step 1 — run a task to completion so a real title is persisted.
		const taskId = await waitUntilCompleted({
			api,
			start: () =>
				api.startNewTask({
					configuration: {
						mode: "ask",
						autoApprovalEnabled: true,
						enableCheckpoints: false,
					},
					text: ORIGINAL_TITLE,
				}),
		})

		const beforeResume = await api.getTaskHistoryItem(taskId)
		assert.ok(beforeResume, "Task should be in history after completion")
		assert.ok(
			beforeResume.task?.includes("RESUME_EVICTION_RACE_SMOKE"),
			`Persisted title before resume should contain the prompt marker (got "${beforeResume.task}")`,
		)

		// Drain the stack so we start clean.
		while (api.getCurrentTaskStack().length > 0) {
			await api.clearCurrentTask()
		}

		// Step 2 — fire resumeTask() without awaiting it. resumeTask() calls
		// createTaskWithHistoryItem() which adds the task to the registry and
		// calls scheduleTask() (fire-and-forget). The task's run() and
		// resumeTaskFromHistory() start in the background.
		const resumePromise = api.resumeTask(taskId)

		// Step 3 — wait only until the task appears on the stack (i.e.
		// createTaskWithHistoryItem has returned and addClineToStack has run),
		// then immediately evict. This minimises the gap between the eviction
		// and the in-flight message load, giving the best chance of hitting the
		// race window before readTaskMessages() resolves.
		await waitFor(() => api.getCurrentTaskStack().includes(taskId))
		await api.clearCurrentTask()

		// Let the resume settle.
		await resumePromise.catch(() => {})

		// Step 4 — the stored title must still be the real one.
		const afterEviction = await api.getTaskHistoryItem(taskId)
		assert.ok(afterEviction, "Task should still be in history after eviction")

		// Before the fix this would be "Task #N (No messages)" / "工作 #N (無訊息)".
		assert.strictEqual(
			afterEviction.task,
			beforeResume.task,
			`Title must not change during resume eviction. Got: "${afterEviction.task}"`,
		)
	})
})
