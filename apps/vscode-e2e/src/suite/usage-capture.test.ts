import * as assert from "assert"
import * as fs from "fs/promises"
import * as os from "os"
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

let cachedStatsDirs: string[] | null = null

const getStatsDirs = async (): Promise<string[]> => {
	if (cachedStatsDirs && cachedStatsDirs.length > 0) {
		return cachedStatsDirs
	}

	const repoRoot = path.resolve(__dirname, "..", "..", "..")
	const candidateBases = [
		process.env.VSCODE_TEST_USER_DATA_DIR,
		path.join(repoRoot, ".vscode-test"),
		path.join(repoRoot, ".vscode-test", "user-data"),
		os.tmpdir(),
	].filter((c): c is string => !!c)

	const statsDirs = new Set<string>()

	// Direct candidate check first (fast path)
	for (const base of candidateBases) {
		const candidates = [
			path.join(base, "User", "globalStorage", "ZooCodeOrganization.zoo-code", USAGE_STATS_DIRNAME),
			path.join(base, "User", "globalStorage", "zoocodeorganization.zoo-code", USAGE_STATS_DIRNAME),
			path.join(base, "user-data", "User", "globalStorage", "ZooCodeOrganization.zoo-code", USAGE_STATS_DIRNAME),
			path.join(base, "user-data", "User", "globalStorage", "zoocodeorganization.zoo-code", USAGE_STATS_DIRNAME),
		]
		for (const candidate of candidates) {
			try {
				await fs.access(candidate)
				statsDirs.add(candidate)
			} catch {
				// doesn't exist
			}
		}
	}

	if (statsDirs.size > 0) {
		cachedStatsDirs = Array.from(statsDirs)
		return cachedStatsDirs
	}

	// Shallow search fallback if direct paths were not found
	const searchDir = async (dir: string, depth = 0) => {
		if (depth > 4) return
		try {
			const entries = await fs.readdir(dir, { withFileTypes: true })
			for (const entry of entries) {
				if (entry.isDirectory()) {
					const fullPath = path.join(dir, entry.name)
					if (entry.name === USAGE_STATS_DIRNAME) {
						statsDirs.add(fullPath)
					} else if (
						depth === 0 ||
						entry.name.includes("vscode") ||
						entry.name.includes("globalStorage") ||
						entry.name.includes("User") ||
						entry.name.includes("zoo")
					) {
						await searchDir(fullPath, depth + 1)
					}
				}
			}
		} catch {
			// ignore unreadable/permission errors
		}
	}

	for (const base of candidateBases) {
		await searchDir(base)
	}

	cachedStatsDirs = Array.from(statsDirs)
	return cachedStatsDirs
}

/**
 * Read every usage event from the store's segment files across all stats dirs.
 * Corrupt or unparseable lines are skipped — the store itself quarantines
 * them, so the test should not fail on them.
 */
const readAllUsageEvents = async (): Promise<UsageEvent[]> => {
	const dirs = await getStatsDirs()
	const events: UsageEvent[] = []
	const seenIds = new Set<string>()

	for (const dir of dirs) {
		let files: string[]
		try {
			files = await fs.readdir(dir)
		} catch {
			continue
		}

		const segmentFiles = files.filter((f) => f.startsWith(SEGMENT_PREFIX) && f.endsWith(SEGMENT_EXT))

		for (const file of segmentFiles) {
			let content: string
			try {
				content = await fs.readFile(path.join(dir, file), "utf-8")
			} catch {
				continue
			}

			for (const line of content.split("\n")) {
				const trimmed = line.trim()
				if (!trimmed) continue

				try {
					const parsed = UsageEventV1.safeParse(JSON.parse(trimmed))
					if (parsed.success && !seenIds.has(parsed.data.eventId)) {
						seenIds.add(parsed.data.eventId)
						events.push(parsed.data)
					}
				} catch {
					// skip corrupt line
				}
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

		const aimockUrl = process.env.AIMOCK_URL
		const isRecord = process.env.AIMOCK_RECORD === "true"

		await globalThis.api.setConfiguration({
			apiProvider: "openrouter" as const,
			openRouterApiKey: aimockUrl && !isRecord ? "mock-key" : process.env.OPENROUTER_API_KEY!,
			openRouterModelId: "openai/gpt-4.1",
			...(aimockUrl && { openRouterBaseUrl: `${aimockUrl}/v1` }),
		})
	})

	setup(async () => {
		cachedStatsDirs = null
		try {
			await globalThis.api.cancelCurrentTask()
		} catch {
			// task may not be running
		}
	})

	teardown(async () => {
		try {
			await globalThis.api.cancelCurrentTask()
		} catch {
			// task may not be running
		}
	})

	suiteTeardown(async () => {
		try {
			await globalThis.api.cancelCurrentTask()
		} catch {
			// task may not be running
		}
		const aimockUrl = process.env.AIMOCK_URL
		const isRecord = process.env.AIMOCK_RECORD === "true"
		await globalThis.api.setConfiguration({
			apiProvider: "openrouter" as const,
			openRouterApiKey: aimockUrl && !isRecord ? "mock-key" : process.env.OPENROUTER_API_KEY!,
			openRouterModelId: "openai/gpt-4.1",
			...(aimockUrl && { openRouterBaseUrl: `${aimockUrl}/v1` }),
		})
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
			{ timeout: 60_000, interval: 250 },
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
			{ timeout: 60_000, interval: 250 },
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
