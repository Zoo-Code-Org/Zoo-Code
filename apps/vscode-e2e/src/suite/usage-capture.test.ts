import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"

import * as vscode from "vscode"

import { UsageEventV1 } from "@roo-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor, waitUntilCompleted } from "./utils"

/**
 * E2E coverage for the Token Usage Capture hooks (PR #1133).
 *
 * The extension wires a UsageRecorder into every Task. When an API attempt
 * reaches its terminal finalize boundary (completed / failed / cancelled),
 * the recorder appends a UsageEventV1 to the on-disk NDJSON store under
 * `<globalStorage>/usage-stats/events-*.ndjson`.
 *
 * These tests run a real task against the aimock-backed OpenRouter endpoint,
 * then read the segment files directly to assert that:
 *  - a usage event was captured for the completed API call
 *  - the capture hook recorded provider/model/token fields correctly
 *  - idempotency keys are unique across events (no double-recording)
 */

type UsageEvent = typeof UsageEventV1._output

const USAGE_STATS_DIRNAME = "usage-stats"
const SEGMENT_PREFIX = "events-"
const SEGMENT_EXT = ".ndjson"

const resolveStatsDir = async (): Promise<string> => {
	const repoRoot = path.resolve(__dirname, "..", "..", "..")
	const candidates = [
		process.env.VSCODE_TEST_USER_DATA_DIR &&
			path.join(
				process.env.VSCODE_TEST_USER_DATA_DIR,
				"User",
				"globalStorage",
				"ZooCodeOrganization.zoo-code",
				USAGE_STATS_DIRNAME,
			),
		process.env.VSCODE_TEST_USER_DATA_DIR &&
			path.join(
				process.env.VSCODE_TEST_USER_DATA_DIR,
				"User",
				"globalStorage",
				"zoocodeorganization.zoo-code",
				USAGE_STATS_DIRNAME,
			),
		path.join(
			repoRoot,
			".vscode-test",
			"user-data",
			"User",
			"globalStorage",
			"ZooCodeOrganization.zoo-code",
			USAGE_STATS_DIRNAME,
		),
		path.join(
			repoRoot,
			".vscode-test",
			"user-data",
			"User",
			"globalStorage",
			"zoocodeorganization.zoo-code",
			USAGE_STATS_DIRNAME,
		),
	].filter((c): c is string => !!c)

	for (const candidate of candidates) {
		try {
			await fs.access(candidate)
			return candidate
		} catch {
			// try next candidate
		}
	}

	return candidates[0] || candidates[2]!
}

/**
 * Read every usage event from the store's segment files.
 * Corrupt or unparseable lines are skipped — the store itself quarantines
 * them, so the test should not fail on them.
 */
const readAllUsageEvents = async (statsDir?: string): Promise<UsageEvent[]> => {
	const dir = statsDir ?? (await resolveStatsDir())
	let files: string[]

	try {
		files = await fs.readdir(dir)
	} catch {
		// Store directory does not exist yet — no events recorded.
		return []
	}

	const segmentFiles = files.filter((f) => f.startsWith(SEGMENT_PREFIX) && f.endsWith(SEGMENT_EXT))
	const events: UsageEvent[] = []

	for (const file of segmentFiles) {
		const content = await fs.readFile(path.join(dir, file), "utf-8")

		for (const line of content.split("\n")) {
			const trimmed = line.trim()
			if (!trimmed) continue

			try {
				const parsed = UsageEventV1.safeParse(JSON.parse(trimmed))
				if (parsed.success) {
					events.push(parsed.data)
				}
			} catch {
				// skip corrupt line
			}
		}
	}

	return events
}

suite("Roo Code Usage Capture", function () {
	setDefaultSuiteTimeout(this)

	suiteSetup(async function () {
		const extension = vscode.extensions.getExtension("ZooCodeOrganization.zoo-code")
		assert.ok(extension, "Extension not found")
	})

	test("captures a usage event when an API call completes", async () => {
		const api = globalThis.api

		// Snapshot pre-existing event ids so we only assert on events this
		// test run created (the store persists across test runs).
		const preExistingIds = new Set((await readAllUsageEvents()).map((e) => e.eventId))

		const taskId = await waitUntilCompleted({
			api,
			start: () =>
				api.startNewTask({
					configuration: { mode: "ask", alwaysAllowModeSwitch: true, autoApprovalEnabled: true },
					text: "USAGE_CAPTURE_SMOKE: what is your name?",
				}),
		})

		// finalizeUsageEvent is fire-and-forget from the task's perspective, so
		// poll the store until the event for this task appears.
		let eventsForTask: UsageEvent[] = []

		await waitFor(
			async () => {
				const all = await readAllUsageEvents()
				eventsForTask = all.filter((e) => !preExistingIds.has(e.eventId) && e.taskId === taskId)
				return eventsForTask.length > 0
			},
			{ timeout: 45_000, interval: 250 },
		)

		const completed = eventsForTask.find((e) => e.status === "completed")
		assert.ok(completed, `A completed usage event should be recorded for task ${taskId}`)

		// The capture hook must record provider/model/mode provenance.
		assert.strictEqual(completed.provider, "openrouter", "Provider should match the configured apiProvider")
		assert.ok(completed.model.length > 0, "Model id should be recorded")
		assert.strictEqual(completed.mode, "ask", "Mode should match the task mode")

		// Token usage captured from the aimock usage payload.
		assert.ok(
			(completed.usage.inputTokens?.value ?? 0) > 0,
			"Input tokens should be captured from the API usage payload",
		)
		assert.ok(
			(completed.usage.outputTokens?.value ?? 0) > 0,
			"Output tokens should be captured from the API usage payload",
		)
		assert.strictEqual(completed.usage.inputTokens?.source, "provider")
		assert.strictEqual(completed.usage.outputTokens?.source, "provider")

		// Provenance + schema version invariants.
		assert.strictEqual(completed.schemaVersion, 1)
		assert.strictEqual(completed.provenance, "live")
		assert.ok(completed.idempotencyKey.startsWith(`${taskId}:`), "Idempotency key should embed the taskId")
	})

	test("capture hook fires for each task and never double-records", async () => {
		const api = globalThis.api

		const preExistingIds = new Set((await readAllUsageEvents()).map((e) => e.eventId))

		const taskId = await waitUntilCompleted({
			api,
			start: () =>
				api.startNewTask({
					configuration: { mode: "ask", alwaysAllowModeSwitch: true, autoApprovalEnabled: true },
					text: "USAGE_CAPTURE_HOOK_2: what is your name?",
				}),
		})

		let eventsForTask: UsageEvent[] = []

		await waitFor(
			async () => {
				const all = await readAllUsageEvents()
				eventsForTask = all.filter((e) => !preExistingIds.has(e.eventId) && e.taskId === taskId)
				return eventsForTask.length > 0
			},
			{ timeout: 45_000, interval: 250 },
		)

		// Hook fired for this task too.
		assert.ok(
			eventsForTask.some((e) => e.status === "completed"),
			"Usage capture hook should fire for every completed task",
		)

		// Idempotency: no two events anywhere in the store may share an
		// idempotencyKey — the recorder dedupes on requestKey:status.
		const all = await readAllUsageEvents()
		const keys = all.map((e) => e.idempotencyKey)
		assert.strictEqual(
			new Set(keys).size,
			keys.length,
			"Idempotency keys must be unique (no double-recorded usage events)",
		)
	})
})
